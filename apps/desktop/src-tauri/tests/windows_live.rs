//! Live Win32 probe checks. They need a real, interactive Windows desktop, so every test is
//! `#[ignore]`d. Run them explicitly:
//!
//! ```text
//! cargo test --test windows_live -- --ignored --test-threads=1
//! ```
//!
//! Nothing here reads window titles: windows are only mapped to the pids that own them, and a
//! ghost window to the hung window it stands in for.
#![cfg(windows)]

use std::collections::HashSet;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread::{self, sleep, JoinHandle};
use std::time::{Duration, Instant};

use studio_pulse_lib::platform::{create_probe, process_info, running_applications};
use studio_pulse_lib::tracker::SessionState;
use windows::core::{s, w, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM, TRUE};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, CreateWindowExW, DestroyWindow, DispatchMessageW, EnumWindows,
    GetForegroundWindow, GetWindowThreadProcessId, IsHungAppWindow, IsWindowVisible, PeekMessageW,
    SetForegroundWindow, ShowWindow, TranslateMessage, CW_USEDEFAULT, MSG, PM_REMOVE,
    SW_SHOWNORMAL, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW,
};

const THIRTY_DAYS_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
/// A classic Win32 app that ships with every Windows 10/11 install and opens a normal window.
const GUI_CHILD: &str = r"C:\Windows\System32\charmap.exe";
const WINDOW_TIMEOUT: Duration = Duration::from_secs(20);
/// How long the test window's thread stops pumping messages. Windows declares a window hung
/// after about 5 s without a message being processed, and only then puts a ghost in its place.
const FREEZE: Duration = Duration::from_secs(8);

// ---- helpers ----------------------------------------------------------------------------------

/// Kills and reaps the spawned process when dropped, so a failed assertion never leaks it.
struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn window_pid(hwnd: HWND) -> Option<u32> {
    let mut pid = 0u32;
    // SAFETY: `pid` is a valid out-pointer for the duration of the call.
    let thread = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    (thread != 0 && pid != 0).then_some(pid)
}

fn foreground_window() -> Option<HWND> {
    // SAFETY: no arguments; returns a possibly-null handle.
    let hwnd = unsafe { GetForegroundWindow() };
    (!hwnd.is_invalid()).then_some(hwnd)
}

/// Visible top-level windows as (window handle value, owning pid).
fn visible_windows() -> Vec<(isize, u32)> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the `&mut Vec` passed below, alive for the whole enumeration.
        let found = unsafe { &mut *(lparam.0 as *mut Vec<(isize, u32)>) };
        // SAFETY: plain query on a handle supplied by EnumWindows.
        if unsafe { IsWindowVisible(hwnd) }.as_bool() {
            if let Some(pid) = window_pid(hwnd) {
                found.push((hwnd.0 as isize, pid));
            }
        }
        TRUE
    }
    let mut found: Vec<(isize, u32)> = Vec::new();
    // SAFETY: the callback only runs during this call, while `found` is alive.
    unsafe {
        EnumWindows(
            Some(collect),
            LPARAM(&mut found as *mut Vec<(isize, u32)> as isize),
        )
    }
    .expect("EnumWindows");
    found
}

/// Waits until `pid` owns a visible top-level window and returns it.
fn wait_for_window(pid: u32, timeout: Duration) -> Option<HWND> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some((hwnd, _)) = visible_windows()
            .into_iter()
            .find(|&(_, owner)| owner == pid)
        {
            return Some(HWND(hwnd as *mut _));
        }
        sleep(Duration::from_millis(100));
    }
    None
}

fn own_exe_name() -> String {
    std::env::current_exe()
        .expect("current exe")
        .file_name()
        .and_then(|name| name.to_str())
        .expect("utf-8 exe name")
        .to_string()
}

/// Waits until `hwnd` is the foreground window.
fn wait_for_foreground(hwnd: HWND, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if foreground_window() == Some(hwnd) {
            return true;
        }
        sleep(Duration::from_millis(50));
    }
    false
}

