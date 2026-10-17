//! The native command allowlist (docs/architecture.md §7). Every command re-validates its input:
//! the webview is never trusted. No command accepts a file path, SQL, or a program to run. Export
//! and executable picking open native dialogs from Rust.
//!
//! Commands touching the database or the OS run on Tauri's async pool (`async` or
//! `#[tauri::command(async)]`), not on the main thread.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

use crate::app_state::AppState;
use crate::cloud::account::{AccountStatus, SignUpResult};
use crate::cloud::api::{InvitationCreated, WorkspaceRole};
use crate::cloud::ledger::SyncLedger;
use crate::cloud::sync::{SyncCommand, SyncOverview};
use crate::error::{CommandError, CommandResult, ErrorCode};
use crate::platform::{self, ProcessInfo};
use crate::registry::{ApplicationDefinition, ApplicationInput, MatchOutcome, Registry};
use crate::settings::{OnboardingState, Settings, SettingsPatch};
use crate::startup::{self, StartupStatus};
use crate::store::{self, DataSummary, TrackingEventRecord};
use crate::tracker::service::{TrackerCommand, TrackerStatus};
use crate::window_manager;

pub const EVENT_TRACKER_STATUS: &str = "tracker://status";
pub const EVENT_EVENTS_CHANGED: &str = "tracker://events-changed";
pub const EVENT_SETTINGS_CHANGED: &str = "settings://changed";
pub const EVENT_APPLICATIONS_CHANGED: &str = "applications://changed";
pub const EVENT_NAVIGATE: &str = "app://navigate";

/// Routes the UI accepts on `app://navigate` (mirror of `Route` in shared-types).
const ROUTES: &[&str] = &[
    "home",
    "tasks",
    "notes",
    "projects",
    "time",
    "team",
    "settings",
    "settings/general",
    "settings/tracking",
    "settings/applications",
    "settings/privacy",
    "settings/workspace",
    "settings/sync",
    "settings/about",
];

/// Longest range `list_tracking_events` serves in one call (a little over a year).
const MAX_RANGE_MS: i64 = 400 * 24 * 60 * 60 * 1000;
/// Longest timed pause (one day).
const MAX_PAUSE_MINUTES: u32 = 24 * 60;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn current_exe() -> CommandResult<std::path::PathBuf> {
    std::env::current_exe().map_err(|err| {
        CommandError::new(
            ErrorCode::Platform,
            format!("Could not locate the Studio Pulse executable: {err}"),
        )
    })
}

fn tracker_unavailable() -> CommandError {
    CommandError::internal("The tracker is not responding. Try again in a moment.")
}

// ---- tracker ---------------------------------------------------------------------------------

#[tauri::command]
pub fn get_tracker_status(state: State<'_, AppState>) -> TrackerStatus {
    state.tracker.status()
}

#[tauri::command(async)]
pub fn pause_tracking(
    state: State<'_, AppState>,
    minutes: Option<u32>,
) -> CommandResult<TrackerStatus> {
    let until_ms = match minutes {
        None => None,
        Some(m) if (1..=MAX_PAUSE_MINUTES).contains(&m) => Some(now_ms() + i64::from(m) * 60_000),
        Some(m) => {
            return Err(CommandError::validation(format!(
                "Pause length must be between 1 and {MAX_PAUSE_MINUTES} minutes (got {m})."
            )))
        }
    };
    state
        .tracker
        .request(|reply| TrackerCommand::Pause { until_ms, reply })
        .ok_or_else(tracker_unavailable)?;
    Ok(state.tracker.status())
}

