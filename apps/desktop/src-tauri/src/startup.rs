//! Launch at Windows sign-in via the per-user `Run` key, with read-back verification and
//! visibility into Windows' own `StartupApproved` flag. docs/architecture.md §8.

use std::path::Path;

use serde::Serialize;

/// Command-line flag Windows passes when it launches Studio Pulse at sign-in.
pub const AUTOSTART_ARG: &str = "--autostart";

/// Where the registration lives. Tests point this at a scratch key so they never touch the real
/// `Run` key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupConfig {
    /// Subkey of HKEY_CURRENT_USER, e.g. `Software\Microsoft\Windows\CurrentVersion\Run`.
    pub run_key: String,
    /// Subkey of HKEY_CURRENT_USER holding the StartupApproved flags.
    pub approved_key: String,
    pub value_name: String,
}

impl Default for StartupConfig {
    fn default() -> Self {
        Self {
            run_key: r"Software\Microsoft\Windows\CurrentVersion\Run".to_string(),
            approved_key: r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
                .to_string(),
            value_name: "Studio Pulse".to_string(),
        }
    }
}

/// Serialized shape = `StartupStatus` in shared-types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatus {
    pub enabled: bool,
    pub registered: bool,
    pub approved_by_windows: Option<bool>,
    pub points_to_current_executable: bool,
    pub command: Option<String>,
    pub is_development_build: bool,
    pub message: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum StartupError {
    #[error("Windows registry error: {0}")]
    Registry(String),
    #[error("startup registration could not be verified: {0}")]
    Verification(String),
    #[error("launch at login is only supported on Windows")]
    Unsupported,
}

/// The exact command written to the Run value: `"<exe>" --autostart`.
pub fn command_line(_exe: &Path) -> String {
    todo!("startup::command_line")
}

/// Read the current registration from the registry. Never cached.
pub fn status(_config: &StartupConfig, _exe: &Path) -> Result<StartupStatus, StartupError> {
    todo!("startup::status")
}

/// Register, mark approved, then read back and verify. Errors if the read-back doesn't match.
pub fn enable(_config: &StartupConfig, _exe: &Path) -> Result<StartupStatus, StartupError> {
    todo!("startup::enable")
}

/// Remove the Run value and the StartupApproved flag, then verify both are gone.
pub fn disable(_config: &StartupConfig, _exe: &Path) -> Result<StartupStatus, StartupError> {
    todo!("startup::disable")
}

/// True when this process was launched with [`AUTOSTART_ARG`].
pub fn launched_at_login<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|arg| arg.as_ref() == AUTOSTART_ARG)
}