/// `user32!HungWindowFromGhostWindow` (exported by name, absent from the SDK headers): the hung
/// window that `ghost` stands in for, or `None` when `ghost` is not a ghost window. The test's
/// own oracle for "the foreground window is our window's ghost".
fn hung_window_of_ghost(ghost: HWND) -> Option<HWND> {
    type HungWindowFromGhostWindowFn = unsafe extern "system" fn(HWND) -> HWND;
    // SAFETY: user32.dll is loaded in this process (statically imported) and never unloaded.
    let user32 = unsafe { GetModuleHandleW(w!("user32.dll")) }.ok()?;
    // SAFETY: valid module handle and a NUL-terminated ANSI name.
    let export = unsafe { GetProcAddress(user32, s!("HungWindowFromGhostWindow")) }?;
    // SAFETY: the export's signature is `HWND WINAPI HungWindowFromGhostWindow(HWND)`, and
    // `HWND` is `#[repr(transparent)]` over a pointer, so only the static signature changes.
    let hung_window_from_ghost = unsafe {
        std::mem::transmute::<unsafe extern "system" fn() -> isize, HungWindowFromGhostWindowFn>(
            export,
        )
    };
    // SAFETY: the function only looks the handle up; any handle value is acceptable.
    let hung = unsafe { hung_window_from_ghost(ghost) };
    (!hung.is_invalid()).then_some(hung)
}

enum WindowCommand {
    /// Stop pumping messages for this long, as a busy app does.
    Freeze(Duration),
    Quit,
}

/// A visible top-level window owned by a helper thread that pumps its messages until told to
/// freeze. Dropping it ends the thread and destroys the window.
struct FreezableWindow {
    hwnd: HWND,
    commands: mpsc::Sender<WindowCommand>,
    thread: Option<JoinHandle<()>>,
}

impl FreezableWindow {
    /// Creates the window, shown and (if Windows allows it) in the foreground. `None` if no
    /// window could be created.
    fn open() -> Option<Self> {
        let (ready_tx, ready_rx) = mpsc::channel();
        let (commands, commands_rx) = mpsc::channel();
        let thread = thread::spawn(move || run_window_thread(&ready_tx, &commands_rx));
        // Window handles are not `Send`; the helper sends the handle value.
        let hwnd = ready_rx
            .recv()
            .ok()
            .flatten()
            .map(|hwnd| HWND(hwnd as *mut _));
        let window = Self {
            hwnd: hwnd.unwrap_or_default(),
            commands,
            thread: Some(thread),
        };
        hwnd.is_some().then_some(window)
    }

    fn freeze(&self, duration: Duration) {
        self.commands
            .send(WindowCommand::Freeze(duration))
            .expect("window thread is running");
    }
}

