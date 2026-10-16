//! Win32 implementation of [`SystemProbe`](super::SystemProbe).
//!
//! APIs: `GetForegroundWindow`, `GetWindowThreadProcessId`, `EnumChildWindows` (UWP host
//! resolution), `OpenProcess` (`PROCESS_QUERY_LIMITED_INFORMATION` only), `GetProcessTimes`,
//! `QueryFullProcessImageNameW`, `GetLastInputInfo`, `WTSQuerySessionInformationW(WTSSessionInfoEx)`,
//! `SystemParametersInfoW(SPI_GETSCREENSAVERRUNNING)`; for hung-window ghosts
//! `HungWindowFromGhostWindow` (exported by name from user32.dll but absent from the SDK headers,
//! so resolved once with `GetModuleHandleW` + `GetProcAddress`), `IsWindow`, `IsHungAppWindow`,
//! and `CreateToolhelp32Snapshot` + `Process32FirstW`/`Process32NextW` (the image name of a
//! foreground process that `OpenProcess` refuses, such as dwm.exe); and for the
//! running-application picker `EnumWindows`, `IsWindowVisible`, `GetWindow(GW_OWNER)`,
//! `GetWindowLongW(GWL_EXSTYLE)` and `DwmGetWindowAttribute(DWMWA_CLOAKED)`.
//!
//! Hung windows: when an app stops pumping messages for about five seconds (a large save, a heavy
//! render, a bake), Windows hides its top-level window and shows a "ghost" window owned by dwm.exe
//! in its place, and the ghost becomes the foreground window. The probe maps the ghost back to the
//! hung window, so a freeze reads as more time in the app rather than a switch away from it.
//!
//! Privacy: nothing here reads window titles, class names, window contents, keystrokes or the
//! clipboard. A window handle is only ever used to find the process that owns it, or (for a
//! ghost) the window it stands in for.
//!
//! Every `unsafe` block is a single FFI call (or a read of memory the OS just handed us) and
//! carries a `SAFETY:` note. No Rust panic can unwind across the enumeration callbacks: they only
//! dereference the pointer we passed in and push to a `Vec`.

use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::mem::size_of;

use windows::core::{s, w, BOOL, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, FALSE, FILETIME, HANDLE, HWND, LPARAM, TRUE,
};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
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
    GetWindowThreadProcessId, IsHungAppWindow, IsWindow, IsWindowVisible, SystemParametersInfoW,
    GWL_EXSTYLE, GW_OWNER, SPI_GETSCREENSAVERRUNNING, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    WS_EX_TOOLWINDOW,
};

use super::{exe_name_from_path, ProcessInfo, SystemProbe};
use crate::tracker::SessionState;

/// Image name of the UWP frame host. Its windows belong to the hosted app's process.
const FRAME_HOST_EXE: &str = "ApplicationFrameHost.exe";
/// Image name of the Desktop Window Manager, which owns the ghost of a hung window.
const GHOST_HOST_EXE: &str = "dwm.exe";
/// Image name of the Windows lock screen app.
const LOCK_APP_EXE: &str = "LockApp.exe";
/// Initial image-path buffer, in UTF-16 units. Most paths fit; longer ones grow the buffer.
const INITIAL_PATH_CAPACITY: usize = 512;
/// Upper bound for the image-path buffer: the longest path an NT `UNICODE_STRING` can hold.
const MAX_PATH_CAPACITY: usize = 32_768;

/// `user32!HungWindowFromGhostWindow`: the hung window a ghost window stands in for, or null when
/// the argument is not a ghost.
type HungWindowFromGhostWindowFn = unsafe extern "system" fn(HWND) -> HWND;