#[tauri::command(async)]
pub fn resume_tracking(state: State<'_, AppState>) -> CommandResult<TrackerStatus> {
    state
        .tracker
        .request(|reply| TrackerCommand::Resume { reply })
        .ok_or_else(tracker_unavailable)?;
    Ok(state.tracker.status())
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeRangeInput {
    pub from_ms: i64,
    pub to_ms: i64,
}

/// Intervals overlapping the range, with the live open interval overlaid (it may be newer than
/// its last checkpoint).
#[tauri::command(async)]
pub fn list_tracking_events(
    state: State<'_, AppState>,
    range: TimeRangeInput,
) -> CommandResult<Vec<TrackingEventRecord>> {
    if range.to_ms <= range.from_ms {
        return Err(CommandError::validation(
            "The range end must be after its start.",
        ));
    }
    if range.to_ms - range.from_ms > MAX_RANGE_MS {
        return Err(CommandError::validation(
            "The range is too long (maximum 400 days).",
        ));
    }
    let mut records = state.store.list_events(range.from_ms, range.to_ms)?;
    if let Some(open) = state.tracker.open_interval() {
        records.retain(|r| r.id != open.id);
        if open.started_at_ms < range.to_ms && open.ended_at_ms > range.from_ms {
            records.push(store::record_from_interval(&open, &state.device_id));
        }
    }
    records.sort_by(|a, b| {
        a.started_at_ms
            .cmp(&b.started_at_ms)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(records)
}

// ---- settings --------------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command(async)]
pub fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: SettingsPatch,
) -> CommandResult<Settings> {
    let current = state.settings();
    let next = current
        .apply_patch(&patch)
        .map_err(CommandError::validation)?;
    state.store.save_settings(&next)?;
    state.set_settings(next.clone());
    state
        .tracker
        .request(|reply| TrackerCommand::SettingsChanged { reply });
    if next.general.theme != current.general.theme {
        window_manager::apply_theme(&app, next.general.theme);
    }
    let _ = app.emit(EVENT_SETTINGS_CHANGED, &next);
    Ok(next)
}

/// Finish onboarding: enable exactly the chosen applications, then start tracking.
#[tauri::command(async)]
pub fn complete_onboarding(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled_application_ids: Vec<String>,
) -> CommandResult<Settings> {
    if enabled_application_ids.len() > 512 {
        return Err(CommandError::validation("Too many applications."));
    }
    state
        .store
        .set_enabled_applications(&enabled_application_ids)?;
    let registry = state.reload_registry()?;
    let mut next = state.settings();
    next.onboarding = OnboardingState {
        completed: true,
        completed_at: Some(store::iso_from_ms(now_ms())),
    };
    state.store.save_settings(&next)?;
    state.set_settings(next.clone());
    state.tracker.send(TrackerCommand::RegistryChanged);
    state
        .tracker
        .request(|reply| TrackerCommand::SettingsChanged { reply });
    let _ = app.emit(EVENT_APPLICATIONS_CHANGED, registry.apps());
    let _ = app.emit(EVENT_SETTINGS_CHANGED, &next);
    log::debug!(
        "onboarding completed with {} application(s) enabled",
        enabled_application_ids.len()
    );
    Ok(next)
}

// ---- launch at login -------------------------------------------------------------------------

#[tauri::command(async)]
pub fn get_startup_status(state: State<'_, AppState>) -> CommandResult<StartupStatus> {
    let exe = current_exe()?;
    Ok(startup::status(&state.startup, &exe)?)
}

/// Register or unregister, verified by read-back. On failure the error is returned and the UI
/// keeps showing the real (registry-derived) state.
#[tauri::command(async)]
pub fn set_launch_at_login(
    state: State<'_, AppState>,
    enabled: bool,
) -> CommandResult<StartupStatus> {
    let exe = current_exe()?;
    let result = if enabled {
        startup::enable(&state.startup, &exe)
    } else {
        startup::disable(&state.startup, &exe)
    };
    match result {
        Ok(status) => {
            log::debug!(
                "launch at login {}: enabled={}",
                if enabled { "enable" } else { "disable" },
                status.enabled
            );
            Ok(status)
        }
        Err(err) => {
            log::error!("launch at login change failed: {err}");
            Err(err.into())
        }
    }
}

// ---- applications ----------------------------------------------------------------------------

#[tauri::command(async)]
pub fn list_applications(state: State<'_, AppState>) -> CommandResult<Vec<ApplicationDefinition>> {
    Ok(state.store.list_applications()?)
}

fn after_registry_change(app: &AppHandle, state: &AppState) -> CommandResult<Registry> {
    let registry = state.reload_registry()?;
    state.tracker.send(TrackerCommand::RegistryChanged);
    let _ = app.emit(EVENT_APPLICATIONS_CHANGED, registry.apps());
    Ok(registry)
}

#[tauri::command(async)]
pub fn save_application(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ApplicationInput,
) -> CommandResult<ApplicationDefinition> {
    let saved = state.store.save_application(&input)?;
    after_registry_change(&app, &state)?;
    Ok(saved)
}

#[tauri::command(async)]
pub fn delete_application(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CommandResult<()> {
    if id.is_empty() || id.len() > 64 {
        return Err(CommandError::validation("Unknown application id."));
    }
    state.store.delete_application(&id)?;
    after_registry_change(&app, &state)?;
    Ok(())
}

#[tauri::command(async)]
pub fn reset_applications(
    app: AppHandle,
    state: State<'_, AppState>,
    remove_custom: bool,
) -> CommandResult<Vec<ApplicationDefinition>> {
    state.store.reset_applications(remove_custom)?;
    let registry = after_registry_change(&app, &state)?;
    Ok(registry.apps().to_vec())
}

/// Serialized shape = `RunningApplication` in shared-types. Held in memory only.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningApplication {
    pub exe_name: String,
    pub path: String,
    pub matched_application_id: Option<String>,
}

fn to_running(process: ProcessInfo, registry: &Registry) -> RunningApplication {
    let matched = match registry.match_process(&process.exe_name, &process.exe_path) {
        MatchOutcome::Tracked(app) | MatchOutcome::Disabled(app) => Some(app.id.clone()),
        MatchOutcome::Unknown => None,
    };
    RunningApplication {
        exe_name: process.exe_name,
        path: process.exe_path,
        matched_application_id: matched,
    }
}

#[tauri::command(async)]
pub fn list_running_applications(
    state: State<'_, AppState>,
) -> CommandResult<Vec<RunningApplication>> {
    let processes = platform::running_applications();
    let registry = match state.registry.read() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    Ok(processes
        .into_iter()
        .map(|p| to_running(p, &registry))
        .collect())
}

/// Native "choose an .exe" dialog. Only the file name and path of the chosen file are returned;
/// nothing is executed or read.
#[tauri::command]
pub async fn pick_executable(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Option<RunningApplication>> {
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("Choose an application")
            .add_filter("Applications", &["exe"])
            .blocking_pick_file()
    })
    .await
    .map_err(|err| CommandError::internal(format!("The file dialog failed: {err}")))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| CommandError::validation("Choose a file on this computer."))?;
    let exe_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_owned)
        .ok_or_else(|| CommandError::validation("That file name can't be used."))?;
    if !exe_name.to_ascii_lowercase().ends_with(".exe") {
        return Err(CommandError::validation("Choose an .exe file."));
    }
    let registry = match state.registry.read() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    Ok(Some(to_running(
        ProcessInfo {
            pid: 0,
            exe_name,
            exe_path: path.to_string_lossy().into_owned(),
        },
        &registry,
    )))
}

