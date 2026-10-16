//! Launch at Windows sign-in via the per-user `Run` key, with read-back verification and
//! visibility into Windows' own `StartupApproved` flag. docs/architecture.md §8.
//!
//! Everything lives under `HKEY_CURRENT_USER`, so no elevation is needed. Status is always read
//! from the registry; nothing is cached.

// The pure evaluation helpers are only reachable from the Windows registry code paths.
#![cfg_attr(not(windows), allow(dead_code))]

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

/// The `StartupApproved` value Explorer writes for an enabled entry: flag byte `0x02` followed by
/// eleven zero bytes (no "disabled at" timestamp). Task Manager writes `0x03` plus a FILETIME
/// when the user disables the entry.
pub const APPROVED_ENABLED_VALUE: [u8; 12] = [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/// The exact command written to the Run value: `"<exe>" --autostart`.
pub fn command_line(exe: &Path) -> String {
    format!("\"{}\" {}", exe.display(), AUTOSTART_ARG)
}

/// Read the current registration from the registry. Never cached.
///
/// # Errors
/// [`StartupError::Registry`] when a key or value exists but cannot be read (missing ones are
/// simply "not registered"); [`StartupError::Unsupported`] on non-Windows builds.
pub fn status(config: &StartupConfig, exe: &Path) -> Result<StartupStatus, StartupError> {
    #[cfg(windows)]
    {
        Ok(evaluate(&win::read(config)?, exe))
    }
    #[cfg(not(windows))]
    {
        let _ = (config, exe);
        Err(StartupError::Unsupported)
    }
}

/// Register, mark approved, then read back and verify. Errors if the read-back doesn't match.
///
/// Writes `"<exe>" --autostart` to the Run value and [`APPROVED_ENABLED_VALUE`] to the
/// StartupApproved value (re-enabling an entry the user disabled in Task Manager).
///
/// # Errors
/// [`StartupError::Registry`] when a write fails, [`StartupError::Verification`] when the values
/// read back differ from what was written, [`StartupError::Unsupported`] on non-Windows builds.
pub fn enable(config: &StartupConfig, exe: &Path) -> Result<StartupStatus, StartupError> {
    #[cfg(windows)]
    {
        let command = command_line(exe);
        win::write(config, &command)?;
        verify_enabled(&win::read(config)?, &command).map_err(StartupError::Verification)?;
        log::info!("launch at login enabled");
        status(config, exe)
    }
    #[cfg(not(windows))]
    {
        let _ = (config, exe);
        Err(StartupError::Unsupported)
    }
}

/// Remove the Run value and the StartupApproved flag, then verify both are gone. Values that are
/// already absent are not an error.
///
/// # Errors
/// [`StartupError::Registry`] when a delete fails, [`StartupError::Verification`] when a value is
/// still present afterwards, [`StartupError::Unsupported`] on non-Windows builds.
pub fn disable(config: &StartupConfig, exe: &Path) -> Result<StartupStatus, StartupError> {
    #[cfg(windows)]
    {
        win::remove(config)?;
        verify_removed(&win::read(config)?).map_err(StartupError::Verification)?;
        log::info!("launch at login disabled");
        status(config, exe)
    }
    #[cfg(not(windows))]
    {
        let _ = (config, exe);
        Err(StartupError::Unsupported)
    }
}

/// True when this process was launched with [`AUTOSTART_ARG`].
pub fn launched_at_login<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|arg| arg.as_ref() == AUTOSTART_ARG)
}

// ---- pure evaluation (OS-independent, unit-tested) --------------------------------------------

/// The two registry values as read, before interpretation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Registration {
    /// The Run value exists (whatever its type).
    run_present: bool,
    /// The Run value's text when it is a string (`REG_SZ` / `REG_EXPAND_SZ`).
    command: Option<String>,
    /// The StartupApproved value's bytes when it exists as `REG_BINARY`.
    approved: Option<Vec<u8>>,
}

/// Windows' verdict from a StartupApproved value: the low bit of the first byte is the
/// "disabled" flag (`0x02`/`0x06` enabled, `0x03`/`0x07` disabled). Empty data → unknown.
fn approved_state(bytes: &[u8]) -> Option<bool> {
    bytes.first().map(|flags| flags & 0x01 == 0)
}

/// The executable named by a Run command: the quoted prefix, or for an unquoted command the
/// text up to the first `.exe` followed by whitespace or the end (else the first token).
fn command_executable(command: &str) -> Option<&str> {
    let command = command.trim_start();
    if let Some(rest) = command.strip_prefix('"') {
        let path = &rest[..rest.find('"')?];
        return (!path.is_empty()).then_some(path);
    }
    // ASCII lowercasing keeps byte offsets identical to `command`.
    let lower = command.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find(".exe") {
        let end = from + found + ".exe".len();
        if lower[end..].chars().next().is_none_or(char::is_whitespace) {
            return Some(&command[..end]);
        }
        from = end;
    }
    command.split_whitespace().next()
}

