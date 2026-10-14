//! Launch-at-login registration against a real registry, using SCRATCH keys only.
//!
//! Every test points [`StartupConfig`] at `HKCU\Software\StudioPulseTests\<unique>\...` and
//! deletes that tree when it finishes (even on panic). The real
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` key is never opened.
#![cfg(windows)]

use std::borrow::Cow;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};

use studio_pulse_lib::startup::{
    command_line, disable, enable, status, StartupConfig, StartupError, APPROVED_ENABLED_VALUE,
};
use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_READ};
use winreg::types::FromRegValue;
use winreg::{RegKey, RegValue};

const SCRATCH_ROOT: &str = r"Software\StudioPulseTests";
const VALUE_NAME: &str = "Studio Pulse";

/// Serializes the tests in this binary so that removing the (then empty) shared scratch root
/// can never race with another test creating its own subtree.
static REGISTRY_LOCK: Mutex<()> = Mutex::new(());
static NEXT_ID: AtomicU32 = AtomicU32::new(0);

/// A unique scratch registration that removes its registry tree on drop.
struct Scratch {
    base: String,
    config: StartupConfig,
    _lock: MutexGuard<'static, ()>,
}

impl Scratch {
    fn new(test: &str) -> Self {
        let lock = REGISTRY_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let unique = format!(
            "{test}-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        );
        let base = format!(r"{SCRATCH_ROOT}\{unique}");
        assert!(
            base.starts_with(r"Software\StudioPulseTests\"),
            "scratch keys must stay under the test root"
        );
        let config = StartupConfig {
            run_key: format!(r"{base}\Run"),
            approved_key: format!(r"{base}\StartupApproved\Run"),
            value_name: VALUE_NAME.to_string(),
        };
        Self {
            base,
            config,
            _lock: lock,
        }
    }

    fn hkcu() -> RegKey {
        RegKey::predef(HKEY_CURRENT_USER)
    }

    /// Raw value under `subkey`, or `None` when the key or the value is absent.
    fn raw(subkey: &str, name: &str) -> Option<RegValue<'static>> {
        let key = match Self::hkcu().open_subkey_with_flags(subkey, KEY_READ) {
            Ok(key) => key,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return None,
            Err(err) => panic!("open {subkey}: {err}"),
        };
        match key.get_raw_value(name) {
            Ok(value) => Some(value),
            Err(err) if err.kind() == io::ErrorKind::NotFound => None,
            Err(err) => panic!("read {subkey}\\{name}: {err}"),
        }
    }

    fn run_value(&self) -> Option<RegValue<'static>> {
        Self::raw(&self.config.run_key, &self.config.value_name)
    }

    fn approved_value(&self) -> Option<RegValue<'static>> {
        Self::raw(&self.config.approved_key, &self.config.value_name)
    }

    fn write_run(&self, name: &str, command: &str) {
        let (key, _) = Self::hkcu()
            .create_subkey(&self.config.run_key)
            .expect("create scratch Run key");
        key.set_value(name, &command)
            .expect("write scratch Run value");
    }

    fn write_approved(&self, bytes: &[u8]) {
        let (key, _) = Self::hkcu()
            .create_subkey(&self.config.approved_key)
            .expect("create scratch StartupApproved key");
        let value = RegValue {
            bytes: Cow::Borrowed(bytes),
            vtype: RegType::REG_BINARY,
        };
        key.set_raw_value(&self.config.value_name, &value)
            .expect("write scratch StartupApproved value");
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let hkcu = Self::hkcu();
        if let Err(err) = hkcu.delete_subkey_all(&self.base) {
            if err.kind() != io::ErrorKind::NotFound {
                eprintln!("could not delete scratch key {}: {err}", self.base);
            }
        }
        // Remove the shared root once it is empty; this fails harmlessly while other subkeys
        // exist (e.g. left behind by a killed run).
        let _ = hkcu.delete_subkey(SCRATCH_ROOT);
    }
}

fn current_exe() -> PathBuf {
    std::env::current_exe().expect("current exe")
}

/// What Task Manager writes when the user disables a startup entry: flags `0x03` (padded to a
/// DWORD) followed by the FILETIME at which it was disabled.
fn task_manager_disabled_value() -> Vec<u8> {
    let mut bytes = vec![0x03, 0x00, 0x00, 0x00];
    bytes.extend_from_slice(&0x01DC_3B5E_9A7C_4F20_u64.to_le_bytes());
    bytes
}

#[test]
fn fresh_scratch_key_is_not_registered() {
    let scratch = Scratch::new("fresh");
    let exe = current_exe();
    let status = status(&scratch.config, &exe).expect("status");
    assert!(!status.registered);
    assert!(!status.enabled);
    assert_eq!(status.approved_by_windows, None);
    assert!(!status.points_to_current_executable);
    assert_eq!(status.command, None);
    assert_eq!(status.message, None);
    assert_eq!(status.is_development_build, cfg!(debug_assertions));
}

#[test]
fn enable_writes_the_exact_command_and_approves() {
    let scratch = Scratch::new("enable");
    let exe = current_exe();
    let status = enable(&scratch.config, &exe).expect("enable");
    let expected = command_line(&exe);

    assert!(status.registered);
    assert!(status.enabled, "{status:?}");
    assert!(status.points_to_current_executable);
    assert_eq!(status.approved_by_windows, Some(true));
    assert_eq!(status.command.as_deref(), Some(expected.as_str()));
    assert_eq!(status.message, None);

    // Read back independently of the module under test.
    let run = scratch.run_value().expect("Run value present");
    assert_eq!(run.vtype, RegType::REG_SZ);
    assert_eq!(String::from_reg_value(&run).expect("string"), expected);
    assert!(expected.starts_with('"') && expected.ends_with("\" --autostart"));
    let approved = scratch
        .approved_value()
        .expect("StartupApproved value present");
    assert_eq!(approved.vtype, RegType::REG_BINARY);
    assert_eq!(approved.bytes.as_ref(), APPROVED_ENABLED_VALUE.as_slice());

    // Enabling twice is idempotent.
    let again = enable(&scratch.config, &exe).expect("enable again");
    assert_eq!(again, status);
}

#[test]
fn enable_round_trips_paths_with_spaces_and_non_ascii() {
    let scratch = Scratch::new("unicode");
    let exe = Path::new(r"C:\Program Files\Studio Pulse Ünïcødé 工作室\Studio Pulse.exe");
    let status = enable(&scratch.config, exe).expect("enable");
    assert!(status.enabled, "{status:?}");
    assert_eq!(status.command, Some(command_line(exe)));
}

#[test]
fn task_manager_disable_is_reported_and_enable_reapproves() {
    let scratch = Scratch::new("taskmgr");
    let exe = current_exe();
    enable(&scratch.config, &exe).expect("enable");

    scratch.write_approved(&task_manager_disabled_value());
    let status = status(&scratch.config, &exe).expect("status");
    assert!(status.registered);
    assert!(!status.enabled);
    assert!(status.points_to_current_executable);
    assert_eq!(status.approved_by_windows, Some(false));
    let message = status.message.expect("a disabled entry is explained");
    assert!(message.contains("Windows"), "{message}");

    let status = enable(&scratch.config, &exe).expect("re-enable");
    assert!(status.enabled, "{status:?}");
    assert_eq!(status.approved_by_windows, Some(true));
    let approved = scratch
        .approved_value()
        .expect("StartupApproved value present");
    assert_eq!(approved.bytes.first(), Some(&0x02));
}

#[test]
fn registration_for_another_executable_is_flagged() {
    let scratch = Scratch::new("other-exe");
    let exe = current_exe();
    let other = r#""C:\Somewhere Else\Studio Pulse\Studio Pulse.exe" --autostart"#;
    scratch.write_run(VALUE_NAME, other);

    let status = status(&scratch.config, &exe).expect("status");
    assert!(status.registered);
    assert!(!status.points_to_current_executable);
    assert!(!status.enabled);
    assert_eq!(status.command.as_deref(), Some(other));
    let message = status.message.expect("a foreign entry is explained");
    assert!(
        message.contains(r"different copy at C:\Somewhere Else\Studio Pulse\Studio Pulse.exe"),
        "{message}"
    );

    // Enabling takes the entry over for this executable.
    let status = enable(&scratch.config, &exe).expect("enable");
    assert!(
        status.enabled && status.points_to_current_executable,
        "{status:?}"
    );
}

#[test]
fn same_executable_with_different_case_still_points_to_current() {
    let scratch = Scratch::new("case");
    let exe = current_exe();
    let shouted = format!(
        "\"{}\" --autostart",
        exe.display().to_string().to_uppercase()
    );
    scratch.write_run(VALUE_NAME, &shouted);
    let status = status(&scratch.config, &exe).expect("status");
    assert!(status.points_to_current_executable, "{status:?}");
    assert!(status.enabled);
}

#[test]
fn disable_removes_both_values() {
    let scratch = Scratch::new("disable");
    let exe = current_exe();
    enable(&scratch.config, &exe).expect("enable");

    let status = disable(&scratch.config, &exe).expect("disable");
    assert!(!status.registered);
    assert!(!status.enabled);
    assert_eq!(status.approved_by_windows, None);
    assert_eq!(status.command, None);
    assert!(scratch.run_value().is_none());
    assert!(scratch.approved_value().is_none());
}

#[test]
fn disable_also_clears_a_windows_disabled_flag() {
    let scratch = Scratch::new("disable-flag");
    let exe = current_exe();
    enable(&scratch.config, &exe).expect("enable");
    scratch.write_approved(&task_manager_disabled_value());

    let status = disable(&scratch.config, &exe).expect("disable");
    assert!(!status.registered);
    assert!(scratch.approved_value().is_none());
}

#[test]
fn disable_when_nothing_is_registered_is_ok() {
    let scratch = Scratch::new("disable-absent");
    let exe = current_exe();
    // Keys missing entirely.
    let status = disable(&scratch.config, &exe).expect("disable without keys");
    assert!(!status.registered && !status.enabled);
    // Keys present, values missing.
    scratch.write_run("Another App", r#""C:\Other\other.exe""#);
    let status = disable(&scratch.config, &exe).expect("disable without values");
    assert!(!status.registered);
}

#[test]
fn enable_and_disable_leave_other_entries_alone() {
    let scratch = Scratch::new("neighbours");
    let exe = current_exe();
    let neighbour = r#""C:\Other\other.exe" /background"#;
    scratch.write_run("Another App", neighbour);

    enable(&scratch.config, &exe).expect("enable");
    disable(&scratch.config, &exe).expect("disable");

    let value = Scratch::raw(&scratch.config.run_key, "Another App").expect("neighbour kept");
    assert_eq!(String::from_reg_value(&value).expect("string"), neighbour);
}

#[test]
fn enable_fails_verification_when_the_read_back_differs() {
    // Point both values at the same registry value: the StartupApproved write then replaces the
    // Run command with binary data, so the read-back cannot match and enable must say so.
    let scratch = Scratch::new("verify");
    let mut config = scratch.config.clone();
    config.approved_key = config.run_key.clone();
    let exe = current_exe();

    match enable(&config, &exe) {
        Err(StartupError::Verification(reason)) => {
            assert!(reason.contains("Run value"), "{reason}");
        }
        other => panic!("expected a verification error, got {other:?}"),
    }
    let status = status(&config, &exe).expect("status");
    assert!(!status.enabled);
}
