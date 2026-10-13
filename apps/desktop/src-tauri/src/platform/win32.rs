//! Win32 implementation of [`SystemProbe`](super::SystemProbe).
//!
//! APIs: `GetForegroundWindow`, `GetWindowThreadProcessId`, `EnumChildWindows` (UWP host
//! resolution), `OpenProcess` (`PROCESS_QUERY_LIMITED_INFORMATION` only), `GetProcessTimes`,
//! `QueryFullProcessImageNameW`, `GetLastInputInfo`, `WTSQuerySessionInformationW(WTSSessionInfoEx)`,
//! `SystemParametersInfoW(SPI_GETSCREENSAVERRUNNING)`, and for the running-application picker
//! `EnumWindows`, `IsWindowVisible`, `GetWindow(GW_OWNER)`, `GetWindowLongW(GWL_EXSTYLE)` and
//! `DwmGetWindowAttribute(DWMWA_CLOAKED)`.
//!
//! Privacy: nothing here reads window titles, class names, window contents, keystrokes or the
//! clipboard. A window handle is only ever used to find the process that owns it.
//!
//! Every `unsafe` block is a single FFI call (or a read of memory the OS just handed us) and
//! carries a `SAFETY:` note. No Rust panic can unwind across the enumeration callbacks: they only
//! dereference the pointer we passed in and push to a `Vec`.

use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::mem::size_of;

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, FALSE, FILETIME, HANDLE, HWND, LPARAM, TRUE,
};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::RemoteDesktop::{
    WTSActive, WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW,
    WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTS_SESSIONSTATE_LOCK, WTS_SESSIONSTATE_UNLOCK,
};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GetForegroundWindow, GetWindow, GetWindowLongW,
    GetWindowThreadProcessId, IsWindowVisible, SystemParametersInfoW, GWL_EXSTYLE, GW_OWNER,
    SPI_GETSCREENSAVERRUNNING, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WS_EX_TOOLWINDOW,
};

use super::{exe_name_from_path, ProcessInfo, SystemProbe};
use crate::tracker::SessionState;

/// Image name of the UWP frame host. Its windows belong to the hosted app's process.
const FRAME_HOST_EXE: &str = "ApplicationFrameHost.exe";
/// Image name of the Windows lock screen app.
const LOCK_APP_EXE: &str = "LockApp.exe";
/// Initial image-path buffer, in UTF-16 units. Most paths fit; longer ones grow the buffer.
const INITIAL_PATH_CAPACITY: usize = 512;
/// Upper bound for the image-path buffer: the longest path an NT `UNICODE_STRING` can hold.
const MAX_PATH_CAPACITY: usize = 32_768;

/// Win32 [`SystemProbe`]. Keeps a small cache so that, while the same window of the same process
/// stays in the foreground, each poll costs one `OpenProcess` + `GetProcessTimes` instead of a
/// full image-path query.
#[derive(Debug, Default)]
pub struct Win32Probe {
    /// The process owning the foreground window, as last resolved.
    foreground: Option<CachedProcess>,
    /// The app process hosted by an `ApplicationFrameHost.exe` foreground window, as last resolved.
    hosted: Option<CachedProcess>,
    /// The last (window, pid) that could not be queried. Focusing an elevated or protected window
    /// fails every second; this keeps the debug log to one line per occurrence.
    last_failure: Option<(isize, u32)>,
}

/// Cache entry: valid while the window handle, the pid and the process creation time all match.
/// The creation time guards against pid reuse after a process exits.
#[derive(Debug, Clone)]
struct CachedProcess {
    hwnd: isize,
    pid: u32,
    created: u64,
    info: ProcessInfo,
}

impl Win32Probe {
    /// A probe with an empty cache.
    pub fn new() -> Self {
        Self::default()
    }

    /// The foreground window's process, with `ApplicationFrameHost.exe` resolved to the hosted
    /// UWP app.
    fn query_foreground(&mut self) -> Option<ProcessInfo> {
        // SAFETY: no arguments; returns a possibly-null window handle.
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_invalid() {
            return None;
        }
        let pid = window_pid(hwnd)?;
        let top = Self::resolve(&mut self.foreground, &mut self.last_failure, hwnd, pid)?;
        if !is_frame_host(&top) {
            self.hosted = None;
            return Some(top);
        }
        // A UWP app: the frame window belongs to ApplicationFrameHost.exe and the app's own
        // process owns a child window. If the app has no child yet (starting or suspended),
        // report the frame host itself, which matches no registry application by default.
        match hosted_process_id(hwnd, pid) {
            Some(hosted_pid) => {
                Self::resolve(&mut self.hosted, &mut self.last_failure, hwnd, hosted_pid)
            }
            None => Some(top),
        }
    }