// ---- privacy / data --------------------------------------------------------------------------

#[tauri::command(async)]
pub fn get_data_summary(state: State<'_, AppState>) -> CommandResult<DataSummary> {
    Ok(state.store.data_summary()?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Json,
    Csv,
}

/// Serialized shape = `ExportResult` in shared-types.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub count: usize,
    pub format: ExportFormat,
}

/// Export every local tracking record to a file the user picks in a native save dialog.
/// Returns `None` if the dialog was cancelled.
#[tauri::command]
pub async fn export_tracking_events(
    app: AppHandle,
    state: State<'_, AppState>,
    format: ExportFormat,
) -> CommandResult<Option<ExportResult>> {
    // Make the open interval's latest checkpoint part of the export.
    state
        .tracker
        .request(|reply| TrackerCommand::Flush { reply });
    let records = state.store.list_all_events()?;
    let content = match format {
        ExportFormat::Json => store::export_json(&records, &state.device_id, now_ms()),
        ExportFormat::Csv => store::export_csv(&records),
    };
    let (extension, label) = match format {
        ExportFormat::Json => ("json", "JSON"),
        ExportFormat::Csv => ("csv", "CSV"),
    };
    let today = chrono::Local::now().format("%Y-%m-%d");
    let file_name = format!("studio-pulse-tracking-{today}.{extension}");
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("Export tracking records")
            .set_file_name(&file_name)
            .add_filter(label, &[extension])
            .blocking_save_file()
    })
    .await
    .map_err(|err| CommandError::internal(format!("The save dialog failed: {err}")))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| CommandError::validation("Choose a location on this computer."))?;
    write_export(&path, &content)?;
    log::debug!("exported {} tracking record(s)", records.len());
    Ok(Some(ExportResult {
        path: path.to_string_lossy().into_owned(),
        count: records.len(),
        format,
    }))
}