/// Win32 [`SystemProbe`]. Keeps a small cache so that, while the same window of the same process
/// stays in the foreground, each poll costs one `OpenProcess` + `GetProcessTimes` instead of a
/// full image-path query.
#[derive(Debug)]
pub struct Win32Probe {
    /// The process owning the foreground window, as last resolved. Never dwm.exe: while a ghost
    /// is in the foreground this keeps the hung app's entry.
    foreground: Option<CachedProcess>,
    /// The app process hosted by an `ApplicationFrameHost.exe` foreground window, as last resolved.
    hosted: Option<CachedProcess>,
    /// The last (window, pid) that could not be queried. Focusing an elevated or protected window
    /// fails every second; this keeps the debug log to one line per occurrence.
    last_failure: Option<(isize, u32)>,
    /// The foreground (window, pid) last identified as a dwm.exe ghost. While it stays in the
    /// foreground its owner is not looked up again.
    ghost: Option<(isize, u32)>,
    /// `HungWindowFromGhostWindow`, resolved once; `None` if this Windows build lacks the export.
    hung_window_from_ghost: Option<HungWindowFromGhostWindowFn>,
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

impl Default for Win32Probe {
    fn default() -> Self {
        Self::new()
    }
}

impl Win32Probe {
    /// A probe with an empty cache.
    pub fn new() -> Self {
        Self {
            foreground: None,
            hosted: None,
            last_failure: None,
            ghost: None,
            hung_window_from_ghost: load_hung_window_from_ghost(),
        }
    }

    /// The foreground window's process, with `ApplicationFrameHost.exe` resolved to the hosted
    /// UWP app and a dwm.exe ghost resolved to the hung window it replaces.
    fn query_foreground(&mut self) -> Option<ProcessInfo> {
        // SAFETY: no arguments; returns a possibly-null window handle.
        let hwnd = unsafe { GetForegroundWindow() };
        self.query_top_level(hwnd)
    }

    /// [`query_foreground`](Self::query_foreground) for the top-level window `hwnd`.
    fn query_top_level(&mut self, hwnd: HWND) -> Option<ProcessInfo> {
        if hwnd.is_invalid() {
            return None;
        }
        let pid = window_pid(hwnd)?;
        let key = hwnd_key(hwnd);
        if self.ghost == Some((key, pid)) {
            return self.query_ghost(hwnd);
        }
        // Another window's entry is set aside instead of evicted: if this window is a ghost, that
        // entry belongs to the hung app and goes back into the slot.
        let previous = self
            .foreground
            .take_if(|cached| cached.hwnd != key || cached.pid != pid);
        let failed_before = self.last_failure == Some((key, pid));
        let top = Self::resolve(&mut self.foreground, &mut self.last_failure, hwnd, pid);
        let ghost_host = match &top {
            Some(top) => is_ghost_host(&top.exe_name),
            // Without elevation dwm.exe cannot be opened, so read its name from a process
            // snapshot instead: once per window, not on every poll of an elevated window.
            None => !failed_before && snapshot_exe_name(pid).is_some_and(|n| is_ghost_host(&n)),
        };
        if ghost_host {
            self.foreground = previous;
            self.ghost = Some((key, pid));
            log::debug!("foreground window is a dwm.exe ghost; looking for the hung window");
            return self.query_ghost(hwnd);
        }
        self.ghost = None;
        match top {
            Some(top) => self.resolve_frame_host(hwnd, pid, top),
            None => {
                // Nothing new to cache: keep the previous entry for when its window returns.
                if self.foreground.is_none() {
                    self.foreground = previous;
                }
                None
            }
        }
    }

    /// The app behind the top-level window `hwnd` owned by `pid`: the normal, non-ghost path.
    fn query_window(&mut self, hwnd: HWND, pid: u32) -> Option<ProcessInfo> {
        let top = Self::resolve(&mut self.foreground, &mut self.last_failure, hwnd, pid)?;
        self.resolve_frame_host(hwnd, pid, top)
    }