    /// Resolve `pid` (owner of `hwnd`) through `slot`, re-querying the image path only when the
    /// window, the pid or the process creation time changed.
    fn resolve(
        slot: &mut Option<CachedProcess>,
        last_failure: &mut Option<(isize, u32)>,
        hwnd: HWND,
        pid: u32,
    ) -> Option<ProcessInfo> {
        let key = hwnd_key(hwnd);
        match query_cached(slot, key, pid) {
            Ok(info) => Some(info),
            Err(err) => {
                *slot = None;
                if *last_failure != Some((key, pid)) {
                    // Expected whenever an elevated or protected window has focus, or the
                    // process exits between the two calls. Not an error.
                    log::debug!("foreground process {pid} cannot be queried: {err}");
                    *last_failure = Some((key, pid));
                }
                None
            }
        }
    }
}

/// Image info for `pid`, served from `slot` when the window, the pid and the process creation
/// time all match the cached entry; otherwise queried and cached.
fn query_cached(
    slot: &mut Option<CachedProcess>,
    hwnd: isize,
    pid: u32,
) -> windows::core::Result<ProcessInfo> {
    let process = ProcessHandle::open(pid)?;
    let created = process.creation_time();
    if let (Some(cached), Some(created)) = (slot.as_ref(), created) {
        if cached.hwnd == hwnd && cached.pid == pid && cached.created == created {
            return Ok(cached.info.clone());
        }
    }
    let info = process_info_from_path(pid, process.image_path()?);
    *slot = created.map(|created| CachedProcess {
        hwnd,
        pid,
        created,
        info: info.clone(),
    });
    Ok(info)
}

impl SystemProbe for Win32Probe {
    fn foreground_process(&mut self) -> Option<ProcessInfo> {
        let process = self.query_foreground();
        if process.is_some() {
            self.last_failure = None;
        }
        process
    }

    fn idle_ms(&mut self) -> Option<u64> {
        let mut info = LASTINPUTINFO {
            cbSize: size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        // SAFETY: `info` is a valid LASTINPUTINFO with cbSize set, as the API requires.
        if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
            log::debug!("GetLastInputInfo failed");
            return None;
        }
        // SAFETY: no arguments.
        let now = unsafe { GetTickCount() };
        Some(ticks_since(now, info.dwTime))
    }

    fn session_state(&mut self) -> SessionState {
        let wts = wts_session();
        let screen_saver = screen_saver_running();
        let state = classify_session(wts, screen_saver, false);
        if state.is_away() {
            return state;
        }
        // Fallback: the lock screen app in the foreground means the workstation is locked even
        // if the session flags have not caught up yet.
        let lock_app = self
            .foreground_process()
            .is_some_and(|process| process.exe_name.eq_ignore_ascii_case(LOCK_APP_EXE));
        classify_session(wts, screen_saver, lock_app)
    }
}

/// Processes owning a visible, unowned, non-tool, non-cloaked top-level window, excluding this
/// process, de-duplicated by image path (case-insensitive) and sorted by exe name.
pub fn running_applications() -> Vec<ProcessInfo> {
    let own_pid = std::process::id();
    let mut by_pid: HashMap<u32, Option<ProcessInfo>> = HashMap::new();
    let mut lookup = |pid: u32| {
        by_pid
            .entry(pid)
            .or_insert_with(|| process_info(pid))
            .clone()
    };

    let mut seen_paths = HashSet::new();
    let mut apps = Vec::new();
    for hwnd in top_level_windows() {
        if !is_app_window(hwnd) {
            continue;
        }
        let Some(pid) = window_pid(hwnd) else {
            continue;
        };
        if pid == own_pid {
            continue;
        }
        let Some(mut info) = lookup(pid) else {
            continue;
        };
        if is_frame_host(&info) {
            // Resolve per window: one frame host process hosts every UWP app. A frame without a
            // hosted child (suspended app) is not a useful pick, so it is skipped.
            let Some(hosted) = hosted_process_id(hwnd, pid).filter(|&hosted| hosted != own_pid)
            else {
                continue;
            };
            let Some(hosted_info) = lookup(hosted) else {
                continue;
            };
            info = hosted_info;
        }
        if seen_paths.insert(info.exe_path.to_lowercase()) {
            apps.push(info);
        }
    }
    apps.sort_by_cached_key(|app| (app.exe_name.to_lowercase(), app.exe_path.to_lowercase()));
    apps
}

