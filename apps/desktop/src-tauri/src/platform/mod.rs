//! OS-dependent probes. Only this module talks to Win32 for tracking purposes.
//!
//! Privacy boundary: the probe returns the foreground process image (file name and path) and the
//! time since the last input event. It never reads window titles, window contents, keystrokes or
//! clipboard data. Paths are used in memory for registry matching and never stored with records.

use serde::Serialize;

use crate::tracker::SessionState;

#[cfg(windows)]
mod win32;

/// The process that owns a window.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    /// Image file name, e.g. `Photoshop.exe`.
    pub exe_name: String,
    /// Full image path, e.g. `C:\Program Files\Adobe\Adobe Photoshop 2025\Photoshop.exe`.
    pub exe_path: String,
}

/// System observations needed by the tracker. Implementations must be cheap: the tracker calls
/// every method once per second.
pub trait SystemProbe: Send {
    /// The process owning the foreground window. Returns `None` when there is no foreground window
    /// or the process can't be queried. `ApplicationFrameHost.exe` (UWP host) is resolved to the
    /// hosted app's process, and the ghost window Windows shows for a hung app (owned by dwm.exe)
    /// to the hung app's process, so a freeze is not reported as a switch away from the app.
    fn foreground_process(&mut self) -> Option<ProcessInfo>;

    /// Milliseconds since the last keyboard or mouse input, system-wide (`GetLastInputInfo`), or
    /// `None` if the query failed.
    fn idle_ms(&mut self) -> Option<u64>;

    /// Lock screen, screen saver or disconnected session. Returns `Unknown` if the query failed.
    fn session_state(&mut self) -> SessionState;
}

/// Platform probe for the current OS.
pub fn create_probe() -> Box<dyn SystemProbe> {
    #[cfg(windows)]
    {
        Box::new(win32::Win32Probe::new())
    }
    #[cfg(not(windows))]
    {
        Box::new(UnsupportedProbe)
    }
}

/// Processes that currently own a visible, unowned top-level window, de-duplicated by image path
/// and sorted by exe name. Used only by the "add application" picker.
pub fn running_applications() -> Vec<ProcessInfo> {
    #[cfg(windows)]
    {
        win32::running_applications()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Image name and path of the process `pid`, or `None` if it has exited, is protected, or runs
/// elevated while we do not. Reads only the image path; never window titles or process memory.
pub fn process_info(pid: u32) -> Option<ProcessInfo> {
    #[cfg(windows)]
    {
        win32::process_info(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

/// The file-name component of an image path (`C:\Apps\Figma.exe` → `Figma.exe`). Accepts both
/// `\` and `/` separators so it behaves the same on every OS; returns the whole input when it
/// contains no separator.
pub fn exe_name_from_path(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

/// Stand-in for non-Windows builds so the pure modules and their tests compile anywhere.
/// Studio Pulse does not claim tracking support on other platforms.
#[cfg(not(windows))]
pub struct UnsupportedProbe;

#[cfg(not(windows))]
impl SystemProbe for UnsupportedProbe {
    fn foreground_process(&mut self) -> Option<ProcessInfo> {
        None
    }

    fn idle_ms(&mut self) -> Option<u64> {
        None
    }

    fn session_state(&mut self) -> SessionState {
        SessionState::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_name_is_the_last_path_component() {
        assert_eq!(
            exe_name_from_path(r"C:\Program Files\Adobe\Photoshop.exe"),
            "Photoshop.exe"
        );
        assert_eq!(exe_name_from_path("C:/tools/blender.exe"), "blender.exe");
        assert_eq!(exe_name_from_path("Figma.exe"), "Figma.exe");
        assert_eq!(exe_name_from_path(r"\\?\C:\a\b c\Code.exe"), "Code.exe");
        assert_eq!(exe_name_from_path(""), "");
    }
}