    /// `top` (the owner of `hwnd`), unless it is `ApplicationFrameHost.exe`: then the UWP app it
    /// hosts.
    fn resolve_frame_host(
        &mut self,
        hwnd: HWND,
        pid: u32,
        top: ProcessInfo,
    ) -> Option<ProcessInfo> {
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

    /// The app behind the dwm.exe ghost window `ghost`, served from the cache entries of the hung
    /// window it replaces. `None` when the hung window cannot be found.
    fn query_ghost(&mut self, ghost: HWND) -> Option<ProcessInfo> {
        let mapped = self
            .hung_window_from_ghost
            .and_then(|hung_window_from_ghost| {
                // SAFETY: the pointer is user32's `HungWindowFromGhostWindow` (see
                // `load_hung_window_from_ghost`), which only looks the handle up and returns null
                // for anything that is not a live ghost window.
                let hung = unsafe { hung_window_from_ghost(ghost) };
                (!hung.is_invalid()).then(|| hwnd_key(hung))
            });
        let cached = self.foreground.as_ref().map(|cached| cached.hwnd);
        let target = ghost_target(hwnd_key(ghost), mapped, cached, |window| {
            is_hung_window(hwnd_from_key(window))
        })?;
        let hwnd = hwnd_from_key(target);
        let pid = window_pid(hwnd)?;
        self.query_window(hwnd, pid)
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
                    // Expected whenever an elevated or protected window has focus, a ghost window
                    // (dwm.exe) does while we run unelevated, or the process exits between the
                    // two calls. Not an error.
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

/// A Toolhelp snapshot handle, closed on drop.
struct Snapshot(HANDLE);

impl Drop for Snapshot {
    fn drop(&mut self) {
        // SAFETY: the handle came from a successful CreateToolhelp32Snapshot and is closed
        // exactly once here.
        if let Err(err) = unsafe { CloseHandle(self.0) } {
            log::debug!("CloseHandle failed: {err}");
        }
    }
}

/// The image file name of `pid` (e.g. `dwm.exe`) from a process snapshot, which needs no access
/// to the process itself. For processes `OpenProcess` refuses; costs one snapshot of the process
/// list, so callers use it once per window, not once per poll.
fn snapshot_exe_name(pid: u32) -> Option<String> {
    // SAFETY: plain FFI call; the returned handle is owned by `Snapshot` and closed on drop.
    let snapshot = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
        Ok(handle) => Snapshot(handle),
        Err(err) => {
            log::debug!("CreateToolhelp32Snapshot failed: {err}");
            return None;
        }
    };
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: `snapshot.0` is a live process snapshot; `entry` is a valid PROCESSENTRY32W with
    // `dwSize` set, as the API requires.
    let mut found = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    while found.is_ok() {
        if entry.th32ProcessID == pid {
            let name = &entry.szExeFile;
            let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
            return Some(String::from_utf16_lossy(&name[..len]));
        }
        // SAFETY: as for Process32FirstW.
        found = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    None
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

/// Whether `exe_name` is the process that owns ghost windows (dwm.exe), case-insensitively.
fn is_ghost_host(exe_name: &str) -> bool {
    exe_name.eq_ignore_ascii_case(GHOST_HOST_EXE)
}

// ---- hung windows -----------------------------------------------------------------------------

/// Resolve `user32!HungWindowFromGhostWindow`. It has been exported by name since Windows Vista
/// but is in neither the SDK headers nor the `windows` crate. `None` if it cannot be found.
fn load_hung_window_from_ghost() -> Option<HungWindowFromGhostWindowFn> {
    // SAFETY: plain FFI call. user32.dll is already loaded (this binary imports it, e.g. for
    // GetForegroundWindow), so the handle is valid and stays valid for the life of the process;
    // GetModuleHandleW takes no reference that would need releasing.
    let user32 = match unsafe { GetModuleHandleW(w!("user32.dll")) } {
        Ok(module) => module,
        Err(err) => {
            log::debug!("user32.dll handle unavailable: {err}");
            return None;
        }
    };
    // SAFETY: `user32` is a valid module handle and the name is a NUL-terminated ANSI literal.
    let Some(export) = (unsafe { GetProcAddress(user32, s!("HungWindowFromGhostWindow")) }) else {
        log::debug!("user32.dll does not export HungWindowFromGhostWindow");
        return None;
    };
    // SAFETY: the export's real signature is `HWND WINAPI HungWindowFromGhostWindow(HWND)`, the
    // `extern "system"` ABI with one pointer-sized argument and a pointer-sized result; `HWND` is
    // `#[repr(transparent)]` over a pointer. The transmute only restores that signature on a
    // function pointer of the same size, and user32.dll is never unloaded (see above).
    Some(unsafe {
        std::mem::transmute::<unsafe extern "system" fn() -> isize, HungWindowFromGhostWindowFn>(
            export,
        )
    })
}

/// Whether `hwnd` still exists and Windows considers it not responding (no message processed
/// for about five seconds).
fn is_hung_window(hwnd: HWND) -> bool {
    // SAFETY: plain queries on a window handle; a stale handle yields FALSE. Neither call sends
    // a message to the window, so neither blocks on a hung thread.
    unsafe { IsWindow(Some(hwnd)).as_bool() && IsHungAppWindow(hwnd).as_bool() }
}

/// The window to report for the ghost `ghost` (all handles as plain integers): the hung window
/// user32 `mapped` it to; or, when that mapping is unavailable or empty, the `cached` foreground
/// window if `is_hung` says it still exists and is not responding; otherwise none. `is_hung` is
/// only consulted for the fallback.
fn ghost_target(
    ghost: isize,
    mapped: Option<isize>,
    cached: Option<isize>,
    is_hung: impl FnOnce(isize) -> bool,
) -> Option<isize> {
    let usable = |window: &isize| *window != 0 && *window != ghost;
    match mapped.filter(usable) {
        Some(hung) => Some(hung),
        None => cached.filter(usable).filter(|&window| is_hung(window)),
    }
}

// ---- windows ----------------------------------------------------------------------------------

/// A window handle as a plain integer, for cache keys (`HWND` itself is not `Send`).
fn hwnd_key(hwnd: HWND) -> isize {
    hwnd.0 as isize
}

/// The window handle a [`hwnd_key`] was made from.
fn hwnd_from_key(key: isize) -> HWND {
    HWND(key as *mut c_void)
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
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, PeekMessageW, ShowWindow,
        TranslateMessage, CW_USEDEFAULT, MSG, PM_REMOVE, SW_SHOWNOACTIVATE, WINDOW_EX_STYLE,
        WS_OVERLAPPEDWINDOW,
    };

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
    fn ghost_host_is_dwm_compared_case_insensitively() {
        assert!(is_ghost_host("dwm.exe"));
        assert!(is_ghost_host("DWM.EXE"));
        assert!(is_ghost_host("Dwm.Exe"));
        assert!(!is_ghost_host("dwm"));
        assert!(!is_ghost_host("notdwm.exe"));
        assert!(!is_ghost_host("dwm.exe.bak"));
        assert!(!is_ghost_host(""));
        assert!(!is_ghost_host(FRAME_HOST_EXE));
        assert!(!is_ghost_host("Photoshop.exe"));
    }

    const GHOST: isize = 0x1_0010;
    const HUNG: isize = 0x1_0020;
    const CACHED: isize = 0x1_0030;

    #[test]
    fn ghost_target_prefers_the_window_user32_maps_it_to() {
        let never = |_: isize| -> bool { panic!("fallback consulted although the mapping worked") };
        // The mapping is authoritative, even over a different cached window (the user switched
        // apps before the freeze).
        assert_eq!(
            ghost_target(GHOST, Some(HUNG), Some(CACHED), never),
            Some(HUNG)
        );
        assert_eq!(ghost_target(GHOST, Some(HUNG), None, never), Some(HUNG));
    }

    #[test]
    fn ghost_target_falls_back_to_the_cached_window_only_while_it_is_hung() {
        // Export missing (None), returned null (0), or returned nonsense (the ghost itself).
        for mapped in [None, Some(0), Some(GHOST)] {
            let hung_cached = |window: isize| {
                assert_eq!(window, CACHED, "only the cached window is examined");
                true
            };
            assert_eq!(
                ghost_target(GHOST, mapped, Some(CACHED), hung_cached),
                Some(CACHED),
                "{mapped:?}"
            );
            // Responding again or destroyed: the ghost is not attributed to it.
            assert_eq!(ghost_target(GHOST, mapped, Some(CACHED), |_| false), None);
            // Nothing cached (first poll ever was the ghost).
            assert_eq!(ghost_target(GHOST, mapped, None, |_| true), None);
            // Never the ghost itself or a null handle.
            assert_eq!(ghost_target(GHOST, mapped, Some(GHOST), |_| true), None);
            assert_eq!(ghost_target(GHOST, mapped, Some(0), |_| true), None);
        }
    }

    #[test]
    fn hung_window_export_is_resolved_and_ignores_non_ghosts() {
        // Exported by every supported Windows (10 and 11).
        let hung_window_from_ghost =
            load_hung_window_from_ghost().expect("user32 exports HungWindowFromGhostWindow");
        // SAFETY: the resolved export accepts any handle value; null is not a ghost.
        let hung = unsafe { hung_window_from_ghost(HWND::default()) };
        assert!(hung.is_invalid());
        assert!(Win32Probe::new().hung_window_from_ghost.is_some());
        assert!(!is_hung_window(HWND::default()));
    }

    #[test]
    fn snapshot_names_processes_without_opening_them() {
        let exe = std::env::current_exe().expect("current exe");
        let expected = exe.file_name().and_then(|name| name.to_str()).unwrap_or("");
        let name = snapshot_exe_name(std::process::id()).expect("own pid is in the snapshot");
        assert!(name.eq_ignore_ascii_case(expected), "{name} vs {expected}");
        // Pids are multiples of 4; this one never exists.
        assert_eq!(snapshot_exe_name(u32::MAX - 2), None);
    }

    #[test]
    fn idle_and_session_queries_do_not_panic() {
        let mut probe = Win32Probe::new();
        let _ = probe.idle_ms();
        let _ = probe.session_state();
        let _ = probe.foreground_process();
        let _ = probe.foreground_process();
    }

    // ---- live ghost check (no focus needed) ---------------------------------------------------

    /// A shown but not activated top-level window whose thread stops processing messages half a
    /// second after creating it: to Windows, a hung app. Dropping it lets the thread pump again,
    /// destroy the window and exit.
    struct HungWindow {
        hwnd: HWND,
        release: Option<mpsc::Sender<()>>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl HungWindow {
        fn open() -> Self {
            let (created_tx, created_rx) = mpsc::channel();
            let (release, released) = mpsc::channel::<()>();
            let thread = thread::spawn(move || {
                let hwnd = create_unfocused_window();
                // Window handles are not `Send`; pass the handle value.
                let _ = created_tx.send(hwnd.map(hwnd_key));
                let Some(hwnd) = hwnd else {
                    return;
                };
                // Respond for a moment, like an app that was in use before it froze.
                let responsive_until = Instant::now() + Duration::from_millis(500);
                while Instant::now() < responsive_until {
                    pump_messages();
                    thread::sleep(Duration::from_millis(10));
                }
                // No message is processed from here until released.
                let _ = released.recv();
                pump_messages();
                // SAFETY: the window was created by this thread, the only one that may destroy it.
                let _ = unsafe { DestroyWindow(hwnd) };
                pump_messages();
            });
            let key = created_rx.recv().ok().flatten();
            let key = key.expect("create a top-level test window");
            Self {
                hwnd: hwnd_from_key(key),
                release: Some(release),
                thread: Some(thread),
            }
        }
    }

    impl Drop for HungWindow {
        fn drop(&mut self) {
            drop(self.release.take());
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn create_unfocused_window() -> Option<HWND> {
        // SAFETY: `None` asks for this executable's module handle; there is nothing to release.
        let module = unsafe { GetModuleHandleW(None) }.ok()?;
        // SAFETY: "STATIC" is a system class registered in every GUI process; every other
        // argument is a plain value or null. The window belongs to the calling thread.
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("Studio Pulse ghost test"),
                WS_OVERLAPPEDWINDOW,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                360,
                200,
                None,
                None,
                Some(module.into()),
                None,
            )
        }
        .ok()?;
        // SAFETY: plain call on the window this thread just created. No activation, so the
        // check never takes the focus from whoever is using the desktop.
        let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
        Some(hwnd)
    }

    fn pump_messages() {
        let mut msg = MSG::default();
        // SAFETY: `msg` is a valid out-buffer, dispatched only on the thread that received it.
        while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
            // SAFETY: as above.
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    /// Drives the probe's top-level resolution with a real ghost instead of the foreground
    /// window, so both the export path and the fallback run without stealing the focus.
    /// `cargo test --lib ghost_of_a_hung_window -- --ignored`
    #[test]
    #[ignore = "needs an interactive Windows desktop; shows an unfocused window that hangs ~5 s"]
    fn ghost_of_a_hung_window_resolves_to_the_hung_app() {
        let own_pid = std::process::id();
        let window = HungWindow::open();
        let mut probe = Win32Probe::new();
        let mut no_export = Win32Probe {
            hung_window_from_ghost: None,
            ..Win32Probe::new()
        };
        // Both probes see the window before it is ghosted, as when the user works in the app.
        for each in [&mut probe, &mut no_export] {
            let app = each.query_top_level(window.hwnd).map(|app| app.pid);
            assert_eq!(app, Some(own_pid));
        }

        let hung_window_from_ghost = load_hung_window_from_ghost().expect("export present");
        let deadline = Instant::now() + Duration::from_secs(15);
        let ghost = loop {
            let ghost = top_level_windows().into_iter().find(|&candidate| {
                // SAFETY: as in `Win32Probe::query_ghost`; any handle value is acceptable.
                let hung = unsafe { hung_window_from_ghost(candidate) };
                hung == window.hwnd
            });
            if let Some(ghost) = ghost {
                break ghost;
            }
            // Observed on Windows 11 (build 26200): a hung window that is not in the foreground
            // is ghosted once something asks whether it is hung; without that query it was not
            // ghosted within 15 s.
            let _ = is_hung_window(window.hwnd);
            assert!(
                Instant::now() < deadline,
                "Windows never ghosted the window (hung: {}); is window ghosting disabled?",
                is_hung_window(window.hwnd)
            );
            thread::sleep(Duration::from_millis(100));
        };
        assert!(is_hung_window(window.hwnd));
        let ghost_pid = window_pid(ghost).expect("the ghost has an owner");
        let ghost_owner = snapshot_exe_name(ghost_pid);
        assert!(
            ghost_owner.as_deref().is_some_and(is_ghost_host),
            "ghost owned by {ghost_owner:?}"
        );

        // HungWindowFromGhostWindow: the hung app, served from its cache entry. The second poll
        // takes the known-ghost shortcut.
        for poll in 0..2 {
            let app = probe.query_top_level(ghost);
            assert_eq!(app.map(|app| app.pid), Some(own_pid), "poll {poll}");
        }
        assert_eq!(probe.ghost, Some((hwnd_key(ghost), ghost_pid)));
        let cached = probe.foreground.as_ref().map(|cached| cached.hwnd);
        assert_eq!(cached, Some(hwnd_key(window.hwnd)), "hung app's entry kept");

        // Without the export: the cached foreground window is hung, so it is reported.
        let app = no_export.query_top_level(ghost).map(|app| app.pid);
        assert_eq!(app, Some(own_pid));

        // Without the export and without history there is nothing to attribute the ghost to.
        let mut cold = Win32Probe {
            hung_window_from_ghost: None,
            ..Win32Probe::new()
        };
        assert_eq!(cold.query_top_level(ghost), None);

        // Once the hung window is gone, a stale ghost handle resolves to nothing.
        drop(window);
        assert_eq!(probe.query_top_level(ghost), None);
    }
}