/// Image name and path of `pid`, uncached. `None` when the process has exited, is protected, or
/// runs elevated while we do not (logged at debug level).
pub fn process_info(pid: u32) -> Option<ProcessInfo> {
    let result = ProcessHandle::open(pid).and_then(|process| process.image_path());
    match result {
        Ok(path) => Some(process_info_from_path(pid, path)),
        Err(err) => {
            log::debug!("process {pid} cannot be queried: {err}");
            None
        }
    }
}

// ---- process queries --------------------------------------------------------------------------

/// An open process handle, closed on drop so no early return can leak it.
struct ProcessHandle(HANDLE);

impl ProcessHandle {
    /// Open with `PROCESS_QUERY_LIMITED_INFORMATION`, the least privilege that allows reading the
    /// image path and the process times. Works for other users' non-protected processes too.
    fn open(pid: u32) -> windows::core::Result<Self> {
        if pid == 0 {
            // The System Idle Process: never a user application.
            return Err(windows::core::Error::from_hresult(
                windows::Win32::Foundation::E_INVALIDARG,
            ));
        }
        // SAFETY: plain FFI call; the returned handle is owned by the guard and closed on drop.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }?;
        Ok(Self(handle))
    }

    /// Process creation time as a FILETIME tick count, or `None` if it can't be read.
    fn creation_time(&self) -> Option<u64> {
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        // SAFETY: `self.0` is a live process handle; the four out-pointers are valid locals.
        unsafe { GetProcessTimes(self.0, &mut created, &mut exited, &mut kernel, &mut user) }
            .ok()?;
        Some((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    /// Full Win32 image path. The buffer grows until the path fits (long-path aware).
    fn image_path(&self) -> windows::core::Result<String> {
        let mut capacity = INITIAL_PATH_CAPACITY;
        loop {
            let mut buffer = vec![0u16; capacity];
            let mut len = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
            // SAFETY: `buffer` holds `len` writable u16s; `len` is updated to the number of
            // characters written (excluding the terminator) on success.
            let result = unsafe {
                QueryFullProcessImageNameW(
                    self.0,
                    PROCESS_NAME_WIN32,
                    PWSTR(buffer.as_mut_ptr()),
                    &mut len,
                )
            };
            match result {
                Ok(()) => {
                    let len = usize::try_from(len).unwrap_or(0).min(buffer.len());
                    return Ok(String::from_utf16_lossy(&buffer[..len]));
                }
                Err(err)
                    if err.code() == ERROR_INSUFFICIENT_BUFFER.to_hresult()
                        && capacity < MAX_PATH_CAPACITY =>
                {
                    capacity = (capacity * 2).min(MAX_PATH_CAPACITY);
                }
                Err(err) => return Err(err),
            }
        }
    }
}

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        // SAFETY: the handle came from a successful OpenProcess and is closed exactly once here.
        if let Err(err) = unsafe { CloseHandle(self.0) } {
            log::debug!("CloseHandle failed: {err}");
        }
    }
}

fn process_info_from_path(pid: u32, exe_path: String) -> ProcessInfo {
    ProcessInfo {
        pid,
        exe_name: exe_name_from_path(&exe_path).to_string(),
        exe_path,
    }
}

fn is_frame_host(process: &ProcessInfo) -> bool {
    process.exe_name.eq_ignore_ascii_case(FRAME_HOST_EXE)
}

// ---- windows ----------------------------------------------------------------------------------

/// A window handle as a plain integer, for cache keys (`HWND` itself is not `Send`).
fn hwnd_key(hwnd: HWND) -> isize {
    hwnd.0 as isize
}

/// The pid owning `hwnd`, or `None` if the window is gone.
fn window_pid(hwnd: HWND) -> Option<u32> {
    let mut pid = 0u32;
    // SAFETY: `pid` is a valid out-pointer; an invalid window simply yields thread id 0.
    let thread = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    (thread != 0 && pid != 0).then_some(pid)
}

/// State for [`find_hosted_child`]: the frame host pid in, the first foreign pid out.
struct HostedSearch {
    frame_pid: u32,
    hosted_pid: Option<u32>,
}

/// The pid of the first child window of `frame` that belongs to another process: the UWP app
/// hosted by an `ApplicationFrameHost.exe` frame.
fn hosted_process_id(frame: HWND, frame_pid: u32) -> Option<u32> {
    let mut search = HostedSearch {
        frame_pid,
        hosted_pid: None,
    };
    // SAFETY: the callback only runs during this call, while `search` is alive and exclusively
    // borrowed through the LPARAM. The return value carries no information and is ignored.
    let _ = unsafe {
        EnumChildWindows(
            Some(frame),
            Some(find_hosted_child),
            LPARAM(&mut search as *mut HostedSearch as isize),
        )
    };
    search.hosted_pid
}

unsafe extern "system" fn find_hosted_child(child: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: `lparam` is the `&mut HostedSearch` passed by `hosted_process_id`, valid for the
    // duration of the enumeration and not aliased elsewhere.
    let search = unsafe { &mut *(lparam.0 as *mut HostedSearch) };
    match window_pid(child) {
        Some(pid) if pid != search.frame_pid => {
            search.hosted_pid = Some(pid);
            FALSE // stop enumerating
        }
        _ => TRUE,
    }
}

/// Every top-level window, in z-order.
fn top_level_windows() -> Vec<HWND> {
    let mut windows: Vec<HWND> = Vec::new();
    // SAFETY: the callback only runs during this call, while `windows` is alive and exclusively
    // borrowed through the LPARAM.
    let result = unsafe {
        EnumWindows(
            Some(collect_window),
            LPARAM(&mut windows as *mut Vec<HWND> as isize),
        )
    };
    if let Err(err) = result {
        log::debug!("EnumWindows failed: {err}");
    }
    windows
}

unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: `lparam` is the `&mut Vec<HWND>` passed by `top_level_windows`, valid for the
    // duration of the enumeration and not aliased elsewhere.
    let windows = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
    windows.push(hwnd);
    TRUE
}

