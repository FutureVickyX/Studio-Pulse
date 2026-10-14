//! Data types shared by the engine, the tracker service, the store and the command layer.
//!
//! These types are a contract (docs/architecture.md §4). The engine is pure: it consumes
//! [`Sample`]s and produces [`StepOutput`]s, and never touches the OS, the clock or the database.

use serde::{Deserialize, Serialize};

/// UTC milliseconds since the Unix epoch.
pub type EpochMs = i64;

/// Whether an interval represents active work or foreground time without input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntervalKind {
    Active,
    Idle,
}

impl IntervalKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Idle => "idle",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "idle" => Some(Self::Idle),
            _ => None,
        }
    }
}

/// Why an interval was closed. Serialized names match `EndReason` in shared-types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EndReason {
    AppSwitch,
    BecameIdle,
    InputResumed,
    Untracked,
    SessionAway,
    Paused,
    Disabled,
    TimeGap,
    ClockChange,
    Shutdown,
    Recovered,
    SettingsChanged,
}

impl EndReason {
    pub const ALL: [EndReason; 12] = [
        Self::AppSwitch,
        Self::BecameIdle,
        Self::InputResumed,
        Self::Untracked,
        Self::SessionAway,
        Self::Paused,
        Self::Disabled,
        Self::TimeGap,
        Self::ClockChange,
        Self::Shutdown,
        Self::Recovered,
        Self::SettingsChanged,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::AppSwitch => "appSwitch",
            Self::BecameIdle => "becameIdle",
            Self::InputResumed => "inputResumed",
            Self::Untracked => "untracked",
            Self::SessionAway => "sessionAway",
            Self::Paused => "paused",
            Self::Disabled => "disabled",
            Self::TimeGap => "timeGap",
            Self::ClockChange => "clockChange",
            Self::Shutdown => "shutdown",
            Self::Recovered => "recovered",
            Self::SettingsChanged => "settingsChanged",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|reason| reason.as_str() == value)
    }
}

/// Interactive-session state reported by the platform layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    /// Unlocked, connected, no screen saver.
    Active,
    Locked,
    ScreenSaver,
    /// Fast-user-switched away or RDP-disconnected.
    Disconnected,
    /// The OS query failed. Treated as `Active`: we can't know, and the foreground/idle
    /// checks still apply.
    Unknown,
}

impl SessionState {
    /// True when the user cannot be working in a foreground application.
    pub fn is_away(self) -> bool {
        matches!(self, Self::Locked | Self::ScreenSaver | Self::Disconnected)
    }
}

/// A registry application that matched the foreground process.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedApp {
    pub application_id: String,
    pub application_name: String,
}

/// One observation of the system, taken once per poll by the tracker service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    /// System (wall) clock, UTC epoch ms. May jump (NTP, manual change).
    pub wall_ms: EpochMs,
    /// Monotonic clock in ms since the tracker started. Never goes backwards.
    pub mono_ms: u64,
    /// The tracked application in the foreground, or `None` when the foreground app is not an
    /// enabled registry application, or there is no foreground window.
    pub app: Option<TrackedApp>,
    /// Milliseconds since the last keyboard/mouse input.
    pub idle_ms: u64,
    pub session: SessionState,
}

/// A contiguous foreground interval of one application, wholly active or wholly idle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interval {
    /// Stable UUIDv7 assigned when the interval opens. Never changes.
    pub id: String,
    pub application_id: String,
    /// Display-name snapshot taken when the interval opened.
    pub application_name: String,
    pub kind: IntervalKind,
    pub started_at_ms: EpochMs,
    /// The latest observed instant credited to this interval (exclusive end).
    pub ended_at_ms: EpochMs,
    /// True while the interval is still being recorded.
    pub open: bool,
    /// Set exactly when `open` is false.
    pub end_reason: Option<EndReason>,
}

impl Interval {
    pub fn duration_ms(&self) -> i64 {
        (self.ended_at_ms - self.started_at_ms).max(0)
    }

    pub fn active_ms(&self) -> i64 {
        match self.kind {
            IntervalKind::Active => self.duration_ms(),
            IntervalKind::Idle => 0,
        }
    }

    pub fn idle_ms(&self) -> i64 {
        match self.kind {
            IntervalKind::Active => 0,
            IntervalKind::Idle => self.duration_ms(),
        }
    }
}

/// Engine tuning. Derived from `Settings.tracking` by the tracker service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineConfig {
    /// `Settings.tracking.pauseWhenIdle`. When false, time without input counts as active.
    pub idle_detection: bool,
    /// No input for this long marks the user idle. Default 5 min.
    pub idle_threshold_ms: u64,
    /// Closed intervals shorter than this are discarded. Default 2 s.
    pub min_interval_ms: u64,
    /// Larger gaps between consecutive samples are never credited (sleep, hang). Default 15 s.
    pub max_gap_ms: u64,
    /// Allowed disagreement between wall and monotonic deltas before a clock change is assumed.
    /// Default 5 s.
    pub clock_tolerance_ms: u64,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            idle_detection: true,
            idle_threshold_ms: 5 * 60 * 1000,
            min_interval_ms: 2_000,
            max_gap_ms: 15_000,
            clock_tolerance_ms: 5_000,
        }
    }
}

/// What the engine believes is happening right now (drives `TrackerStatus.state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineActivity {
    /// No sample processed since start or resume.
    Starting,
    /// An active interval is open.
    Tracking,
    /// An idle interval is open.
    Idle,
    /// The foreground app is not tracked.
    Untracked,
    /// Session locked, screen saver or disconnected.
    Away,
    Paused,
    /// The wall clock is behind the high-water mark; recording holds until it catches up.
    ClockBehind,
}

/// Effects of one engine call that the caller must persist.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StepOutput {
    /// Intervals to upsert now: every interval closed by this call (if at least the minimum
    /// length), plus the open interval when it changed structurally and is already at least the
    /// minimum length.
    pub persist: Vec<Interval>,
    /// Ids of intervals that were discarded (shorter than the minimum). If the store holds one
    /// of them as `open`, delete it. Closed rows are never deleted.
    pub discard: Vec<String>,
}

impl StepOutput {
    pub fn is_empty(&self) -> bool {
        self.persist.is_empty() && self.discard.is_empty()
    }

    pub fn merge(&mut self, other: StepOutput) {
        self.persist.extend(other.persist);
        self.discard.extend(other.discard);
    }
}

/// Source of interval ids. Production uses UUIDv7; tests use deterministic ids.
pub trait IdSource: Send {
    fn next_id(&mut self, at_ms: EpochMs) -> String;
}

/// UUIDv7 ids, time-ordered by the interval's start.
#[derive(Debug, Default)]
pub struct UuidV7Ids;

impl IdSource for UuidV7Ids {
    fn next_id(&mut self, at_ms: EpochMs) -> String {
        let millis = u64::try_from(at_ms).unwrap_or(0);
        let ts = uuid::Timestamp::from_unix(
            uuid::NoContext,
            millis / 1_000,
            ((millis % 1_000) * 1_000_000) as u32,
        );
        uuid::Uuid::new_v7(ts).to_string()
    }
}

/// Deterministic ids for tests: `iv-1`, `iv-2`, …
#[derive(Debug, Default)]
pub struct SequentialIds {
    next: u64,
}

impl IdSource for SequentialIds {
    fn next_id(&mut self, _at_ms: EpochMs) -> String {
        self.next += 1;
        format!("iv-{}", self.next)
    }
}
