//! User settings. Serialized shape = `Settings` / `SettingsPatch` in shared-types.
//!
//! Stored documents are read leniently (missing fields take defaults, unknown fields are
//! ignored) so older files keep working. Patches from the UI are strict: unknown fields are
//! rejected and every value is range-checked here, whatever the UI already checked.

use serde::{Deserialize, Serialize};

use crate::tracker::EngineConfig;

pub const IDLE_TIMEOUT_MINUTES: (u32, u32) = (1, 120);
pub const CHECKPOINT_SECONDS: (u32, u32) = (5, 300);
pub const MINIMUM_INTERVAL_SECONDS: (u32, u32) = (0, 60);

/// Gap between samples above which time is never credited (sleep, hang). Not user-configurable.
pub const MAX_SAMPLE_GAP_MS: u64 = 15_000;
/// Allowed wall-vs-monotonic disagreement before a clock change is assumed.
pub const CLOCK_TOLERANCE_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    Dark,
    Light,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GeneralSettings {
    pub theme: ThemePreference,
    pub start_minimized: bool,
    pub minimize_to_tray: bool,
    pub launch_full_window_on_startup: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            theme: ThemePreference::Dark,
            start_minimized: true,
            minimize_to_tray: true,
            launch_full_window_on_startup: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackingSettings {
    pub enabled: bool,
    pub start_automatically: bool,
    pub pause_when_idle: bool,
    pub idle_timeout_minutes: u32,
    pub notifications: bool,
    pub checkpoint_seconds: u32,
    pub minimum_interval_seconds: u32,
}

impl Default for TrackingSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            start_automatically: true,
            pause_when_idle: true,
            idle_timeout_minutes: 5,
            notifications: true,
            checkpoint_seconds: 15,
            minimum_interval_seconds: 2,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OnboardingState {
    pub completed: bool,
    /// ISO-8601 UTC.
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub general: GeneralSettings,
    pub tracking: TrackingSettings,
    pub onboarding: OnboardingState,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneralPatch {
    pub theme: Option<ThemePreference>,
    pub start_minimized: Option<bool>,
    pub minimize_to_tray: Option<bool>,
    pub launch_full_window_on_startup: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackingPatch {
    pub enabled: Option<bool>,
    pub start_automatically: Option<bool>,
    pub pause_when_idle: Option<bool>,
    pub idle_timeout_minutes: Option<u32>,
    pub notifications: Option<bool>,
    pub checkpoint_seconds: Option<u32>,
    pub minimum_interval_seconds: Option<u32>,
}

/// Payload of `update_settings`. Onboarding is changed only by `complete_onboarding`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    pub general: Option<GeneralPatch>,
    pub tracking: Option<TrackingPatch>,
}

fn check_range(name: &str, value: u32, (min, max): (u32, u32)) -> Result<(), String> {
    if (min..=max).contains(&value) {
        Ok(())
    } else {
        Err(format!("{name} must be between {min} and {max} (got {value})"))
    }
}

impl Settings {
    /// Range-check every numeric field.
    pub fn validate(&self) -> Result<(), String> {
        let t = &self.tracking;
        check_range("idleTimeoutMinutes", t.idle_timeout_minutes, IDLE_TIMEOUT_MINUTES)?;
        check_range("checkpointSeconds", t.checkpoint_seconds, CHECKPOINT_SECONDS)?;
        check_range(
            "minimumIntervalSeconds",
            t.minimum_interval_seconds,
            MINIMUM_INTERVAL_SECONDS,
        )?;
        Ok(())
    }

    /// Return a copy with `patch` applied, or an error if the result is invalid.
    pub fn apply_patch(&self, patch: &SettingsPatch) -> Result<Settings, String> {
        let mut next = self.clone();
        if let Some(g) = &patch.general {
            if let Some(v) = g.theme {
                next.general.theme = v;
            }
            if let Some(v) = g.start_minimized {
                next.general.start_minimized = v;
            }
            if let Some(v) = g.minimize_to_tray {
                next.general.minimize_to_tray = v;
            }
            if let Some(v) = g.launch_full_window_on_startup {
                next.general.launch_full_window_on_startup = v;
            }
        }
        if let Some(t) = &patch.tracking {
            if let Some(v) = t.enabled {
                next.tracking.enabled = v;
            }
            if let Some(v) = t.start_automatically {
                next.tracking.start_automatically = v;
            }
            if let Some(v) = t.pause_when_idle {
                next.tracking.pause_when_idle = v;
            }
            if let Some(v) = t.idle_timeout_minutes {
                next.tracking.idle_timeout_minutes = v;
            }
            if let Some(v) = t.notifications {
                next.tracking.notifications = v;
            }
            if let Some(v) = t.checkpoint_seconds {
                next.tracking.checkpoint_seconds = v;
            }
            if let Some(v) = t.minimum_interval_seconds {
                next.tracking.minimum_interval_seconds = v;
            }
        }
        next.validate()?;
        Ok(next)
    }

    /// Engine tuning derived from these settings.
    pub fn engine_config(&self) -> EngineConfig {
        EngineConfig {
            idle_detection: self.tracking.pause_when_idle,
            idle_threshold_ms: u64::from(self.tracking.idle_timeout_minutes) * 60_000,
            min_interval_ms: u64::from(self.tracking.minimum_interval_seconds) * 1_000,
            max_gap_ms: MAX_SAMPLE_GAP_MS,
            clock_tolerance_ms: CLOCK_TOLERANCE_MS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid_and_match_shared_types() {
        let s = Settings::default();
        s.validate().unwrap();
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["general"]["theme"], "dark");
        assert_eq!(json["general"]["startMinimized"], true);
        assert_eq!(json["tracking"]["idleTimeoutMinutes"], 5);
        assert_eq!(json["tracking"]["checkpointSeconds"], 15);
        assert_eq!(json["tracking"]["minimumIntervalSeconds"], 2);
        assert_eq!(json["onboarding"]["completed"], false);
    }

    #[test]
    fn stored_documents_are_read_leniently() {
        let s: Settings =
            serde_json::from_str(r#"{"tracking":{"idleTimeoutMinutes":9},"futureField":1}"#)
                .unwrap();
        assert_eq!(s.tracking.idle_timeout_minutes, 9);
        assert_eq!(s.general, GeneralSettings::default());
    }

    #[test]
    fn patches_reject_unknown_fields_and_bad_ranges() {
        assert!(serde_json::from_str::<SettingsPatch>(r#"{"tracking":{"bogus":true}}"#).is_err());
        assert!(serde_json::from_str::<SettingsPatch>(r#"{"onboarding":{}}"#).is_err());
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"tracking":{"idleTimeoutMinutes":0}}"#).unwrap();
        assert!(Settings::default().apply_patch(&patch).is_err());
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"tracking":{"idleTimeoutMinutes":10,"pauseWhenIdle":false}}"#)
                .unwrap();
        let next = Settings::default().apply_patch(&patch).unwrap();
        assert_eq!(next.engine_config().idle_threshold_ms, 600_000);
        assert!(!next.engine_config().idle_detection);
    }
}