impl Drop for FreezableWindow {
    fn drop(&mut self) {
        let _ = self.commands.send(WindowCommand::Quit);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn run_window_thread(
    ready: &mpsc::Sender<Option<isize>>,
    commands: &mpsc::Receiver<WindowCommand>,
) {
    let Some(hwnd) = create_test_window() else {
        let _ = ready.send(None);
        return;
    };
    bring_to_front(hwnd);
    let _ = ready.send(Some(hwnd.0 as isize));
    loop {
        pump_messages();
        match commands.recv_timeout(Duration::from_millis(10)) {
            // Sleeping without pumping is exactly what a busy UI thread looks like to Windows.
            Ok(WindowCommand::Freeze(duration)) => sleep(duration),
            Ok(WindowCommand::Quit) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
    // SAFETY: the window was created by this thread, which is the only one allowed to destroy it.
    let _ = unsafe { DestroyWindow(hwnd) };
    pump_messages();
}

/// A captioned, still hidden top-level window of the system "STATIC" class, owned by the
/// calling thread.
fn create_test_window() -> Option<HWND> {
    // SAFETY: `None` asks for this executable's module handle; there is nothing to release.
    let module = unsafe { GetModuleHandleW(None) }.ok()?;
    // SAFETY: "STATIC" is a system class registered in every GUI process; every other argument
    // is a plain value or null. The window belongs to the calling thread.
    unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            w!("Studio Pulse hung-window test"),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            480,
            240,
            None,
            None,
            Some(module.into()),
            None,
        )
    }
    .ok()
}

/// Asks Windows to put `hwnd` (owned by the calling thread) in the foreground.
fn bring_to_front(hwnd: HWND) {
    // SAFETY: plain calls on a window this thread owns; failure is harmless.
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNORMAL);
        if SetForegroundWindow(hwnd).as_bool() && foreground_window() == Some(hwnd) {
            return;
        }
    }
    // Focus-stealing prevention refuses a process that is not in the foreground. Sharing input
    // state with the foreground window's thread for the duration of one call lifts that.
    let Some(foreground) = foreground_window() else {
        return;
    };
    // SAFETY: plain calls; the input attachment is undone before returning, so the freeze
    // that follows never stalls the other thread's input.
    unsafe {
        let theirs = GetWindowThreadProcessId(foreground, None);
        let ours = GetCurrentThreadId();
        if theirs != 0 && theirs != ours && AttachThreadInput(ours, theirs, true).as_bool() {
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            let _ = AttachThreadInput(ours, theirs, false);
        }
    }
}

/// Dispatches every queued message of the calling thread.
fn pump_messages() {
    let mut msg = MSG::default();
    // SAFETY: `msg` is a valid out-buffer and is only dispatched on the thread that received it.
    while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
        // SAFETY: as above.
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

// ---- tests ------------------------------------------------------------------------------------

#[test]
#[ignore = "needs an interactive Windows desktop"]
fn idle_time_is_available_and_plausible() {
    let mut probe = create_probe();
    let idle = probe.idle_ms().expect("GetLastInputInfo succeeds");
    eprintln!("idle: {idle} ms");
    assert!(idle < THIRTY_DAYS_MS, "idle {idle} ms is implausible");
    // A second reading a moment later is consistent (no input needed: it can only grow or reset).
    sleep(Duration::from_millis(50));
    assert!(probe.idle_ms().is_some());
}

#[test]
#[ignore = "needs an interactive Windows desktop"]
fn interactive_session_is_not_disconnected() {
    let mut probe = create_probe();
    let state = probe.session_state();
    eprintln!("session: {state:?}");
    assert_ne!(state, SessionState::Disconnected);
}

#[test]
#[ignore = "needs an interactive Windows desktop"]
fn process_info_resolves_this_test_binary() {
    let info = process_info(std::process::id()).expect("own process is queryable");
    let expected = own_exe_name();
    assert_eq!(info.pid, std::process::id());
    assert!(
        info.exe_name.eq_ignore_ascii_case(&expected),
        "{info:?} vs {expected}"
    );
    assert!(Path::new(&info.exe_path).is_absolute(), "{info:?}");
    assert!(
        info.exe_path
            .to_lowercase()
            .ends_with(&expected.to_lowercase()),
        "{info:?}"
    );
}

#[test]
#[ignore = "needs an interactive Windows desktop"]
fn process_info_of_missing_processes_is_none() {
    assert!(process_info(0).is_none());
    // Pids are multiples of 4; this one is never valid.
    assert!(process_info(u32::MAX - 2).is_none());
}

#[test]
#[ignore = "needs an interactive Windows desktop"]
fn running_applications_are_unique_sorted_and_exclude_us() {
    let apps = running_applications();
    eprintln!("{} running application(s)", apps.len());
    assert!(
        !apps.is_empty(),
        "an interactive desktop has at least one app window"
    );

    let own_pid = std::process::id();
    let mut paths = HashSet::new();
    for app in &apps {
        assert_ne!(app.pid, own_pid, "our own process is listed");
        assert!(
            !app.exe_name.is_empty() && !app.exe_path.is_empty(),
            "{app:?}"
        );
        assert!(
            app.exe_path
                .to_lowercase()
                .ends_with(&app.exe_name.to_lowercase()),
            "{app:?}"
        );
        assert!(
            paths.insert(app.exe_path.to_lowercase()),
            "duplicate path {}",
            app.exe_path
        );
        assert!(
            !app.exe_name
                .eq_ignore_ascii_case("ApplicationFrameHost.exe"),
            "UWP frame host should be resolved to the hosted app"
        );
    }
    let names: Vec<String> = apps.iter().map(|app| app.exe_name.to_lowercase()).collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted, "sorted by exe name, case-insensitively");
}