fn write_export(path: &Path, content: &str) -> CommandResult<()> {
    std::fs::write(path, content).map_err(|err| {
        CommandError::new(
            ErrorCode::Storage,
            format!("The export could not be written: {err}"),
        )
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub deleted: u64,
}

/// `before_ms = None` deletes all local tracking history; otherwise closed records that ended at
/// or before `before_ms`. Runs inside the tracker thread so no checkpoint can race it.
#[tauri::command(async)]
pub fn delete_tracking_events(
    app: AppHandle,
    state: State<'_, AppState>,
    before_ms: Option<i64>,
) -> CommandResult<DeleteResult> {
    if let Some(before) = before_ms {
        if before > now_ms() {
            return Err(CommandError::validation(
                "The cut-off can't be in the future.",
            ));
        }
    }
    let result = state
        .tracker
        .request(|reply| TrackerCommand::DeleteHistory { before_ms, reply })
        .ok_or_else(tracker_unavailable)?;
    let deleted = result.map_err(|err| {
        log::error!("history deletion failed: {err}");
        CommandError::new(ErrorCode::Storage, "Tracking history could not be deleted.")
    })?;
    log::debug!("deleted {deleted} tracking record(s)");
    let _ = app.emit(
        EVENT_EVENTS_CHANGED,
        serde_json::json!({ "at": store::iso_from_ms(now_ms()) }),
    );
    Ok(DeleteResult { deleted })
}

// ---- app / windows ---------------------------------------------------------------------------

/// Serialized shape = `AppInfo` in shared-types.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub is_development_build: bool,
    pub platform: String,
    pub data_directory: String,
    pub launched_at_login: bool,
}

#[tauri::command]
pub fn get_app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        is_development_build: cfg!(debug_assertions),
        platform: std::env::consts::OS.to_string(),
        data_directory: state.data_dir.to_string_lossy().into_owned(),
        launched_at_login: state.launched_at_login,
    }
}

#[tauri::command]
pub fn show_main_window(app: AppHandle, route: Option<String>) -> CommandResult<()> {
    if let Some(route) = &route {
        if !ROUTES.contains(&route.as_str()) {
            return Err(CommandError::validation("Unknown route."));
        }
    }
    window_manager::show_main(&app);
    if let Some(route) = route {
        let _ = app.emit_to(window_manager::MAIN, EVENT_NAVIGATE, route);
    }
    Ok(())
}

#[tauri::command]
pub fn hide_indicator(app: AppHandle) {
    window_manager::hide_indicator(&app);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ---- Phase 2A: account, workspaces and sync (main window only) -------------------------------
//
// Network calls run on Tauri's async pool, never on the main thread. Passwords and tokens are
// passed straight to the account manager and never logged; only the one-time invitation code is
// returned to the UI (to the inviter, to share).

pub const EVENT_ACCOUNT_CHANGED: &str = "account://changed";
pub const EVENT_SYNC_STATUS: &str = "sync://status";

/// How long `sync_now` waits for the sync thread to finish a pass.
const SYNC_NOW_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignInInput {
    pub email: String,
    pub password: String,
}

impl std::fmt::Debug for SignInInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignInInput").finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignUpInput {
    pub email: String,
    pub password: String,
    pub display_name: String,
}

