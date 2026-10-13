//! Declares the app's native commands so Tauri generates an `allow-<command>` permission for
//! each. Only commands granted in `capabilities/*.json` are callable from a window, which makes
//! the command surface an explicit, per-window allowlist (docs/architecture.md §7).

const COMMANDS: &[&str] = &[
    "get_tracker_status",
    "pause_tracking",
    "resume_tracking",
    "list_tracking_events",
    "get_settings",
    "update_settings",
    "complete_onboarding",
    "get_startup_status",
    "set_launch_at_login",
    "list_applications",
    "save_application",
    "delete_application",
    "reset_applications",
    "list_running_applications",
    "pick_executable",
    "get_data_summary",
    "export_tracking_events",
    "delete_tracking_events",
    "get_app_info",
    "show_main_window",
    "hide_indicator",
    "quit_app",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
