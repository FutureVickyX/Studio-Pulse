//! Links from the desktop to the team workspace (`apps/web`, docs/workspace.md).
//!
//! The workspace is a web app; the desktop only opens it in the default browser. The base URL is
//! fixed at build time (`STUDIO_PULSE_WORKSPACE_URL`) and validated here, and every link is that
//! base plus a fixed route. The webview names a section, never a URL, so it can never make the app
//! open an arbitrary address or program.

use serde::Deserialize;

/// The build-time variable (debug builds also read it at runtime, like the Supabase settings).
pub const WORKSPACE_URL_ENV: &str = "STUDIO_PULSE_WORKSPACE_URL";

/// Where a link lands in the workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceSection {
    Overview,
    Projects,
    Tasks,
    Notes,
    Time,
}

impl WorkspaceSection {
    /// The workspace's hash route (apps/web/src/lib/router.ts).
    fn route(self) -> &'static str {
        match self {
            Self::Overview => "#/",
            Self::Projects => "#/projects",
            Self::Tasks => "#/tasks",
            Self::Notes => "#/notes",
            Self::Time => "#/time",
        }
    }
}

/// `https://…`, or plain `http://` on this computer only; no credentials, query or fragment. The
/// returned base has no trailing slash.
pub fn validate_base(raw: &str) -> Result<String, &'static str> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| "not a URL")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        _ => return Err("must be https (or http on localhost)"),
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("has no host");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("must not contain credentials");
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("must not contain a query or fragment");
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

/// The configured base URL, if any and valid (an invalid value is logged once and ignored).
pub fn configured_base() -> Option<String> {
    let raw = option_env!("STUDIO_PULSE_WORKSPACE_URL")
        .map(str::to_owned)
        .or_else(|| {
            if cfg!(debug_assertions) {
                std::env::var(WORKSPACE_URL_ENV).ok()
            } else {
                None
            }
        })
        .filter(|value| !value.trim().is_empty())?;
    match validate_base(&raw) {
        Ok(base) => Some(base),
        Err(reason) => {
            log::warn!("{WORKSPACE_URL_ENV} ignored: {reason}");
            None
        }
    }
}

pub fn link(base: &str, section: WorkspaceSection) -> String {
    format!("{base}/{}", section.route())
}

/// Open `url` (a validated workspace link) in the default browser.
#[cfg(windows)]
pub fn open_in_browser(url: &str) -> Result<(), String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let target = HSTRING::from(url);
    // SAFETY: every pointer is a NUL-terminated UTF-16 string that outlives the call; the other
    // arguments are null. ShellExecuteW copies what it needs.
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &target,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // Values above 32 mean success (documented HINSTANCE convention).
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!(
            "Windows could not open the browser (code {})",
            result.0 as isize
        ))
    }
}

#[cfg(not(windows))]
pub fn open_in_browser(_url: &str) -> Result<(), String> {
    Err("opening the browser is only implemented on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_and_local_http() {
        assert_eq!(
            validate_base("https://studio.example.com/").as_deref(),
            Ok("https://studio.example.com")
        );
        assert_eq!(
            validate_base(" https://studio.example.com/team/ ").as_deref(),
            Ok("https://studio.example.com/team")
        );
        assert_eq!(
            validate_base("http://localhost:5180").as_deref(),
            Ok("http://localhost:5180")
        );
        assert_eq!(
            validate_base("http://127.0.0.1:5180/").as_deref(),
            Ok("http://127.0.0.1:5180")
        );
    }

    #[test]
    fn refuses_anything_else() {
        for bad in [
            "",
            "studio.example.com",
            "http://studio.example.com",
            "ftp://studio.example.com",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "https://user:pass@studio.example.com",
            "https://studio.example.com/?x=1",
            "https://studio.example.com/#/tasks",
            "C:\\Windows\\System32\\calc.exe",
        ] {
            assert!(validate_base(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn links_are_the_base_plus_a_fixed_route() {
        let base = "https://studio.example.com";
        assert_eq!(
            link(base, WorkspaceSection::Overview),
            "https://studio.example.com/#/"
        );
        assert_eq!(
            link(base, WorkspaceSection::Tasks),
            "https://studio.example.com/#/tasks"
        );
        assert_eq!(
            link(base, WorkspaceSection::Projects),
            "https://studio.example.com/#/projects"
        );
        assert_eq!(
            link(base, WorkspaceSection::Notes),
            "https://studio.example.com/#/notes"
        );
        assert_eq!(
            link(base, WorkspaceSection::Time),
            "https://studio.example.com/#/time"
        );
    }

    #[test]
    fn sections_deserialize_from_camel_case_only() {
        assert_eq!(
            serde_json::from_str::<WorkspaceSection>("\"tasks\"").unwrap(),
            WorkspaceSection::Tasks
        );
        assert!(serde_json::from_str::<WorkspaceSection>("\"https://evil.example\"").is_err());
    }
}