#[test]
#[ignore = "needs an interactive Windows desktop"]
fn foreground_process_is_reported_when_a_window_has_focus() {
    let Some(hwnd) = foreground_window() else {
        eprintln!("no foreground window right now (desktop switching?); nothing to check");
        return;
    };
    let owner = window_pid(hwnd).expect("foreground window has an owner");
    let mut probe = create_probe();
    match probe.foreground_process() {
        Some(info) => {
            eprintln!("foreground: {} (pid {})", info.exe_name, info.pid);
            let via_frame_host = process_info(owner).is_some_and(|host| {
                host.exe_name
                    .eq_ignore_ascii_case("ApplicationFrameHost.exe")
            });
            assert!(
                info.pid == owner || via_frame_host,
                "probe pid {} differs from the window owner {owner}",
                info.pid
            );
            // A second poll of the same window is served from the cache and is identical.
            if foreground_window() == Some(hwnd) {
                assert_eq!(probe.foreground_process(), Some(info));
            }
        }
        None => {
            // Only acceptable when the owner cannot be queried (elevated or protected window).
            assert!(
                process_info(owner).is_none(),
                "foreground window of pid {owner} is queryable but the probe returned None"
            );
            eprintln!("foreground window belongs to an elevated or protected process");
        }
    }
}

#[test]
#[ignore = "needs an interactive Windows desktop; opens and closes Character Map"]
fn spawned_gui_process_is_resolved_and_listed() {
    let child = Command::new(GUI_CHILD).spawn().expect("spawn charmap.exe");
    let guard = ChildGuard(child);
    let pid = guard.0.id();

    let hwnd = wait_for_window(pid, WINDOW_TIMEOUT).expect("charmap opens a visible window");

    let info = process_info(pid).expect("charmap is queryable");
    assert_eq!(info.pid, pid);
    assert!(
        info.exe_name.eq_ignore_ascii_case("charmap.exe"),
        "{info:?}"
    );
    assert!(
        info.exe_path
            .to_lowercase()
            .ends_with(r"\system32\charmap.exe"),
        "{info:?}"
    );

    let apps = running_applications();
    assert!(
        apps.iter()
            .any(|app| app.exe_path.eq_ignore_ascii_case(&info.exe_path)),
        "charmap missing from running applications"
    );

    // Bring it to the front if Windows allows it (focus-stealing prevention may refuse when
    // this test process is not in the foreground), then check the probe end to end.
    // SAFETY: plain call on a window handle we just observed; failure is harmless.
    let _ = unsafe { SetForegroundWindow(hwnd) };
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut focused = false;
    while Instant::now() < deadline {
        if foreground_window().and_then(window_pid) == Some(pid) {
            focused = true;
            break;
        }
        sleep(Duration::from_millis(100));
    }
    if focused {
        let mut probe = create_probe();
        let foreground = probe.foreground_process().expect("foreground resolved");
        assert_eq!(foreground.pid, pid);
        assert!(foreground.exe_name.eq_ignore_ascii_case("charmap.exe"));
        eprintln!("charmap took the foreground and the probe reported it");
    } else {
        eprintln!("Windows kept charmap in the background; foreground check skipped");
    }

    drop(guard);
    // After it exits the pid can no longer be resolved to charmap.
    let after = process_info(pid);
    assert!(
        after
            .as_ref()
            .is_none_or(|info| !info.exe_name.eq_ignore_ascii_case("charmap.exe")),
        "{after:?}"
    );
}

