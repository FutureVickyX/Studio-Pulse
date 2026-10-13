//! Win32 implementation of [`SystemProbe`](super::SystemProbe).
//!
//! APIs: `GetForegroundWindow`, `GetWindowThreadProcessId`, `OpenProcess`
//! (`PROCESS_QUERY_LIMITED_INFORMATION` only), `QueryFullProcessImageNameW`, `GetLastInputInfo`,
//! `WTSQuerySessionInformationW(WTSSessionInfoEx)`, `SystemParametersInfoW(SPI_GETSCREENSAVERRUNNING)`.

use super::{ProcessInfo, SystemProbe};
use crate::tracker::SessionState;

pub struct Win32Probe {}

impl Win32Probe {
    pub fn new() -> Self {
        Self {}
    }
}

impl SystemProbe for Win32Probe {
    fn foreground_process(&mut self) -> Option<ProcessInfo> {
        todo!("win32 foreground_process")
    }

    fn idle_ms(&mut self) -> Option<u64> {
        todo!("win32 idle_ms")
    }

    fn session_state(&mut self) -> SessionState {
        todo!("win32 session_state")
    }
}

pub fn running_applications() -> Vec<ProcessInfo> {
    todo!("win32 running_applications")
}
