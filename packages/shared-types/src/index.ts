/**
 * Studio Pulse shared contract.
 *
 * Every payload exchanged between the Rust core (apps/desktop/src-tauri) and the UI is defined
 * here once. Rust mirrors these shapes with `#[serde(rename_all = "camelCase")]`. If you change a
 * type here, change the Rust struct in the same commit (see docs/architecture.md §7).
 */

import defaultApplicationsJson from '../data/default-applications.json';

/** ISO-8601 timestamp in UTC, e.g. `2026-10-13T09:15:00.000Z`. Rendered in the user's time zone. */
export type IsoDateTime = string;

// ---------------------------------------------------------------------------------------------
// Application registry
// ---------------------------------------------------------------------------------------------

export const APP_CATEGORIES = [
  'design',
  'motion',
  'video',
  '3d',
  'photo',
  'audio',
  'publishing',
  'code',
  'other',
] as const;

export type AppCategory = (typeof APP_CATEGORIES)[number];

export const APP_CATEGORY_LABELS: Readonly<Record<AppCategory, string>> = {
  design: 'Design & vector',
  motion: 'Motion',
  video: 'Video',
  '3d': '3D',
  photo: 'Photo',
  audio: 'Audio',
  publishing: 'Publishing',
  code: 'Code',
  other: 'Other',
};

/**
 * Identifies a process. `exe` is the image file name (case-insensitive, `*` wildcard allowed).
 * `pathIncludes` optionally narrows the match to images whose full path contains the substring.
 */
export interface ProcessMatcher {
  exe: string;
  pathIncludes?: string | null;
}

/** Entry in `packages/shared-types/data/default-applications.json`. */
export interface DefaultApplication {
  id: string;
  displayName: string;
  category: AppCategory;
  enabledByDefault: boolean;
  matchers: ProcessMatcher[];
}

export interface DefaultApplicationsFile {
  version: number;
  applications: DefaultApplication[];
}

/** The built-in registry, typed. Validated by `@studio-pulse/validation` tests. */
export const DEFAULT_APPLICATIONS: readonly DefaultApplication[] = (
  defaultApplicationsJson as unknown as DefaultApplicationsFile
).applications;