#[test]
#[ignore = "needs an interactive Windows desktop; takes the focus and freezes a window for ~8 s"]
fn hung_foreground_window_and_its_ghost_are_reported_as_its_app() {
    let own_pid = std::process::id();
    let own_exe = own_exe_name();
    let window = FreezableWindow::open().expect("create a top-level test window");
    if !wait_for_foreground(window.hwnd, Duration::from_secs(3)) {
        eprintln!("Windows kept the test window in the background; hung-window check skipped");
        return;
    }
    let mut probe = create_probe();
    let before = probe
        .foreground_process()
        .expect("probe resolves the focused test window");
    assert_eq!(before.pid, own_pid, "{before:?}");

    window.freeze(FREEZE);
    let frozen_at = Instant::now();
    let (mut samples, mut hung_samples, mut ghost_samples) = (0, 0, 0);
    let mut focus_lost = false;
    while frozen_at.elapsed() + Duration::from_millis(500) < FREEZE {
        sleep(Duration::from_millis(200));
        let Some(foreground) = foreground_window() else {
            continue;
        };
        let reported = probe.foreground_process();
        if foreground_window() != Some(foreground) {
            continue; // the foreground changed mid-sample; judge the next one
        }
        let is_ghost =
            foreground != window.hwnd && hung_window_of_ghost(foreground) == Some(window.hwnd);
        if foreground != window.hwnd && !is_ghost {
            eprintln!(
                "after {:?} of freeze another window took the foreground ({:?})",
                frozen_at.elapsed(),
                reported.map(|app| app.exe_name),
            );
            focus_lost = true;
            break;
        }
        // SAFETY: plain query; it sends no message, so it never blocks on the frozen thread.
        let hung = unsafe { IsHungAppWindow(window.hwnd) }.as_bool();
        let what = if is_ghost {
            format!("its ghost (owned by pid {:?})", window_pid(foreground))
        } else {
            format!("the test window itself (hung: {hung})")
        };
        let reported = reported.unwrap_or_else(|| {
            panic!(
                "after {:?} of freeze the foreground is {what} but the probe reported nothing",
                frozen_at.elapsed()
            )
        });
        assert_eq!(
            reported.pid,
            own_pid,
            "after {:?} of freeze the foreground is {what} but the probe reported {reported:?}",
            frozen_at.elapsed()
        );
        assert!(
            reported.exe_name.eq_ignore_ascii_case(&own_exe),
            "{reported:?}"
        );
        samples += 1;
        hung_samples += usize::from(hung);
        ghost_samples += usize::from(is_ghost);
    }
    eprintln!(
        "{samples} sample(s) during the freeze: {hung_samples} with the window hung, \
         {ghost_samples} with its ghost in the foreground"
    );
    if focus_lost {
        eprintln!("another window took the foreground during the freeze; rest of check skipped");
        return;
    }
    assert!(
        hung_samples > 0,
        "Windows never reported the frozen window as hung; the freeze did not take effect"
    );
    assert!(
        ghost_samples > 0,
        "Windows never put a ghost in place of the hung foreground window, so the ghost path \
         was not exercised (is window ghosting disabled?)"
    );

    // Once the thread pumps again Windows retires the ghost and the window itself comes back.
    if wait_for_foreground(window.hwnd, FREEZE) {
        let after = probe
            .foreground_process()
            .expect("probe resolves the recovered window");
        assert_eq!(after.pid, own_pid, "{after:?}");
    } else {
        eprintln!("the recovered window did not return to the foreground; recovery check skipped");
    }
}