/// A window the user would recognise as an application: visible, not owned by another window,
/// not a tool window, and not cloaked by DWM (hidden UWP frames, other virtual desktops).
fn is_app_window(hwnd: HWND) -> bool {
    // SAFETY: plain query on a window handle; a stale handle yields FALSE.
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return false;
    }
    // SAFETY: plain query; an unowned window returns an error / null handle.
    let owned = unsafe { GetWindow(hwnd, GW_OWNER) }.is_ok_and(|owner| !owner.is_invalid());
    if owned {
        return false;
    }
    // SAFETY: plain query of the extended style bits.
    let ex_style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
    if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
        return false;
    }
    !is_cloaked(hwnd)
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    // SAFETY: `cloaked` is a valid u32 out-buffer of the size passed, as DWMWA_CLOAKED requires.
    let result = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            size_of::<u32>() as u32,
        )
    };
    result.is_ok() && cloaked != 0
}

// ---- idle and session -------------------------------------------------------------------------

/// Milliseconds between two 32-bit tick counts. `wrapping_sub` keeps this right across the
/// 49.7-day `GetTickCount` rollover.
fn ticks_since(now: u32, then: u32) -> u64 {
    u64::from(now.wrapping_sub(then))
}

/// The parts of `WTSINFOEX_LEVEL1_W` the tracker uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WtsSession {
    /// `Some(true)` locked, `Some(false)` unlocked, `None` when Windows reports "unknown".
    locked: Option<bool>,
    /// `SessionState == WTSActive`. False when fast-user-switched away or RDP-disconnected.
    active: bool,
}

/// Frees a buffer returned by `WTSQuerySessionInformationW`.
struct WtsMemory(*mut c_void);

impl Drop for WtsMemory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the pointer came from WTSQuerySessionInformationW and is freed exactly once.
            unsafe { WTSFreeMemory(self.0) };
        }
    }
}

/// Lock and connection state of the current session, or `None` if the query failed.
///
/// Note: on Windows 7 / Server 2008 R2 the lock flags are documented as inverted. Studio Pulse
/// supports Windows 10 and 11 only, where they are correct.
fn wts_session() -> Option<WtsSession> {
    let mut buffer = PWSTR::null();
    let mut bytes = 0u32;
    // SAFETY: both out-pointers are valid locals. On success the buffer is owned by `WtsMemory`.
    let result = unsafe {
        WTSQuerySessionInformationW(
            Some(WTS_CURRENT_SERVER_HANDLE),
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buffer,
            &mut bytes,
        )
    };
    if let Err(err) = result {
        log::debug!("WTSQuerySessionInformationW failed: {err}");
        return None;
    }
    let memory = WtsMemory(buffer.0.cast());
    let size = usize::try_from(bytes).unwrap_or(0);
    if memory.0.is_null() || size < size_of::<WTSINFOEXW>() {
        return None;
    }
    // SAFETY: the buffer is non-null, at least `size_of::<WTSINFOEXW>()` bytes long and alive
    // until `memory` drops. `read_unaligned` makes no alignment assumption.
    let info = unsafe { std::ptr::read_unaligned(memory.0.cast::<WTSINFOEXW>()) };
    if info.Level != 1 {
        return None;
    }
    // SAFETY: Level 1 means the union holds `WTSInfoExLevel1`, its only variant.
    let level1 = unsafe { info.Data.WTSInfoExLevel1 };
    drop(memory);

    let locked = match level1.SessionFlags as u32 {
        WTS_SESSIONSTATE_LOCK => Some(true),
        WTS_SESSIONSTATE_UNLOCK => Some(false),
        _ => None,
    };
    Some(WtsSession {
        locked,
        active: level1.SessionState == WTSActive,
    })
}