/// Case-insensitive path equality after resolving each path where possible (symlinks, `..`,
/// 8.3 names) and stripping the `\\?\` verbatim prefix that canonicalization adds.
fn same_executable(registered: &Path, current: &Path) -> bool {
    normalize_path(registered) == normalize_path(current)
}

fn normalize_path(path: &Path) -> String {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    normalize_path_text(&resolved.to_string_lossy())
}

/// Lexical part of [`normalize_path`]: `/` becomes `\`, verbatim prefixes are removed, and the
/// result is lowercased.
fn normalize_path_text(text: &str) -> String {
    let text = text.replace('/', "\\");
    let text = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text
    };
    text.to_lowercase()
}

/// Interpret a registration for the executable `exe`.
fn evaluate(registration: &Registration, exe: &Path) -> StartupStatus {
    evaluate_with(registration, exe, cfg!(debug_assertions))
}

fn evaluate_with(
    registration: &Registration,
    exe: &Path,
    is_development_build: bool,
) -> StartupStatus {
    let registered = registration.run_present;
    let approved_by_windows = registration.approved.as_deref().and_then(approved_state);
    let registered_exe = registration.command.as_deref().and_then(command_executable);
    let points_to_current_executable =
        registered_exe.is_some_and(|path| same_executable(Path::new(path), exe));
    let enabled = registered && approved_by_windows != Some(false) && points_to_current_executable;
    let message = (registered && !enabled).then(|| {
        explain(
            approved_by_windows,
            points_to_current_executable,
            registered_exe,
            is_development_build,
        )
    });
    StartupStatus {
        enabled,
        registered,
        approved_by_windows,
        points_to_current_executable,
        command: registration.command.clone(),
        is_development_build,
        message,
    }
}

/// Why a registered entry is not effective, for the settings page.
fn explain(
    approved_by_windows: Option<bool>,
    points_to_current_executable: bool,
    registered_exe: Option<&str>,
    is_development_build: bool,
) -> String {
    let mut parts = Vec::new();
    if approved_by_windows == Some(false) {
        parts.push(
            "Windows has disabled Studio Pulse in Startup apps (Task Manager or Settings > Apps > \
             Startup). Turning launch at login on here enables it again."
                .to_string(),
        );
    }
    if !points_to_current_executable {
        parts.push(match registered_exe {
            Some(path) => format!(
                "Registered for a different copy at {path}. Turn launch at login on to register \
                 this copy instead."
            ),
            None => "The startup entry has a command Studio Pulse does not recognise. Turn launch \
                     at login on to replace it."
                .to_string(),
        });
        if is_development_build {
            parts.push(
                "This is a development build, which runs from a different path than the installed \
                 app."
                    .to_string(),
            );
        }
    }
    parts.join(" ")
}

/// Read-back check after [`enable`]: the exact command and an "enabled" StartupApproved flag.
fn verify_enabled(registration: &Registration, expected_command: &str) -> Result<(), String> {
    match registration.command.as_deref() {
        Some(command) if command == expected_command => {}
        Some(_) => {
            // The values are deliberately not included: the command contains the user's
            // profile path, and this message is logged and shown in the UI.
            return Err(
                "the Run value reads back differently from what was written (another program may                  have changed it)"
                    .to_string(),
            );
        }
        None if registration.run_present => {
            return Err("the Run value reads back with a non-text type".to_string())
        }
        None => return Err("the Run value is missing after writing it".to_string()),
    }
    match registration.approved.as_deref().map(approved_state) {
        Some(Some(true)) => Ok(()),
        Some(Some(false)) => Err("Windows still reports the entry as disabled".to_string()),
        Some(None) => Err("the StartupApproved value reads back empty".to_string()),
        None => Err("the StartupApproved value is missing after writing it".to_string()),
    }
}

/// Read-back check after [`disable`]: both values are gone.
fn verify_removed(registration: &Registration) -> Result<(), String> {
    if registration.run_present {
        return Err("the Run value is still present after deleting it".to_string());
    }
    if registration.approved.is_some() {
        return Err("the StartupApproved value is still present after deleting it".to_string());
    }
    Ok(())
}

// ---- registry access --------------------------------------------------------------------------

#[cfg(windows)]
mod win {
    use std::borrow::Cow;
    use std::io;