impl std::fmt::Debug for SignUpInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignUpInput").finish_non_exhaustive()
    }
}

#[tauri::command(async)]
pub fn get_account_status(state: State<'_, AppState>) -> CommandResult<AccountStatus> {
    Ok(state.account.status())
}

#[tauri::command(async)]
pub fn sign_in(state: State<'_, AppState>, input: SignInInput) -> CommandResult<AccountStatus> {
    Ok(state.account.sign_in(&input.email, &input.password)?)
}

#[tauri::command(async)]
pub fn sign_up(state: State<'_, AppState>, input: SignUpInput) -> CommandResult<SignUpResult> {
    Ok(state
        .account
        .sign_up(&input.email, &input.password, &input.display_name)?)
}

#[tauri::command(async)]
pub fn sign_out(state: State<'_, AppState>) -> CommandResult<AccountStatus> {
    Ok(state.account.sign_out()?)
}

#[tauri::command(async)]
pub fn refresh_workspaces(state: State<'_, AppState>) -> CommandResult<AccountStatus> {
    Ok(state.account.refresh_workspaces()?)
}

#[tauri::command(async)]
pub fn create_workspace(state: State<'_, AppState>, name: String) -> CommandResult<AccountStatus> {
    Ok(state.account.create_workspace(&name)?)
}

#[tauri::command(async)]
pub fn select_sync_workspace(
    state: State<'_, AppState>,
    workspace_id: Option<String>,
) -> CommandResult<AccountStatus> {
    Ok(state
        .account
        .select_sync_workspace(workspace_id.as_deref())?)
}

#[tauri::command(async)]
pub fn accept_invitation(
    state: State<'_, AppState>,
    token: String,
) -> CommandResult<AccountStatus> {
    Ok(state.account.accept_invitation(&token)?)
}

#[tauri::command(async)]
pub fn create_invitation(
    state: State<'_, AppState>,
    workspace_id: String,
    email: String,
    role: WorkspaceRole,
) -> CommandResult<InvitationCreated> {
    if role == WorkspaceRole::Owner {
        return Err(CommandError::validation(
            "Invitations cannot grant ownership.",
        ));
    }
    Ok(state
        .account
        .create_invitation(&workspace_id, &email, role)?)
}

#[tauri::command]
pub fn get_sync_status(state: State<'_, AppState>) -> SyncOverview {
    state.sync.overview()
}

/// Run a pass now (ignoring backoff) and return the resulting overview.
#[tauri::command(async)]
pub fn sync_now(state: State<'_, AppState>) -> CommandResult<SyncOverview> {
    let (reply, done) = std::sync::mpsc::channel();
    state.sync.send(SyncCommand::SyncNow { reply });
    if done.recv_timeout(SYNC_NOW_TIMEOUT).is_err() {
        log::warn!("sync pass did not finish in time");
    }
    Ok(state.sync.overview())
}

/// Explicit consent: give intervals recorded while no account was signed in to the signed-in
/// account, so they are uploaded to its sync workspace.
#[tauri::command(async)]
pub fn claim_local_history(state: State<'_, AppState>) -> CommandResult<SyncOverview> {
    let user_id = state
        .account
        .current_user_id()
        .ok_or_else(|| CommandError::new(ErrorCode::Unauthenticated, "Sign in first."))?;
    let claimed = SyncLedger::claim_unowned(state.store.as_ref(), &user_id)
        .map_err(|err| CommandError::new(ErrorCode::Storage, err.to_string()))?;
    log::debug!("claimed {claimed} interval(s) recorded while signed out");
    state.sync.send(SyncCommand::AccountChanged);
    Ok(state.sync.overview())
}
