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
    /// hosted app's process.
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
