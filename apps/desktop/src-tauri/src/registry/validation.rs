//! Input validation for application definitions. Mirrors `exePatternError` and
//! `validateApplicationInput` in `@studio-pulse/validation`: the UI validates first, and the
//! Rust core re-validates everything it receives from the webview.
//!
//! Lengths are counted in UTF-16 code units, the same unit as JavaScript's `String.length`, so
//! both sides accept and reject exactly the same strings.

use super::{ApplicationInput, ProcessMatcher};

/// Longest accepted exe pattern or path fragment (Win32 `MAX_PATH`).
pub(super) const MAX_PATTERN_LEN: usize = 260;
/// Most `*` wildcards allowed in one exe pattern.
pub(super) const MAX_WILDCARDS: usize = 4;
/// Longest accepted display name.
pub(super) const MAX_DISPLAY_NAME_LEN: usize = 80;
/// Most matchers allowed on one application.
pub(super) const MAX_MATCHERS: usize = 16;
/// Shortest and longest application id (`^[a-z0-9][a-z0-9-]{1,63}$`).
const ID_LEN: (usize, usize) = (2, 64);
const EXE_SUFFIX: &str = ".exe";

/// See [`super::validate_matcher`].
pub(super) fn validate_matcher(matcher: &ProcessMatcher) -> Result<(), String> {
    let exe = matcher.exe.trim();
    let len = utf16_len(exe);
    if len == 0 {
        return Err("Executable name is required.".to_string());
    }
    if len > MAX_PATTERN_LEN {
        return Err(format!(
            "Executable name must be at most {MAX_PATTERN_LEN} characters."
        ));
    }
    if exe.contains(['\\', '/', ':']) {
        return Err(
            "Executable name must be a file name such as Photoshop.exe, not a path.".to_string(),
        );
    }
    let Some(stem) = strip_exe_suffix(exe) else {
        return Err("Executable name must end with .exe.".to_string());
    };
    if exe.matches('*').count() > MAX_WILDCARDS {
        return Err(format!(
            "Executable name can contain at most {MAX_WILDCARDS} * wildcards."
        ));
    }
    if stem.chars().all(|c| c == '*') {
        return Err(
            "Executable name must include at least one character besides * before .exe."
                .to_string(),
        );
    }
    if let Some(fragment) = &matcher.path_includes {
        let len = utf16_len(fragment.trim());
        if len == 0 {
            return Err("Path filter must not be empty when it is set.".to_string());
        }
        if len > MAX_PATTERN_LEN {
            return Err(format!(
                "Path filter must be at most {MAX_PATTERN_LEN} characters."
            ));
        }
    }
    Ok(())
}

/// See [`super::validate_input`].
pub(super) fn validate_input(input: &ApplicationInput) -> Result<(), String> {
    if let Some(id) = &input.id {
        if !is_valid_id(id) {
            return Err(
                "Application id must be 2–64 characters of a–z, 0–9 and -, starting with a letter or digit."
                    .to_string(),
            );
        }
    }
    let name_len = utf16_len(input.display_name.trim());
    if name_len == 0 {
        return Err("Display name is required.".to_string());
    }
    if name_len > MAX_DISPLAY_NAME_LEN {
        return Err(format!(
            "Display name must be at most {MAX_DISPLAY_NAME_LEN} characters."
        ));
    }
    if input.matchers.is_empty() {
        return Err("Add at least one executable to identify the application.".to_string());
    }
    if input.matchers.len() > MAX_MATCHERS {
        return Err(format!(
            "An application can have at most {MAX_MATCHERS} executables."
        ));
    }
    for (index, matcher) in input.matchers.iter().enumerate() {
        validate_matcher(matcher).map_err(|err| format!("Executable {}: {err}", index + 1))?;
    }
    Ok(())
}

/// `^[a-z0-9][a-z0-9-]{1,63}$` without a regex engine.
pub(super) fn is_valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    let starts_well = bytes
        .first()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    (ID_LEN.0..=ID_LEN.1).contains(&bytes.len())
        && starts_well
        && bytes
            .iter()
            .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The part of `exe` before a case-insensitive `.exe` suffix, or `None` without the suffix.
fn strip_exe_suffix(exe: &str) -> Option<&str> {
    let split = exe.len().checked_sub(EXE_SUFFIX.len())?;
    let (stem, suffix) = (exe.get(..split)?, exe.get(split..)?);
    suffix.eq_ignore_ascii_case(EXE_SUFFIX).then_some(stem)
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}
