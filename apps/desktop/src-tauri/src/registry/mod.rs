//! Application registry: which processes count as which creative application.
//!
//! Defaults come from `packages/shared-types/data/default-applications.json` (shared with the
//! TypeScript packages). Matching rules: docs/architecture.md §5.

use serde::{Deserialize, Serialize};

use crate::platform::ProcessInfo;
use crate::tracker::TrackedApp;

/// The built-in registry, embedded at compile time.
pub const DEFAULT_APPLICATIONS_JSON: &str =
    include_str!("../../../../../packages/shared-types/data/default-applications.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AppCategory {
    #[serde(rename = "design")]
    Design,
    #[serde(rename = "motion")]
    Motion,
    #[serde(rename = "video")]
    Video,
    #[serde(rename = "3d")]
    ThreeD,
    #[serde(rename = "photo")]
    Photo,
    #[serde(rename = "audio")]
    Audio,
    #[serde(rename = "publishing")]
    Publishing,
    #[serde(rename = "code")]
    Code,
    #[serde(rename = "other")]
    Other,
}

impl AppCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Design => "design",
            Self::Motion => "motion",
            Self::Video => "video",
            Self::ThreeD => "3d",
            Self::Photo => "photo",
            Self::Audio => "audio",
            Self::Publishing => "publishing",
            Self::Code => "code",
            Self::Other => "other",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "design" => Self::Design,
            "motion" => Self::Motion,
            "video" => Self::Video,
            "3d" => Self::ThreeD,
            "photo" => Self::Photo,
            "audio" => Self::Audio,
            "publishing" => Self::Publishing,
            "code" => Self::Code,
            "other" => Self::Other,
            _ => return None,
        })
    }
}

/// Identifies a process: `exe` (case-insensitive, `*` wildcard) and optional `path_includes`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMatcher {
    pub exe: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_includes: Option<String>,
}

/// Entry in the embedded defaults file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultApplication {
    pub id: String,
    pub display_name: String,
    pub category: AppCategory,
    pub enabled_by_default: bool,
    pub matchers: Vec<ProcessMatcher>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultApplicationsFile {
    pub version: u32,
    pub applications: Vec<DefaultApplication>,
}

/// An application as stored locally. Serialized shape = `ApplicationDefinition` in shared-types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDefinition {
    pub id: String,
    pub display_name: String,
    pub category: AppCategory,
    pub matchers: Vec<ProcessMatcher>,
    pub enabled: bool,
    pub include_in_reports: bool,
    pub built_in: bool,
    pub sort_order: i64,
    /// ISO-8601 UTC.
    pub created_at: String,
    /// ISO-8601 UTC.
    pub updated_at: String,
}

/// Payload of `save_application`. `id: None` creates a custom application.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationInput {
    pub id: Option<String>,
    pub display_name: String,
    pub category: AppCategory,
    pub matchers: Vec<ProcessMatcher>,
    pub enabled: bool,
    pub include_in_reports: bool,
}

/// Result of matching a process against the registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchOutcome<'a> {
    /// Best match is an enabled application: record it.
    Tracked(&'a ApplicationDefinition),
    /// Best match is a disabled application: do not record (no fall-through).
    Disabled(&'a ApplicationDefinition),
    /// No application matches.
    Unknown,
}

/// The in-memory registry used by the tracker for every sample.
#[derive(Debug, Clone, Default)]
pub struct Registry {
    apps: Vec<ApplicationDefinition>,
}

impl Registry {
    pub fn new(apps: Vec<ApplicationDefinition>) -> Self {
        Self { apps }
    }

    pub fn apps(&self) -> &[ApplicationDefinition] {
        &self.apps
    }

    pub fn get(&self, id: &str) -> Option<&ApplicationDefinition> {
        self.apps.iter().find(|app| app.id == id)
    }

    /// Best match for a process image. Precedence: `path_includes` matcher > exact exe >
    /// wildcard exe; ties → user-defined over built-in, then lower `sort_order`, then id.
    pub fn match_process(&self, _exe_name: &str, _exe_path: &str) -> MatchOutcome<'_> {
        todo!("registry.match_process")
    }

    /// Convenience for the tracker: `Some` only for [`MatchOutcome::Tracked`].
    pub fn tracked_app(&self, process: &ProcessInfo) -> Option<TrackedApp> {
        match self.match_process(&process.exe_name, &process.exe_path) {
            MatchOutcome::Tracked(app) => Some(TrackedApp {
                application_id: app.id.clone(),
                application_name: app.display_name.clone(),
            }),
            MatchOutcome::Disabled(_) | MatchOutcome::Unknown => None,
        }
    }
}

/// Parse the embedded defaults. Panics only if the compiled-in JSON is invalid, which the
/// registry unit tests rule out.
pub fn default_applications() -> Vec<DefaultApplication> {
    todo!("registry::default_applications")
}

/// Does `matcher` accept this process image? Case-insensitive; `*` matches any run of characters.
pub fn matcher_matches(_matcher: &ProcessMatcher, _exe_name: &str, _exe_path: &str) -> bool {
    todo!("registry::matcher_matches")
}

/// Validate a matcher with the same rules as `exePatternError` in `@studio-pulse/validation`.
pub fn validate_matcher(_matcher: &ProcessMatcher) -> Result<(), String> {
    todo!("registry::validate_matcher")
}

/// Validate a `save_application` payload (display name 1–80 chars trimmed, 1–16 valid matchers,
/// id pattern `^[a-z0-9][a-z0-9-]{1,63}$` when present).
pub fn validate_input(_input: &ApplicationInput) -> Result<(), String> {
    todo!("registry::validate_input")
}