/** An application as stored locally (built-in or user-defined). */
export interface ApplicationDefinition {
  id: string;
  displayName: string;
  category: AppCategory;
  matchers: ProcessMatcher[];
  /** Tracked when in the foreground. Disabled apps are never recorded. */
  enabled: boolean;
  /** Shown in reports. Excluded apps are still recorded if enabled, but hidden from totals. */
  includeInReports: boolean;
  builtIn: boolean;
  sortOrder: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Payload for `save_application`. `id: null` creates a custom application. */
export interface ApplicationInput {
  id: string | null;
  displayName: string;
  category: AppCategory;
  matchers: ProcessMatcher[];
  enabled: boolean;
  includeInReports: boolean;
}

/**
 * A process that currently owns a visible top-level window. Used only to help the user add an
 * application. Held in memory, never stored.
 */
export interface RunningApplication {
  exeName: string;
  path: string;
  matchedApplicationId: string | null;
}

// ---------------------------------------------------------------------------------------------
// Tracking records
// ---------------------------------------------------------------------------------------------

export type IntervalKind = 'active' | 'idle';

export type EndReason =
  | 'appSwitch'
  | 'becameIdle'
  | 'inputResumed'
  | 'untracked'
  | 'sessionAway'
  | 'paused'
  | 'disabled'
  | 'timeGap'
  | 'clockChange'
  | 'shutdown'
  | 'recovered'
  | 'settingsChanged';

export type TrackingSource = 'automatic' | 'manual';
export type SyncStatus = 'pending' | 'synced' | 'failed';
export type IntervalState = 'open' | 'closed';

/**
 * One contiguous foreground interval of one application, either wholly active or wholly idle.
 * `durationSeconds = activeSeconds + idleSeconds`. Seconds carry millisecond precision.
 */
export interface TrackingEvent {
  id: string;
  /** Null until the device is signed in to a workspace (Phase 2). */
  userId: string | null;
  deviceId: string;
  applicationId: string;
  /** Display name captured when the interval opened. */
  applicationName: string;
  kind: IntervalKind;
  startedAt: IsoDateTime;
  endedAt: IsoDateTime;
  durationSeconds: number;
  activeSeconds: number;
  idleSeconds: number;
  projectId: string | null;
  taskId: string | null;
  source: TrackingSource;
  syncStatus: SyncStatus;
  /** `open` = the interval currently being recorded. */
  state: IntervalState;
  endReason: EndReason | null;
  revision: number;
}

// ---------------------------------------------------------------------------------------------
// Tracker status
// ---------------------------------------------------------------------------------------------

/**
 * - `notStarted`  onboarding not completed; nothing is recorded
 * - `tracking`    a tracked app is in the foreground and the user is active
 * - `idle`        a tracked app is in the foreground but there has been no input for the idle timeout
 * - `untracked`   the foreground app is not in the enabled registry
 * - `away`        the session is locked, the screen saver is running or the session is disconnected
 * - `paused`      the user paused tracking (`pausedUntil` = when it resumes, null = until resumed)
 * - `disabled`    tracking is switched off in settings
 * - `clockBehind` the system clock moved backwards; recording resumes when it catches up
 */
export type TrackerState =
  | 'notStarted'
  | 'tracking'
  | 'idle'
  | 'untracked'
  | 'away'
  | 'paused'
  | 'disabled'
  | 'clockBehind';

export interface CurrentInterval {
  eventId: string;
  applicationId: string;
  applicationName: string;
  category: AppCategory;
  kind: IntervalKind;
  startedAt: IsoDateTime;
}

export interface TrackerStatus {
  state: TrackerState;
  current: CurrentInterval | null;
  pausedUntil: IsoDateTime | null;
  lastSampleAt: IsoDateTime | null;
  idleThresholdSeconds: number;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export type ThemePreference = 'dark' | 'light' | 'system';

export interface GeneralSettings {
  theme: ThemePreference;
  /** When Windows launches Studio Pulse at sign-in, stay in the tray. */
  startMinimized: boolean;
  /** Closing or minimizing the main window hides it to the tray; tracking continues. */
  minimizeToTray: boolean;
  /** At sign-in (when not minimized) open the full window instead of the compact indicator. */
  launchFullWindowOnStartup: boolean;
}

export interface TrackingSettings {
  /** Master switch. Off = nothing is recorded. */
  enabled: boolean;
  /** Start recording as soon as the app launches (otherwise launch paused). */
  startAutomatically: boolean;
  /** Idle detection. Off = time without input counts as active (e.g. reviewing renders). */
  pauseWhenIdle: boolean;
  idleTimeoutMinutes: number;
  notifications: boolean;
  /** Aggregation window: how often the open interval is flushed to disk. */
  checkpointSeconds: number;
  /** Intervals shorter than this are discarded (alt-tab flicker). */
  minimumIntervalSeconds: number;
}

export interface OnboardingState {
  completed: boolean;
  completedAt: IsoDateTime | null;
}

export interface Settings {
  general: GeneralSettings;
  tracking: TrackingSettings;
  onboarding: OnboardingState;
}

/** Partial update accepted by `update_settings`. Onboarding changes go through `complete_onboarding`. */
export interface SettingsPatch {
  general?: Partial<GeneralSettings>;
  tracking?: Partial<TrackingSettings>;
}

export const SETTINGS_LIMITS = {
  idleTimeoutMinutes: { min: 1, max: 120 },
  checkpointSeconds: { min: 5, max: 300 },
  minimumIntervalSeconds: { min: 0, max: 60 },
} as const;

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  general: {
    theme: 'dark',
    startMinimized: true,
    minimizeToTray: true,
    launchFullWindowOnStartup: false,
  },
  tracking: {
    enabled: true,
    startAutomatically: true,
    pauseWhenIdle: true,
    idleTimeoutMinutes: 5,
    notifications: true,
    checkpointSeconds: 15,
    minimumIntervalSeconds: 2,
  },
  onboarding: {
    completed: false,
    completedAt: null,
  },
};

// ---------------------------------------------------------------------------------------------
// Launch at login
// ---------------------------------------------------------------------------------------------

export interface StartupStatus {
  /** True only when registered, not disabled by Windows, and pointing at this executable. */
  enabled: boolean;
  /** The Run registry value exists. */
  registered: boolean;
  /** Windows' StartupApproved flag (Task Manager toggle). Null when Windows has no flag yet. */
  approvedByWindows: boolean | null;
  pointsToCurrentExecutable: boolean;
  /** The exact command Windows will run, or null when not registered. */
  command: string | null;
  isDevelopmentBuild: boolean;
  /** Human-readable explanation when the state needs attention. */
  message: string | null;
}

// ---------------------------------------------------------------------------------------------
// Privacy / data
// ---------------------------------------------------------------------------------------------

export interface DataSummary {
  deviceId: string;
  databasePath: string;
  eventCount: number;
  openEventCount: number;
  pendingSyncCount: number;
  applicationCount: number;
  oldestEventAt: IsoDateTime | null;
  newestEventAt: IsoDateTime | null;
  /** Column names stored for each tracking record, shown verbatim in Privacy settings. */
  storedFields: string[];
}

export type ExportFormat = 'json' | 'csv';

export interface ExportResult {
  path: string;
  count: number;
  format: ExportFormat;
}

export interface AppInfo {
  name: string;
  version: string;
  isDevelopmentBuild: boolean;
  platform: string;
  dataDirectory: string;
  /** This process was started by Windows at sign-in (`--autostart`). */
  launchedAtLogin: boolean;
}

// ---------------------------------------------------------------------------------------------
// Commands (allowlist) — see docs/architecture.md §7
// ---------------------------------------------------------------------------------------------

export type CommandErrorCode =
  | 'validation'
  | 'not_found'
  | 'startup_registration'
  | 'storage'
  | 'platform'
  | 'internal';

export interface CommandError {
  code: CommandErrorCode;
  message: string;
}

export interface TimeRangeInput {
  fromMs: number;
  toMs: number;
}

/** Workspace routes. `app://navigate` carries one of these. */
export type Route =
  | 'home'
  | 'tasks'
  | 'notes'
  | 'projects'
  | 'time'
  | 'team'
  | 'settings'
  | 'settings/general'
  | 'settings/tracking'
  | 'settings/applications'
  | 'settings/privacy'
  | 'settings/workspace'
  | 'settings/sync'
  | 'settings/about';

/** Typed map of every native command: name → args object passed to `invoke` → result. */
export interface CommandMap {
  get_tracker_status: { args: Record<string, never>; result: TrackerStatus };
  pause_tracking: { args: { minutes: number | null }; result: TrackerStatus };
  resume_tracking: { args: Record<string, never>; result: TrackerStatus };
  list_tracking_events: { args: { range: TimeRangeInput }; result: TrackingEvent[] };
  get_settings: { args: Record<string, never>; result: Settings };
  update_settings: { args: { patch: SettingsPatch }; result: Settings };
  complete_onboarding: { args: { enabledApplicationIds: string[] }; result: Settings };
  get_startup_status: { args: Record<string, never>; result: StartupStatus };
  set_launch_at_login: { args: { enabled: boolean }; result: StartupStatus };
  list_applications: { args: Record<string, never>; result: ApplicationDefinition[] };
  save_application: { args: { input: ApplicationInput }; result: ApplicationDefinition };
  delete_application: { args: { id: string }; result: null };
  reset_applications: { args: { removeCustom: boolean }; result: ApplicationDefinition[] };
  list_running_applications: { args: Record<string, never>; result: RunningApplication[] };
  pick_executable: { args: Record<string, never>; result: RunningApplication | null };
  get_data_summary: { args: Record<string, never>; result: DataSummary };
  export_tracking_events: { args: { format: ExportFormat }; result: ExportResult | null };
  delete_tracking_events: { args: { beforeMs: number | null }; result: { deleted: number } };
  get_app_info: { args: Record<string, never>; result: AppInfo };
  show_main_window: { args: { route: Route | null }; result: null };
  hide_indicator: { args: Record<string, never>; result: null };
  quit_app: { args: Record<string, never>; result: null };
}

export type CommandName = keyof CommandMap;

// ---------------------------------------------------------------------------------------------
// Events (Rust → UI)
// ---------------------------------------------------------------------------------------------

export const EVENTS = {
  trackerStatus: 'tracker://status',
  eventsChanged: 'tracker://events-changed',
  settingsChanged: 'settings://changed',
  applicationsChanged: 'applications://changed',
  navigate: 'app://navigate',
} as const;

export interface EventPayloadMap {
  'tracker://status': TrackerStatus;
  'tracker://events-changed': { at: IsoDateTime };
  'settings://changed': Settings;
  'applications://changed': ApplicationDefinition[];
  'app://navigate': Route;
}

export type EventName = keyof EventPayloadMap;
