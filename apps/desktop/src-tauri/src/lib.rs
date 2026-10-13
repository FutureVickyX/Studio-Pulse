//! Studio Pulse desktop core.
//!
//! Module map (docs/architecture.md §3):
//! - [`tracker`]  pure accounting engine + background service
//! - [`platform`] Win32 probes (foreground process, idle, session state)
//! - [`registry`] application definitions and process matching
//! - [`store`]    local SQLite persistence
//! - [`startup`]  launch-at-login registration
//! - [`settings`] user settings
//! - `commands`, `tray`, `window_manager`, `app_state`: the Tauri shell

pub mod error;
pub mod platform;
pub mod registry;
pub mod settings;
pub mod startup;
pub mod store;
pub mod tracker;

mod app_state;
mod commands;
mod tray;
mod window_manager;

/// Entry point used by `main.rs`.
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Studio Pulse");
}