/// Whether a screen saver is running on this window station, or `None` if the query failed.
fn screen_saver_running() -> Option<bool> {
    let mut running = BOOL(0);
    // SAFETY: SPI_GETSCREENSAVERRUNNING writes one BOOL to the pointer we pass.
    let result = unsafe {
        SystemParametersInfoW(
            SPI_GETSCREENSAVERRUNNING,
            0,
            Some(&mut running as *mut BOOL as *mut c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    match result {
        Ok(()) => Some(running.as_bool()),
        Err(err) => {
            log::debug!("SPI_GETSCREENSAVERRUNNING failed: {err}");
            None
        }
    }
}

/// Combine the session observations. Any positive "away" signal wins; otherwise a failed or
/// inconclusive query yields `Unknown` (the engine treats it as active).
fn classify_session(
    wts: Option<WtsSession>,
    screen_saver: Option<bool>,
    lock_app_foreground: bool,
) -> SessionState {
    if let Some(session) = wts {
        if session.locked == Some(true) {
            return SessionState::Locked;
        }
        if !session.active {
            return SessionState::Disconnected;
        }
    }
    if screen_saver == Some(true) {
        return SessionState::ScreenSaver;
    }
    if lock_app_foreground {
        return SessionState::Locked;
    }
    match (wts, screen_saver) {
        (
            Some(WtsSession {
                locked: Some(false),
                active: true,
            }),
            Some(false),
        ) => SessionState::Active,
        _ => SessionState::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UNLOCKED: WtsSession = WtsSession {
        locked: Some(false),
        active: true,
    };

    #[test]
    fn idle_ticks_survive_the_49_day_rollover() {
        assert_eq!(ticks_since(10_000, 4_000), 6_000);
        assert_eq!(ticks_since(5, u32::MAX - 4), 10);
        assert_eq!(ticks_since(7, 7), 0);
    }

    #[test]
    fn session_classification() {
        assert_eq!(
            classify_session(Some(UNLOCKED), Some(false), false),
            SessionState::Active
        );
        let locked = WtsSession {
            locked: Some(true),
            active: true,
        };
        assert_eq!(
            classify_session(Some(locked), Some(false), false),
            SessionState::Locked
        );
        let switched_away = WtsSession {
            locked: Some(false),
            active: false,
        };
        assert_eq!(
            classify_session(Some(switched_away), Some(false), false),
            SessionState::Disconnected
        );
        assert_eq!(
            classify_session(Some(UNLOCKED), Some(true), false),
            SessionState::ScreenSaver
        );
        assert_eq!(
            classify_session(Some(UNLOCKED), Some(false), true),
            SessionState::Locked
        );
        assert_eq!(
            classify_session(None, Some(false), true),
            SessionState::Locked
        );
        assert_eq!(
            classify_session(None, Some(true), false),
            SessionState::ScreenSaver
        );
        assert_eq!(classify_session(None, None, false), SessionState::Unknown);
        assert_eq!(
            classify_session(Some(UNLOCKED), None, false),
            SessionState::Unknown
        );
        let lock_unknown = WtsSession {
            locked: None,
            active: true,
        };
        assert_eq!(
            classify_session(Some(lock_unknown), Some(false), false),
            SessionState::Unknown
        );
    }

    #[test]
    fn process_info_rejects_pid_zero() {
        assert!(process_info(0).is_none());
    }

    #[test]
    fn process_info_resolves_this_process() {
        let info = process_info(std::process::id()).expect("own process is queryable");
        let exe = std::env::current_exe().expect("current exe");
        let expected = exe.file_name().and_then(|name| name.to_str()).unwrap_or("");
        assert!(info.exe_name.eq_ignore_ascii_case(expected), "{info:?}");
        assert!(info
            .exe_path
            .to_lowercase()
            .ends_with(&expected.to_lowercase()));
    }

    #[test]
    fn idle_and_session_queries_do_not_panic() {
        let mut probe = Win32Probe::new();
        let _ = probe.idle_ms();
        let _ = probe.session_state();
        let _ = probe.foreground_process();
        let _ = probe.foreground_process();
    }
}
