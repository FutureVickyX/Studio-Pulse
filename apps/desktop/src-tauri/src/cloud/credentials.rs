//! Where the session lives between launches.
//!
//! Only the **refresh token** (plus the user id and email, to show who is signed in while
//! offline) is persisted, in Windows Credential Manager under the current Windows user — never
//! in the SQLite database, settings, logs or the webview. The short-lived access token stays in
//! memory.

use serde::{Deserialize, Serialize};

/// What is persisted. `Debug` never prints the refresh token.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub refresh_token: String,
    pub user_id: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
}

impl std::fmt::Debug for StoredSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredSession")
            .field("refresh_token", &"<redacted>")
            .field("user_id", &self.user_id)
            .field("email", &self.email)
            .field("display_name", &self.display_name)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("credential storage failed: {0}")]
pub struct CredentialError(pub String);

pub trait CredentialStore: Send + Sync {
    fn load(&self) -> Result<Option<StoredSession>, CredentialError>;
    fn save(&self, session: &StoredSession) -> Result<(), CredentialError>;
    /// Absent is not an error.
    fn clear(&self) -> Result<(), CredentialError>;
}

/// Windows Credential Manager (generic credential, persisted for the current user on this
/// machine). Target name: `Studio Pulse/supabase/<project-ref>`.
pub struct WindowsCredentialStore {
    #[allow(dead_code)]
    target: String,
}

impl WindowsCredentialStore {
    pub fn new(project_ref: &str) -> Self {
        Self {
            target: format!("Studio Pulse/supabase/{project_ref}"),
        }
    }
}

impl CredentialStore for WindowsCredentialStore {
    fn load(&self) -> Result<Option<StoredSession>, CredentialError> {
        todo!("WindowsCredentialStore::load")
    }

    fn save(&self, _session: &StoredSession) -> Result<(), CredentialError> {
        todo!("WindowsCredentialStore::save")
    }

    fn clear(&self) -> Result<(), CredentialError> {
        todo!("WindowsCredentialStore::clear")
    }
}

/// In-memory store for tests.
#[derive(Default)]
pub struct MemoryCredentialStore {
    inner: std::sync::Mutex<Option<StoredSession>>,
}

impl CredentialStore for MemoryCredentialStore {
    fn load(&self) -> Result<Option<StoredSession>, CredentialError> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| CredentialError("poisoned".into()))?
            .clone())
    }

    fn save(&self, session: &StoredSession) -> Result<(), CredentialError> {
        *self
            .inner
            .lock()
            .map_err(|_| CredentialError("poisoned".into()))? = Some(session.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), CredentialError> {
        *self
            .inner
            .lock()
            .map_err(|_| CredentialError("poisoned".into()))? = None;
        Ok(())
    }
}
