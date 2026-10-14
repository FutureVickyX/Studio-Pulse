//! Live Win32 probe checks. They need a real, interactive Windows desktop, so every test is
//! `#[ignore]`d. Run them explicitly:
//!
//! ```text
//! cargo test --test windows_live -- --ignored --test-threads=1
//! ```
//!
//! Nothing here reads window titles: windows are only mapped to the pids that own them.
#![cfg(windows)]

use std::collections::HashSet;
use std::path::Path;
use std::process::{Child, Command};
use std::thread::sleep;
use std::time::{Duration, Instant};

use studio_pulse_lib::platform::{create_probe, process_info, running_applications};
use studio_pulse_lib::tracker::SessionState;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, TRUE};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowThreadProcessId, IsWindowVisible,
    SetForegroundWindow,
};

const THIRTY_DAYS_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
/// A classic Win32 app that ships with every Windows 10/11 install and opens a normal window.
const GUI_CHILD: &str = r"C:\Windows\System32\charmap.exe";
const WINDOW_TIMEOUT: Duration = Duration::from_secs(20);

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
