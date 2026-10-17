//! The signed-in account: sign-in/up/out, session restore and refresh, memberships and the sync
//! workspace.
//!
//! States (= `AccountState` in shared-types):
//! - `NotConfigured`  no valid [`SupabaseConfig`] in this build
//! - `SignedOut`
//! - `SignedIn`       a refresh token is stored; the access token may be missing while offline
//! - `SessionExpired` the stored refresh token was rejected; local data is kept, sign in again
//!
//! Rules:
//! - The refresh token is persisted only in the [`CredentialStore`]; access tokens stay in memory.
//! - A network failure never signs the user out or deletes anything; it only delays.
//! - Signing in stamps new intervals with the user's id ([`SyncLedger::set_account_user`]);
//!   signing out clears it. Intervals recorded while signed out stay unowned until claimed.
//! - The sync workspace must be one of the user's active memberships; a workspace id supplied by
//!   the UI is checked against the server-provided list before it is stored.

use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::api::{InvitationCreated, RemoteApi, RemoteError, WorkspaceRole, WorkspaceSummary};
use super::config::{ConfigError, SupabaseConfig};
use super::credentials::CredentialStore;
use super::ledger::SyncLedger;
use crate::tracker::EpochMs;

/// Refresh the access token when it expires within this window.
pub const REFRESH_MARGIN_MS: i64 = 60_000;

/// Serialized shape = `AccountState` in shared-types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountState {
    NotConfigured,
    SignedOut,
    SignedIn,
    SessionExpired,
}

/// Serialized shape = `AccountStatus` in shared-types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub state: AccountState,
    pub configuration_error: Option<String>,
    pub user_id: Option<String>,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub workspaces: Vec<WorkspaceSummary>,
    pub sync_workspace_id: Option<String>,
}

/// Serialized shape = `SignUpResult` in shared-types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignUpResult {
    /// `signedIn` | `confirmationRequired`.
    pub status: String,
    pub account: AccountStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AccountError {
    #[error("{0}")]
    NotConfigured(String),
    #[error("Sign in first.")]
    NotSignedIn,
    /// Input the user can fix (empty email, short password, unknown workspace id…).
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Remote(#[from] RemoteError),
    /// Credential Manager or local database failure.
    #[error("{0}")]
    Local(String),
}

/// A valid access token for one request batch, with the user it belongs to.
#[derive(Clone)]
pub struct AccessContext {
    pub access_token: String,
    pub user_id: String,
}

impl std::fmt::Debug for AccessContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccessContext")
            .field("access_token", &"<redacted>")
            .field("user_id", &self.user_id)
            .finish()
    }
}

/// Called after every status change (emits `account://changed`, nudges the sync service).
pub type AccountObserver = Box<dyn Fn(&AccountStatus) + Send + Sync>;

pub struct AccountManager {
    #[allow(dead_code)]
    config: Result<SupabaseConfig, ConfigError>,
    #[allow(dead_code)]
    api: Option<Arc<dyn RemoteApi>>,
    #[allow(dead_code)]
    credentials: Arc<dyn CredentialStore>,
    #[allow(dead_code)]
    ledger: Arc<dyn SyncLedger>,
    #[allow(dead_code)]
    clock: Box<dyn Fn() -> EpochMs + Send + Sync>,
    #[allow(dead_code)]
    observer: Mutex<Option<AccountObserver>>,
}

impl AccountManager {
    /// `api` is `None` when `config` is an error (nothing to talk to).
    pub fn new(
        config: Result<SupabaseConfig, ConfigError>,
        api: Option<Arc<dyn RemoteApi>>,
        credentials: Arc<dyn CredentialStore>,
        ledger: Arc<dyn SyncLedger>,
        clock: Box<dyn Fn() -> EpochMs + Send + Sync>,
    ) -> Self {
        Self {
            config,
            api,
            credentials,
            ledger,
            clock,
            observer: Mutex::new(None),
        }
    }

    pub fn set_observer(&self, _observer: AccountObserver) {
        todo!("AccountManager::set_observer")
    }

    /// Startup: load the stored session and try to refresh it. Offline → `SignedIn` without an
    /// access token (retried later); rejected refresh token → `SessionExpired`.
    pub fn restore(&self) {
        todo!("AccountManager::restore")
    }

    pub fn status(&self) -> AccountStatus {
        todo!("AccountManager::status")
    }

    pub fn current_user_id(&self) -> Option<String> {
        todo!("AccountManager::current_user_id")
    }

    pub fn sign_in(&self, _email: &str, _password: &str) -> Result<AccountStatus, AccountError> {
        todo!("AccountManager::sign_in")
    }

    pub fn sign_up(
        &self,
        _email: &str,
        _password: &str,
        _display_name: &str,
    ) -> Result<SignUpResult, AccountError> {
        todo!("AccountManager::sign_up")
    }

    /// Best-effort server sign-out, then clear the stored session and the account stamp. Local
    /// intervals (including this user's pending ones) are kept.
    pub fn sign_out(&self) -> Result<AccountStatus, AccountError> {
        todo!("AccountManager::sign_out")
    }

    pub fn refresh_workspaces(&self) -> Result<AccountStatus, AccountError> {
        todo!("AccountManager::refresh_workspaces")
    }

    /// Creates the workspace (the caller becomes owner) and selects it for sync when none is
    /// selected yet.
    pub fn create_workspace(&self, _name: &str) -> Result<AccountStatus, AccountError> {
        todo!("AccountManager::create_workspace")
    }

    /// `Some(id)` must be one of the user's active memberships (refreshed from the server first);
    /// `None` stops uploading.
    pub fn select_sync_workspace(
        &self,
        _workspace_id: Option<&str>,
    ) -> Result<AccountStatus, AccountError> {
        todo!("AccountManager::select_sync_workspace")
    }

    pub fn accept_invitation(&self, _token: &str) -> Result<AccountStatus, AccountError> {
        todo!("AccountManager::accept_invitation")
    }

    pub fn create_invitation(
        &self,
        _workspace_id: &str,
        _email: &str,
        _role: WorkspaceRole,
    ) -> Result<InvitationCreated, AccountError> {
        todo!("AccountManager::create_invitation")
    }

    /// A valid access token, refreshing when it expires within [`REFRESH_MARGIN_MS`].
    pub fn access(&self) -> Result<AccessContext, AccountError> {
        todo!("AccountManager::access")
    }

    /// The server rejected the access token: refresh once; if the refresh token is rejected too,
    /// move to `SessionExpired` (nothing local is deleted).
    pub fn handle_unauthorized(&self) -> Result<AccessContext, AccountError> {
        todo!("AccountManager::handle_unauthorized")
    }
}