    use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_READ, KEY_SET_VALUE};
    use winreg::types::FromRegValue;
    use winreg::{RegKey, RegValue};

    use super::{Registration, StartupConfig, StartupError, APPROVED_ENABLED_VALUE};

    fn hkcu() -> RegKey {
        RegKey::predef(HKEY_CURRENT_USER)
    }

    fn registry_error(action: &str, subkey: &str, err: &io::Error) -> StartupError {
        StartupError::Registry(format!("could not {action} HKCU\\{subkey}: {err}"))
    }

    /// Both values, read through fresh handles. A missing key or value is not an error.
    pub(super) fn read(config: &StartupConfig) -> Result<Registration, StartupError> {
        let root = hkcu();
        let run = read_value(&root, &config.run_key, &config.value_name)?;
        let approved = read_value(&root, &config.approved_key, &config.value_name)?;

        let command = run.as_ref().and_then(|value| match value.vtype {
            RegType::REG_SZ | RegType::REG_EXPAND_SZ => String::from_reg_value(value).ok(),
            _ => None,
        });
        let approved = approved.and_then(|value| match value.vtype {
            RegType::REG_BINARY => Some(value.bytes.into_owned()),
            other => {
                log::debug!("StartupApproved value has unexpected type {other:?}");
                None
            }
        });
        Ok(Registration {
            run_present: run.is_some(),
            command,
            approved,
        })
    }

    fn read_value(
        root: &RegKey,
        subkey: &str,
        name: &str,
    ) -> Result<Option<RegValue<'static>>, StartupError> {
        let key = match root.open_subkey_with_flags(subkey, KEY_READ) {
            Ok(key) => key,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(registry_error("open", subkey, &err)),
        };
        match key.get_raw_value(name) {
            Ok(value) => Ok(Some(value)),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(registry_error("read a value in", subkey, &err)),
        }
    }

    /// Create the keys if needed, write the Run command and the "enabled" approval flag.
    pub(super) fn write(config: &StartupConfig, command: &str) -> Result<(), StartupError> {
        let root = hkcu();
        let flags = KEY_SET_VALUE | KEY_QUERY_VALUE;
        let (run, _) = root
            .create_subkey_with_flags(&config.run_key, flags)
            .map_err(|err| registry_error("create", &config.run_key, &err))?;
        run.set_value(&config.value_name, &command)
            .map_err(|err| registry_error("write a value in", &config.run_key, &err))?;

        let (approved, _) = root
            .create_subkey_with_flags(&config.approved_key, flags)
            .map_err(|err| registry_error("create", &config.approved_key, &err))?;
        let value = RegValue {
            bytes: Cow::Borrowed(&APPROVED_ENABLED_VALUE),
            vtype: RegType::REG_BINARY,
        };
        approved
            .set_raw_value(&config.value_name, &value)
            .map_err(|err| registry_error("write a value in", &config.approved_key, &err))
    }

    /// Delete both values. Values or keys that are already absent are fine.
    pub(super) fn remove(config: &StartupConfig) -> Result<(), StartupError> {
        let root = hkcu();
        delete_value(&root, &config.run_key, &config.value_name)?;
        delete_value(&root, &config.approved_key, &config.value_name)
    }

    fn delete_value(root: &RegKey, subkey: &str, name: &str) -> Result<(), StartupError> {
        let key = match root.open_subkey_with_flags(subkey, KEY_SET_VALUE) {
            Ok(key) => key,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(registry_error("open", subkey, &err)),
        };
        match key.delete_value(name) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(registry_error("delete a value in", subkey, &err)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CURRENT: &str = r"C:\Program Files\Studio Pulse\Studio Pulse.exe";

    fn registration(command: Option<&str>, approved: Option<&[u8]>) -> Registration {
        Registration {
            run_present: command.is_some(),
            command: command.map(str::to_string),
            approved: approved.map(<[u8]>::to_vec),
        }
    }

    fn disabled_by_task_manager() -> Vec<u8> {
        let mut bytes = vec![0x03, 0, 0, 0];
        bytes.extend_from_slice(&0x01DC_4A2B_1234_5678_u64.to_le_bytes());
        bytes
    }

    #[test]
    fn command_line_quotes_the_path_and_appends_the_flag() {
        assert_eq!(
            command_line(Path::new(CURRENT)),
            r#""C:\Program Files\Studio Pulse\Studio Pulse.exe" --autostart"#
        );
    }

    #[test]
    fn launched_at_login_detects_the_flag() {
        assert!(launched_at_login(["studio-pulse.exe", "--autostart"]));
        assert!(!launched_at_login(["studio-pulse.exe"]));
        assert!(!launched_at_login(["studio-pulse.exe", "--autostart=1"]));
        assert!(!launched_at_login(Vec::<String>::new()));
    }

    #[test]
    fn approved_flag_uses_the_low_bit_of_the_first_byte() {
        assert_eq!(approved_state(&APPROVED_ENABLED_VALUE), Some(true));
        assert_eq!(approved_state(&[0x06, 0, 0]), Some(true));
        assert_eq!(approved_state(&disabled_by_task_manager()), Some(false));
        assert_eq!(approved_state(&[0x07]), Some(false));
        assert_eq!(approved_state(&[0x01]), Some(false));
        assert_eq!(approved_state(&[]), None);
    }

    #[test]
    fn command_executable_parsing() {
        let cases = [
            (
                r#""C:\A B\Studio Pulse.exe" --autostart"#,
                Some(r"C:\A B\Studio Pulse.exe"),
            ),
            (r#"  "C:\A\app.exe""#, Some(r"C:\A\app.exe")),
            (r#""C:\A\app.exe"#, None), // unterminated quote
            (r#""" --autostart"#, None),
            (
                r"C:\A B\Studio Pulse.exe --autostart",
                Some(r"C:\A B\Studio Pulse.exe"),
            ),
            (r"C:\A\app.EXE", Some(r"C:\A\app.EXE")),
            (r"C:\x.exed\app.exe -x", Some(r"C:\x.exed\app.exe")),
            (r"C:\A\app --autostart", Some(r"C:\A\app")),
            ("", None),
            ("   ", None),
        ];
        for (command, expected) in cases {
            assert_eq!(command_executable(command), expected, "{command:?}");
        }
    }

    #[test]
    fn executable_comparison_ignores_case_separators_and_verbatim_prefix() {
        let current = Path::new(CURRENT);
        assert!(same_executable(Path::new(CURRENT), current));
        assert!(same_executable(
            Path::new(r"c:\program files\studio pulse\STUDIO PULSE.EXE"),
            current
        ));
        assert!(same_executable(
            Path::new(r"\\?\C:\Program Files\Studio Pulse\Studio Pulse.exe"),
            current
        ));
        assert!(same_executable(
            Path::new("C:/Program Files/Studio Pulse/Studio Pulse.exe"),
            current
        ));
        assert!(!same_executable(
            Path::new(r"D:\Old\Studio Pulse\Studio Pulse.exe"),
            current
        ));
        assert_eq!(
            normalize_path_text(r"\\?\UNC\srv\share\A.exe"),
            r"\\srv\share\a.exe"
        );
        assert_eq!(normalize_path_text(r"\\?\D:\X\Y.EXE"), r"d:\x\y.exe");
        assert_eq!(normalize_path_text("D:/X/y.exe"), r"d:\x\y.exe");
    }

    #[test]
    fn executable_comparison_resolves_real_paths() {
        let exe = std::env::current_exe().expect("current exe");
        assert!(same_executable(&exe, &exe));
        let shouted = exe.to_string_lossy().to_uppercase();
        if cfg!(windows) {
            assert!(same_executable(Path::new(&shouted), &exe));
        }
    }

    #[test]
    fn not_registered() {
        let status = evaluate_with(&registration(None, None), Path::new(CURRENT), false);
        assert_eq!(
            status,
            StartupStatus {
                enabled: false,
                registered: false,
                approved_by_windows: None,
                points_to_current_executable: false,
                command: None,
                is_development_build: false,
                message: None,
            }
        );
        // A leftover approval flag alone does not count as registered.
        let status = evaluate_with(
            &registration(None, Some(&disabled_by_task_manager())),
            Path::new(CURRENT),
            false,
        );
        assert!(!status.registered && !status.enabled);
        assert_eq!(status.approved_by_windows, Some(false));
        assert_eq!(status.message, None);
    }

    #[test]
    fn registered_and_approved_is_enabled() {
        let command = command_line(Path::new(CURRENT));
        let status = evaluate_with(
            &registration(Some(&command), Some(&APPROVED_ENABLED_VALUE)),
            Path::new(CURRENT),
            false,
        );
        assert!(status.enabled && status.registered && status.points_to_current_executable);
        assert_eq!(status.approved_by_windows, Some(true));
        assert_eq!(status.command.as_deref(), Some(command.as_str()));
        assert_eq!(status.message, None);
    }

    #[test]
    fn registered_without_approval_flag_is_enabled() {
        let command = command_line(Path::new(CURRENT));
        let status = evaluate_with(
            &registration(Some(&command), None),
            Path::new(CURRENT),
            false,
        );
        assert!(status.enabled);
        assert_eq!(status.approved_by_windows, None);
    }

    #[test]
    fn disabled_by_windows_is_explained() {
        let command = command_line(Path::new(CURRENT));
        let status = evaluate_with(
            &registration(Some(&command), Some(&disabled_by_task_manager())),
            Path::new(CURRENT),
            false,
        );
        assert!(status.registered && !status.enabled);
        assert_eq!(status.approved_by_windows, Some(false));
        let message = status.message.expect("message");
        assert!(
            message.contains("Windows has disabled Studio Pulse"),
            "{message}"
        );
    }

    #[test]
    fn other_copy_is_explained() {
        let other = r#""D:\Portable\Studio Pulse.exe" --autostart"#;
        let status = evaluate_with(
            &registration(Some(other), Some(&APPROVED_ENABLED_VALUE)),
            Path::new(CURRENT),
            false,
        );
        assert!(status.registered && !status.enabled && !status.points_to_current_executable);
        let message = status.message.expect("message");
        assert!(
            message.contains(r"Registered for a different copy at D:\Portable\Studio Pulse.exe"),
            "{message}"
        );
        assert!(!message.contains("development build"));

        let dev = evaluate_with(&registration(Some(other), None), Path::new(CURRENT), true);
        assert!(dev.is_development_build);
        assert!(dev.message.expect("message").contains("development build"));
    }

    #[test]
    fn unparseable_or_non_text_command_is_explained() {
        let status = evaluate_with(&registration(Some(""), None), Path::new(CURRENT), false);
        assert!(status.registered && !status.enabled);
        assert!(status
            .message
            .expect("message")
            .contains("does not recognise"));

        let non_text = Registration {
            run_present: true,
            command: None,
            approved: None,
        };
        let status = evaluate_with(&non_text, Path::new(CURRENT), false);
        assert!(status.registered && !status.enabled && status.command.is_none());
        assert!(status.message.is_some());
    }

    #[test]
    fn development_flag_follows_the_build_profile() {
        let status = evaluate(&registration(None, None), Path::new(CURRENT));
        assert_eq!(status.is_development_build, cfg!(debug_assertions));
    }

    #[test]
    fn enable_verification() {
        let command = command_line(Path::new(CURRENT));
        let good = registration(Some(&command), Some(&APPROVED_ENABLED_VALUE));
        assert_eq!(verify_enabled(&good, &command), Ok(()));

        let other_command = registration(
            Some("\"C:\\x.exe\" --autostart"),
            Some(&APPROVED_ENABLED_VALUE),
        );
        assert!(verify_enabled(&other_command, &command).is_err());
        // Exact comparison: a case difference is a mismatch.
        let case_changed =
            registration(Some(&command.to_uppercase()), Some(&APPROVED_ENABLED_VALUE));
        assert!(verify_enabled(&case_changed, &command).is_err());
        let missing_run = registration(None, Some(&APPROVED_ENABLED_VALUE));
        assert!(verify_enabled(&missing_run, &command).is_err());
        let non_text = Registration {
            run_present: true,
            command: None,
            approved: Some(APPROVED_ENABLED_VALUE.to_vec()),
        };
        assert!(verify_enabled(&non_text, &command).is_err());
        let still_disabled = registration(Some(&command), Some(&disabled_by_task_manager()));
        assert!(verify_enabled(&still_disabled, &command)
            .expect_err("disabled")
            .contains("disabled"));
        let missing_flag = registration(Some(&command), None);
        assert!(verify_enabled(&missing_flag, &command).is_err());
        let empty_flag = registration(Some(&command), Some(&[]));
        assert!(verify_enabled(&empty_flag, &command).is_err());
    }

    #[test]
    fn disable_verification() {
        assert_eq!(verify_removed(&Registration::default()), Ok(()));
        let command = command_line(Path::new(CURRENT));
        assert!(verify_removed(&registration(Some(&command), None)).is_err());
        assert!(verify_removed(&registration(None, Some(&APPROVED_ENABLED_VALUE))).is_err());
    }

    #[test]
    fn status_serializes_in_camel_case() {
        let status = evaluate_with(&registration(None, None), Path::new(CURRENT), true);
        let json = serde_json::to_value(&status).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "enabled": false,
                "registered": false,
                "approvedByWindows": null,
                "pointsToCurrentExecutable": false,
                "command": null,
                "isDevelopmentBuild": true,
                "message": null,
            })
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_is_unsupported() {
        let config = StartupConfig::default();
        assert!(matches!(
            status(&config, Path::new(CURRENT)),
            Err(StartupError::Unsupported)
        ));
    }
}
