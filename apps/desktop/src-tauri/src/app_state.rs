//! State shared by commands, the tray and window handlers (managed by Tauri).

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use crate::registry::Registry;
use crate::settings::Settings;
use crate::startup::StartupConfig;
use crate::store::{Store, StoreResult};
use crate::tracker::service::TrackerHandle;

pub struct AppState {
    pub store: Arc<Store>,
    pub tracker: TrackerHandle,
    pub settings: Arc<RwLock<Settings>>,
    pub registry: Arc<RwLock<Registry>>,
    pub device_id: String,
    pub startup: StartupConfig,
    pub launched_at_login: bool,
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn settings(&self) -> Settings {
        match self.settings.read() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    pub fn set_settings(&self, next: Settings) {
        match self.settings.write() {
            Ok(mut guard) => *guard = next,
            Err(poisoned) => *poisoned.into_inner() = next,
        }
    }

    /// Reload the in-memory registry from the store after an application edit.
    pub fn reload_registry(&self) -> StoreResult<Registry> {
        let registry = Registry::new(self.store.list_applications()?);
        match self.registry.write() {
            Ok(mut guard) => *guard = registry.clone(),
            Err(poisoned) => *poisoned.into_inner() = registry.clone(),
        }
        Ok(registry)
    }
}
