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
//!
//! Concurrency: the state lives behind one mutex that is never held across a network call (only
//! across quick local writes: Credential Manager and the ledger). Token refreshes are serialized
//! by a separate gate so two threads never spend the same rotating refresh token; results of a
//! network call that finishes after a sign-in/out are discarded (a generation counter).

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;

use super::api::{
    AuthSession, InvitationCreated, RemoteApi, RemoteError, SignUpOutcome, WorkspaceRole,
    WorkspaceSummary,
};
use super::config::{ConfigError, SupabaseConfig};
use super::credentials::{CredentialStore, StoredSession};
use super::ledger::SyncLedger;
use crate::tracker::EpochMs;

/// Refresh the access token when it expires within this window.
pub const REFRESH_MARGIN_MS: i64 = 60_000;

/// Supabase Auth's minimum password length (projects may require more; the server says so).
const MIN_PASSWORD_CHARS: usize = 6;
/// Display names and workspace names: 1..=80 characters after trimming (same as the schema).
const MAX_NAME_CHARS: usize = 80;
const MAX_EMAIL_CHARS: usize = 254;

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

/// Who is signed in (what is shown while offline or after expiry).
#[derive(Clone, PartialEq, Eq)]
struct UserInfo {
    id: String,
    email: Option<String>,
    display_name: Option<String>,
}

/// Mutable account state. Tokens never leave this struct except inside an [`AccessContext`].
struct Inner {
    state: AccountState,
    user: Option<UserInfo>,
    refresh_token: Option<String>,
    access_token: Option<String>,
    expires_at_ms: EpochMs,
    /// Memberships as last fetched (meaningful only while signed in).
    workspaces: Vec<WorkspaceSummary>,
    /// `workspaces` was fetched for the current session (false after an offline restore, or
    /// when the fetch failed), so [`AccountManager::ensure_workspaces_loaded`] has work to do.
    workspaces_loaded: bool,
    /// Bumped whenever the identity changes (sign-in, sign-out, expiry): network results that
    /// started under an older generation are discarded.
    generation: u64,
    /// Bumped whenever the tokens change, so a caller waiting to refresh can tell that another
    /// caller already did.
    token_epoch: u64,
}

impl Inner {
    fn new(state: AccountState) -> Self {
        Self {
            state,
            user: None,
            refresh_token: None,
            access_token: None,
            expires_at_ms: 0,
            workspaces: Vec::new(),
            workspaces_loaded: false,
            generation: 0,
            token_epoch: 0,
        }
    }

    /// Forget the session (tokens, memberships); the caller sets the new state.
    fn drop_session(&mut self) {
        self.refresh_token = None;
        self.access_token = None;
        self.expires_at_ms = 0;
        self.workspaces.clear();
        self.workspaces_loaded = false;
        self.generation += 1;
        self.token_epoch += 1;
    }

    fn user_id(&self) -> Option<&str> {
        self.user.as_ref().map(|u| u.id.as_str())
    }

    /// The current access token if it is still valid `margin_ms` from now.
    fn usable_access(&self, now: EpochMs, margin_ms: i64) -> Option<AccessContext> {
        if self.state != AccountState::SignedIn {
            return None;
        }
        let token = self.access_token.as_ref()?;
        let user_id = self.user_id()?;
        (self.expires_at_ms.saturating_sub(now) > margin_ms).then(|| AccessContext {
            access_token: token.clone(),
            user_id: user_id.to_owned(),
        })
    }
}

/// An access token this close to expiry is not used to sign out (the server would answer 401,
/// which looks the same as "already signed out"); a refresh obtains a fresh one first.
const SIGN_OUT_MARGIN_MS: i64 = 10_000;

/// How [`AccountManager::sign_out`] revokes the server session.
enum Revoke {
    Access(String),
    Refresh(String),
}

/// What to do with the sync workspace after a fresh membership list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Selection<'a> {
    /// Only drop a selection that is no longer a membership.
    Keep,
    /// Also select the only membership when nothing is selected.
    AutoSingle,
    /// Also select this workspace when nothing is selected.
    PreferIfNone(&'a str),
}

pub struct AccountManager {
    config: Result<SupabaseConfig, ConfigError>,
    api: Option<Arc<dyn RemoteApi>>,
    credentials: Arc<dyn CredentialStore>,
    ledger: Arc<dyn SyncLedger>,
    clock: Box<dyn Fn() -> EpochMs + Send + Sync>,
    observer: Mutex<Option<AccountObserver>>,
    inner: Mutex<Inner>,
    /// Serializes token refreshes (held across the refresh call only).
    refresh_gate: Mutex<()>,
    /// The status last passed to the observer (to call it only on change).
    last_notified: Mutex<Option<AccountStatus>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn local(err: impl std::fmt::Display) -> AccountError {
    AccountError::Local(err.to_string())
}

const NO_CLIENT: &str = "Studio Pulse couldn't start its connection to Supabase.";

impl AccountManager {
    /// `api` is `None` when `config` is an error (nothing to talk to).
    pub fn new(
        config: Result<SupabaseConfig, ConfigError>,
        api: Option<Arc<dyn RemoteApi>>,
        credentials: Arc<dyn CredentialStore>,
        ledger: Arc<dyn SyncLedger>,
        clock: Box<dyn Fn() -> EpochMs + Send + Sync>,
    ) -> Self {
        let configured = config.is_ok() && api.is_some();
        Self {
            config,
            api,
            credentials,
            ledger,
            clock,
            observer: Mutex::new(None),
            inner: Mutex::new(Inner::new(if configured {
                AccountState::SignedOut
            } else {
                AccountState::NotConfigured
            })),
            refresh_gate: Mutex::new(()),
            last_notified: Mutex::new(None),
        }
    }

    pub fn set_observer(&self, observer: AccountObserver) {
        let mut slot = lock(&self.observer);
        *slot = Some(observer);
        *lock(&self.last_notified) = None;
    }

    /// Startup: load the stored session and try to refresh it. Offline → `SignedIn` without an
    /// access token (retried later); rejected refresh token → `SessionExpired`.
    pub fn restore(&self) {
        if self.api().is_err() {
            lock(&self.inner).state = AccountState::NotConfigured;
            self.notify();
            return;
        }
        let stored = match self.credentials.load() {
            Ok(stored) => stored,
            Err(err) => {
                log::warn!("could not read the saved sign-in: {err}");
                None
            }
        };
        let Some(stored) = stored else {
            {
                let mut inner = lock(&self.inner);
                inner.drop_session();
                inner.user = None;
                inner.state = AccountState::SignedOut;
                // Nobody is signed in on this device: new intervals stay unowned.
                match self.ledger.account_user() {
                    Ok(None) => {}
                    Ok(Some(_)) => {
                        if let Err(err) = self.ledger.set_account_user(None) {
                            log::warn!("could not clear the account stamp: {err}");
                        }
                    }
                    Err(err) => log::warn!("could not read the account stamp: {err}"),
                }
            }
            self.notify();
            return;
        };

        let epoch = {
            let mut inner = lock(&self.inner);
            inner.drop_session();
            inner.state = AccountState::SignedIn;
            inner.user = Some(UserInfo {
                id: stored.user_id.clone(),
                email: stored.email.clone(),
                display_name: stored.display_name.clone(),
            });
            inner.refresh_token = Some(stored.refresh_token.clone());
            // Heal the stamp if it was lost: this account owns what is recorded from now on.
            match self.ledger.account_user() {
                Ok(owner) if owner.as_deref() == Some(stored.user_id.as_str()) => {}
                Ok(owner) => {
                    if owner.is_some() {
                        // The stamp named someone else: their workspace is not this account's.
                        if let Err(err) = self.ledger.set_sync_workspace(None) {
                            log::warn!("could not clear the sync workspace: {err}");
                        }
                    }
                    if let Err(err) = self.ledger.set_account_user(Some(&stored.user_id)) {
                        log::warn!("could not stamp the account on new intervals: {err}");
                    }
                }
                Err(err) => log::warn!("could not read the account stamp: {err}"),
            }
            inner.token_epoch
        };
        // Publish "signed in (offline)" right away; the refresh below may take a while.
        self.notify();

        match self.refresh_tokens(epoch, true) {
            Ok(ctx) => {
                if let Err(err) = self.fetch_and_apply_workspaces(&ctx, Selection::Keep) {
                    log::info!("could not load workspaces at startup: {err}");
                }
            }
            Err(err) => log::info!("session restore: {err}"),
        }
        self.notify();
    }

    pub fn status(&self) -> AccountStatus {
        let (state, user, workspaces) = {
            let inner = lock(&self.inner);
            let workspaces = if inner.state == AccountState::SignedIn {
                inner.workspaces.clone()
            } else {
                Vec::new()
            };
            (inner.state, inner.user.clone(), workspaces)
        };
        let configuration_error = (state == AccountState::NotConfigured)
            .then(|| self.configuration_error())
            .flatten();
        let sync_workspace_id = if state == AccountState::NotConfigured {
            None
        } else {
            self.ledger.sync_workspace().unwrap_or_else(|err| {
                log::warn!("could not read the sync workspace: {err}");
                None
            })
        };
        let user = match state {
            AccountState::SignedIn | AccountState::SessionExpired => user,
            AccountState::NotConfigured | AccountState::SignedOut => None,
        };
        AccountStatus {
            state,
            configuration_error,
            user_id: user.as_ref().map(|u| u.id.clone()),
            email: user.as_ref().and_then(|u| u.email.clone()),
            display_name: user.as_ref().and_then(|u| u.display_name.clone()),
            workspaces,
            sync_workspace_id,
        }
    }

    pub fn current_user_id(&self) -> Option<String> {
        let inner = lock(&self.inner);
        if inner.state == AccountState::SignedIn {
            inner.user_id().map(str::to_owned)
        } else {
            None
        }
    }

    pub fn sign_in(&self, email: &str, password: &str) -> Result<AccountStatus, AccountError> {
        let api = self.api()?;
        let email = validate_email(email)?;
        validate_password(password)?;
        let session = api.sign_in_with_password(&email, password)?;
        let ctx = self.establish_session(api.as_ref(), session)?;
        self.after_sign_in(&ctx);
        self.notify();
        Ok(self.status())
    }

    pub fn sign_up(
        &self,
        email: &str,
        password: &str,
        display_name: &str,
    ) -> Result<SignUpResult, AccountError> {
        let api = self.api()?;
        let email = validate_email(email)?;
        validate_password(password)?;
        let display_name = validate_name(display_name, "Enter a display name")?;
        match api.sign_up(&email, password, &display_name)? {
            SignUpOutcome::SignedIn(session) => {
                let ctx = self.establish_session(api.as_ref(), session)?;
                self.after_sign_in(&ctx);
                self.notify();
                Ok(SignUpResult {
                    status: "signedIn".into(),
                    account: self.status(),
                })
            }
            SignUpOutcome::ConfirmationRequired => Ok(SignUpResult {
                status: "confirmationRequired".into(),
                account: self.status(),
            }),
        }
    }

    /// Clear the stored session and the account stamp, then a best-effort server sign-out. Local
    /// intervals (including this user's pending ones) are kept.
    ///
    /// The local part comes first, so the app is signed out immediately whatever the network
    /// does. If any of it fails, the account stays signed in and the error is returned: looking
    /// signed out while the saved sign-in or the stamp survived would let the next launch sign
    /// this account back in, or give it intervals recorded "while signed out".
    pub fn sign_out(&self) -> Result<AccountStatus, AccountError> {
        let Ok(api) = self.api() else {
            return Ok(self.status());
        };
        let cleared = {
            let mut inner = lock(&self.inner);
            match self.clear_local_session() {
                Ok(()) => {
                    let revoke = if inner.state == AccountState::SignedIn {
                        match inner.usable_access((self.clock)(), SIGN_OUT_MARGIN_MS) {
                            Some(ctx) => Some(Revoke::Access(ctx.access_token)),
                            None => inner.refresh_token.clone().map(Revoke::Refresh),
                        }
                    } else {
                        None
                    };
                    inner.drop_session();
                    inner.user = None;
                    inner.state = AccountState::SignedOut;
                    Ok(revoke)
                }
                Err(problem) => Err(problem),
            }
        };
        // Also after a failure: the sync workspace may already be cleared.
        self.notify();
        let revoke = cleared.map_err(|problem| {
            AccountError::Local(format!(
                "Couldn't finish signing out ({problem}). You're still signed in; try again."
            ))
        })?;
        // Best effort: revoke this device's session server-side. Without a usable access token
        // (offline since launch, or expired) one refresh obtains it; the rotated token it returns
        // is revoked by the same logout and never stored.
        let access_token = match revoke {
            Some(Revoke::Access(token)) => Some(token),
            Some(Revoke::Refresh(refresh_token)) => match api.refresh_session(&refresh_token) {
                Ok(session) => Some(session.access_token),
                Err(err) => {
                    log::info!("server sign-out skipped ({err}); the session lapses on its own");
                    None
                }
            },
            None => None,
        };
        if let Some(token) = access_token {
            if let Err(err) = api.sign_out(&token) {
                log::info!(
                    "server sign-out did not complete ({err}); the session lapses on its own"
                );
            }
        }
        Ok(self.status())
    }

    /// The local half of signing out, in an order where a failure part-way leaves a consistent,
    /// still-signed-in state: the saved sign-in, then the sync workspace (the next account
    /// chooses its own), then the stamp (new intervals stay unowned until claimed). Called with
    /// the `inner` lock held.
    fn clear_local_session(&self) -> Result<(), String> {
        self.credentials
            .clear()
            .or_else(|_| self.credentials.clear())
            .map_err(|err| err.to_string())?;
        self.ledger
            .set_sync_workspace(None)
            .map_err(|err| err.to_string())?;
        self.ledger
            .set_account_user(None)
            .map_err(|err| err.to_string())
    }

    /// Load the memberships if this session has none yet: the restore ran offline, or the fetch
    /// failed. Without this they would stay unknown until the user pressed Refresh. Best effort,
    /// and a no-op once loaded; the sync thread calls it on every pass while signed in, so it is
    /// retried with the pass's backoff.
    pub fn ensure_workspaces_loaded(&self) {
        {
            let inner = lock(&self.inner);
            if inner.state != AccountState::SignedIn || inner.workspaces_loaded {
                return;
            }
        }
        if let Err(err) = self.refresh_workspaces() {
            log::info!("workspaces not loaded yet: {err}");
        }
    }

    pub fn refresh_workspaces(&self) -> Result<AccountStatus, AccountError> {
        let (workspaces, ctx) =
            self.with_access(|api, ctx| api.my_workspaces(&ctx.access_token))?;
        self.apply_workspaces(&ctx.user_id, workspaces, Selection::Keep)?;
        self.notify();
        Ok(self.status())
    }

    /// Creates the workspace (the caller becomes owner) and selects it for sync when none is
    /// selected yet.
    pub fn create_workspace(&self, name: &str) -> Result<AccountStatus, AccountError> {
        let name = validate_name(name, "Enter a workspace name")?;
        let (workspace_id, ctx) =
            self.with_access(|api, ctx| api.create_workspace(&ctx.access_token, &name))?;
        let workspaces = match self.with_access(|api, ctx| api.my_workspaces(&ctx.access_token)) {
            Ok((workspaces, _)) => workspaces,
            Err(err) => {
                log::warn!("created a workspace but could not reload memberships: {err}");
                // create_workspace makes the caller its owner with the default visibility.
                let mut workspaces = lock(&self.inner).workspaces.clone();
                if !workspaces.iter().any(|w| same_id(&w.id, &workspace_id)) {
                    workspaces.push(WorkspaceSummary {
                        id: workspace_id.clone(),
                        name: name.clone(),
                        role: WorkspaceRole::Owner,
                        time_entry_visibility: super::api::TimeEntryVisibility::Private,
                    });
                }
                workspaces
            }
        };
        self.apply_workspaces(
            &ctx.user_id,
            workspaces,
            Selection::PreferIfNone(&workspace_id),
        )?;
        self.notify();
        Ok(self.status())
    }

    /// `Some(id)` must be one of the user's active memberships (refreshed from the server first);
    /// `None` stops uploading.
    pub fn select_sync_workspace(
        &self,
        workspace_id: Option<&str>,
    ) -> Result<AccountStatus, AccountError> {
        self.api()?;
        let Some(requested) = workspace_id else {
            {
                let _inner = lock(&self.inner);
                self.ledger.set_sync_workspace(None).map_err(local)?;
            }
            self.notify();
            return Ok(self.status());
        };
        let requested = requested.trim();
        if requested.is_empty() {
            return Err(AccountError::Invalid("Choose a workspace.".into()));
        }
        let (workspaces, ctx) =
            self.with_access(|api, ctx| api.my_workspaces(&ctx.access_token))?;
        let chosen = workspaces
            .iter()
            .find(|w| same_id(&w.id, requested))
            .map(|w| w.id.clone());
        self.apply_workspaces(&ctx.user_id, workspaces, Selection::Keep)?;
        let Some(chosen) = chosen else {
            self.notify();
            return Err(AccountError::Invalid(
                "You're not a member of that workspace.".into(),
            ));
        };
        {
            let inner = lock(&self.inner);
            if inner.state != AccountState::SignedIn || inner.user_id() != Some(&ctx.user_id) {
                return Err(AccountError::NotSignedIn);
            }
            self.ledger
                .set_sync_workspace(Some(&chosen))
                .map_err(local)?;
        }
        self.notify();
        Ok(self.status())
    }

    pub fn accept_invitation(&self, token: &str) -> Result<AccountStatus, AccountError> {
        let token = validate_invitation_token(token)?;
        let (workspace_id, _ctx) =
            self.with_access(|api, ctx| api.accept_invitation(&ctx.access_token, &token))?;
        match self.with_access(|api, ctx| api.my_workspaces(&ctx.access_token)) {
            Ok((workspaces, ctx)) => {
                // With nothing selected yet, upload to the workspace just joined.
                self.apply_workspaces(
                    &ctx.user_id,
                    workspaces,
                    Selection::PreferIfNone(&workspace_id),
                )?;
            }
            Err(err) => log::warn!("joined a workspace but could not reload memberships: {err}"),
        }
        self.notify();
        Ok(self.status())
    }

    pub fn create_invitation(
        &self,
        workspace_id: &str,
        email: &str,
        role: WorkspaceRole,
    ) -> Result<InvitationCreated, AccountError> {
        if role == WorkspaceRole::Owner {
            return Err(AccountError::Invalid(
                "Invitations can't make someone an owner.".into(),
            ));
        }
        let email = validate_email(email)?;
        let workspace_id = workspace_id.trim();
        if workspace_id.is_empty() {
            return Err(AccountError::Invalid("Choose a workspace.".into()));
        }
        let (invitation, _) = self.with_access(|api, ctx| {
            api.create_invitation(&ctx.access_token, workspace_id, &email, role)
        })?;
        Ok(invitation)
    }

    /// A valid access token, refreshing when it expires within [`REFRESH_MARGIN_MS`].
    pub fn access(&self) -> Result<AccessContext, AccountError> {
        self.api()?;
        let epoch = {
            let inner = lock(&self.inner);
            if inner.state != AccountState::SignedIn {
                return Err(AccountError::NotSignedIn);
            }
            if let Some(ctx) = inner.usable_access((self.clock)(), REFRESH_MARGIN_MS) {
                return Ok(ctx);
            }
            inner.token_epoch
        };
        self.refresh_tokens(epoch, false)
    }

    /// The server rejected the access token: refresh once; if the refresh token is rejected too,
    /// move to `SessionExpired` (nothing local is deleted).
    pub fn handle_unauthorized(&self) -> Result<AccessContext, AccountError> {
        self.api()?;
        let epoch = {
            let inner = lock(&self.inner);
            if inner.state != AccountState::SignedIn {
                return Err(AccountError::NotSignedIn);
            }
            inner.token_epoch
        };
        self.refresh_tokens(epoch, true)
    }

    // ---- private ------------------------------------------------------------------------

    fn api(&self) -> Result<&Arc<dyn RemoteApi>, AccountError> {
        match (&self.config, &self.api) {
            (Ok(_), Some(api)) => Ok(api),
            (Err(err), _) => Err(AccountError::NotConfigured(err.to_string())),
            (Ok(_), None) => Err(AccountError::NotConfigured(NO_CLIENT.into())),
        }
    }

    fn configuration_error(&self) -> Option<String> {
        match (&self.config, &self.api) {
            (Err(err), _) => Some(err.to_string()),
            (Ok(_), None) => Some(NO_CLIENT.into()),
            (Ok(_), Some(_)) => None,
        }
    }

    /// Call the observer when the status differs from the one it last saw.
    fn notify(&self) {
        let observer = lock(&self.observer);
        let status = self.status();
        {
            let mut last = lock(&self.last_notified);
            if last.as_ref() == Some(&status) {
                return;
            }
            *last = Some(status.clone());
        }
        if let Some(callback) = observer.as_ref() {
            callback(&status);
        }
    }

    /// Persist a fresh session and make it current. On a local failure nothing is kept and the
    /// new server session is revoked (best effort).
    fn establish_session(
        &self,
        api: &dyn RemoteApi,
        session: AuthSession,
    ) -> Result<AccessContext, AccountError> {
        let stored = StoredSession {
            refresh_token: session.refresh_token.clone(),
            user_id: session.user.id.clone(),
            email: session.user.email.clone(),
            display_name: session.user.display_name.clone(),
        };
        let result = {
            let mut inner = lock(&self.inner);
            let persisted = (|| -> Result<(), AccountError> {
                self.credentials.save(&stored).map_err(local)?;
                let previous_owner = self.ledger.account_user().map_err(local)?;
                if previous_owner.as_deref() != Some(session.user.id.as_str()) {
                    // A workspace chosen by (or for) someone else is not this account's choice.
                    self.ledger.set_sync_workspace(None).map_err(local)?;
                }
                self.ledger
                    .set_account_user(Some(&session.user.id))
                    .map_err(local)?;
                Ok(())
            })();
            match persisted {
                Ok(()) => {
                    inner.drop_session();
                    inner.state = AccountState::SignedIn;
                    inner.user = Some(UserInfo {
                        id: session.user.id.clone(),
                        email: session.user.email.clone(),
                        display_name: session.user.display_name.clone(),
                    });
                    inner.refresh_token = Some(session.refresh_token.clone());
                    inner.access_token = Some(session.access_token.clone());
                    inner.expires_at_ms = session.expires_at_ms;
                    Ok(AccessContext {
                        access_token: session.access_token.clone(),
                        user_id: session.user.id.clone(),
                    })
                }
                Err(err) => {
                    // Do not leave a half-saved sign-in behind for the current (old) state.
                    if inner.state != AccountState::SignedIn {
                        if let Err(clear_err) = self.credentials.clear() {
                            log::warn!("could not remove a partial sign-in: {clear_err}");
                        }
                    } else if let (Some(user), Some(refresh)) =
                        (inner.user.clone(), inner.refresh_token.clone())
                    {
                        // Put the previous account's credential back.
                        let previous = StoredSession {
                            refresh_token: refresh,
                            user_id: user.id,
                            email: user.email,
                            display_name: user.display_name,
                        };
                        if let Err(restore_err) = self.credentials.save(&previous) {
                            log::warn!("could not restore the previous sign-in: {restore_err}");
                        }
                    }
                    Err(err)
                }
            }
        };
        if result.is_err() {
            if let Err(err) = api.sign_out(&session.access_token) {
                log::info!("could not revoke the unused session: {err}");
            }
        }
        result
    }

    /// After a sign-in: load memberships and pick the only one when nothing is selected.
    fn after_sign_in(&self, ctx: &AccessContext) {
        if let Err(err) = self.fetch_and_apply_workspaces(ctx, Selection::AutoSingle) {
            log::warn!("signed in, but could not load workspaces: {err}");
        }
    }

    fn fetch_and_apply_workspaces(
        &self,
        ctx: &AccessContext,
        selection: Selection<'_>,
    ) -> Result<(), AccountError> {
        let api = self.api()?;
        let workspaces = match api.my_workspaces(&ctx.access_token) {
            Err(RemoteError::Unauthorized) => {
                let ctx = self.handle_unauthorized()?;
                api.my_workspaces(&ctx.access_token)?
            }
            other => other?,
        };
        self.apply_workspaces(&ctx.user_id, workspaces, selection)
    }

    /// Store a fresh membership list for `user_id` (ignored when another identity is current)
    /// and reconcile the sync workspace with it.
    fn apply_workspaces(
        &self,
        user_id: &str,
        workspaces: Vec<WorkspaceSummary>,
        selection: Selection<'_>,
    ) -> Result<(), AccountError> {
        let mut inner = lock(&self.inner);
        if inner.state != AccountState::SignedIn || inner.user_id() != Some(user_id) {
            return Ok(());
        }
        let selected = self.ledger.sync_workspace().map_err(local)?;
        let selected = match selected {
            Some(id) if !workspaces.iter().any(|w| same_id(&w.id, &id)) => {
                log::info!(
                    "the sync workspace is no longer one of this account's memberships; uploads \
                     stop until another is chosen"
                );
                self.ledger.set_sync_workspace(None).map_err(local)?;
                None
            }
            other => other,
        };
        if selected.is_none() {
            let pick = match selection {
                Selection::Keep => None,
                Selection::AutoSingle => match workspaces.as_slice() {
                    [only] => Some(only.id.clone()),
                    _ => None,
                },
                Selection::PreferIfNone(id) => workspaces
                    .iter()
                    .find(|w| same_id(&w.id, id))
                    .map(|w| w.id.clone()),
            };
            if let Some(id) = pick {
                self.ledger.set_sync_workspace(Some(&id)).map_err(local)?;
            }
        }
        inner.workspaces = workspaces;
        inner.workspaces_loaded = true;
        Ok(())
    }

    /// Run `op` with a valid access token; on `Unauthorized`, refresh once and retry once.
    fn with_access<T>(
        &self,
        op: impl Fn(&dyn RemoteApi, &AccessContext) -> Result<T, RemoteError>,
    ) -> Result<(T, AccessContext), AccountError> {
        let api = self.api()?;
        let ctx = self.access()?;
        match op(api.as_ref(), &ctx) {
            Err(RemoteError::Unauthorized) => {
                let ctx = self.handle_unauthorized()?;
                let value = op(api.as_ref(), &ctx)?;
                Ok((value, ctx))
            }
            other => Ok((other?, ctx)),
        }
    }

    /// Exchange the refresh token for new tokens (serialized by `refresh_gate`).
    ///
    /// `observed_epoch` is the token epoch the caller saw: if another caller refreshed in the
    /// meantime, its fresh token is used instead of refreshing again. `force` refreshes even if
    /// the current token looks valid (the server rejected it).
    fn refresh_tokens(
        &self,
        observed_epoch: u64,
        force: bool,
    ) -> Result<AccessContext, AccountError> {
        let api = self.api()?;
        let (result, expired) = {
            let _gate = lock(&self.refresh_gate);
            let (refresh_token, generation) = {
                let inner = lock(&self.inner);
                if inner.state != AccountState::SignedIn {
                    return Err(AccountError::NotSignedIn);
                }
                let now = (self.clock)();
                if inner.token_epoch != observed_epoch {
                    if let Some(ctx) = inner.usable_access(now, 0) {
                        return Ok(ctx);
                    }
                } else if !force {
                    if let Some(ctx) = inner.usable_access(now, REFRESH_MARGIN_MS) {
                        return Ok(ctx);
                    }
                }
                let Some(refresh_token) = inner.refresh_token.clone() else {
                    return Err(AccountError::NotSignedIn);
                };
                (refresh_token, inner.generation)
            };
            let refreshed = api.refresh_session(&refresh_token);
            self.apply_refresh(refreshed, generation, force)
        };
        if expired {
            self.notify();
        }
        result
    }

    /// Apply a refresh result. Returns the outcome and whether the session just expired.
    fn apply_refresh(
        &self,
        refreshed: Result<AuthSession, RemoteError>,
        generation: u64,
        force: bool,
    ) -> (Result<AccessContext, AccountError>, bool) {
        let mut inner = lock(&self.inner);
        if inner.generation != generation || inner.state != AccountState::SignedIn {
            // Signed out (or in as someone else) while the refresh was in flight.
            return (Err(AccountError::NotSignedIn), false);
        }
        match refreshed {
            Ok(session) if inner.user_id() == Some(session.user.id.as_str()) => {
                let user = inner.user.get_or_insert_with(|| UserInfo {
                    id: session.user.id.clone(),
                    email: None,
                    display_name: None,
                });
                if session.user.email.is_some() {
                    user.email = session.user.email.clone();
                }
                if session.user.display_name.is_some() {
                    user.display_name = session.user.display_name.clone();
                }
                let stored = StoredSession {
                    refresh_token: session.refresh_token.clone(),
                    user_id: user.id.clone(),
                    email: user.email.clone(),
                    display_name: user.display_name.clone(),
                };
                // Refresh tokens rotate: the old one is spent, so always persist the new one.
                if let Err(err) = self.credentials.save(&stored) {
                    log::error!("could not save the refreshed sign-in: {err}");
                }
                inner.refresh_token = Some(session.refresh_token);
                inner.access_token = Some(session.access_token.clone());
                inner.expires_at_ms = session.expires_at_ms;
                inner.token_epoch += 1;
                (
                    Ok(AccessContext {
                        access_token: session.access_token,
                        user_id: stored.user_id,
                    }),
                    false,
                )
            }
            Ok(_) | Err(RemoteError::Unauthorized) | Err(RemoteError::Forbidden(_)) => {
                let err = match refreshed {
                    Err(err @ RemoteError::Forbidden(_)) => err,
                    Ok(_) => {
                        log::error!("a session refresh returned a different user; signing in again is required");
                        RemoteError::Unauthorized
                    }
                    _ => RemoteError::Unauthorized,
                };
                // The refresh token is dead. Keep who it was (for display) and every local row.
                inner.drop_session();
                inner.state = AccountState::SessionExpired;
                if let Err(clear_err) = self.credentials.clear() {
                    log::warn!("could not remove the expired sign-in: {clear_err}");
                }
                (Err(AccountError::Remote(err)), true)
            }
            Err(err) => {
                // Offline or a server problem: keep the session; a still-valid token stays usable.
                if !force {
                    if let Some(ctx) = inner.usable_access((self.clock)(), 0) {
                        return (Ok(ctx), false);
                    }
                }
                (Err(AccountError::Remote(err)), false)
            }
        }
    }
}

/// Workspace ids are UUIDs: compare them case-insensitively.
fn same_id(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// A plausible email address (the server has the final word). Returns it trimmed.
fn validate_email(email: &str) -> Result<String, AccountError> {
    let email = email.trim();
    let invalid = || AccountError::Invalid("Enter a valid email address.".into());
    if email.is_empty() || email.chars().count() > MAX_EMAIL_CHARS {
        return Err(invalid());
    }
    if email.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(invalid());
    }
    let mut parts = email.split('@');
    let (Some(local_part), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(invalid());
    };
    let domain_ok = domain.contains('.')
        && domain.split('.').all(|label| !label.is_empty())
        && !domain.starts_with('-');
    if local_part.is_empty() || !domain_ok {
        return Err(invalid());
    }
    Ok(email.to_owned())
}

fn validate_password(password: &str) -> Result<(), AccountError> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(AccountError::Invalid(format!(
            "Use a password of at least {MIN_PASSWORD_CHARS} characters."
        )));
    }
    Ok(())
}

/// 1..=80 characters after trimming, no control characters. Returns it trimmed.
fn validate_name(name: &str, what: &str) -> Result<String, AccountError> {
    let name = name.trim();
    let count = name.chars().count();
    if count == 0 || count > MAX_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(AccountError::Invalid(format!(
            "{what} of 1 to {MAX_NAME_CHARS} characters."
        )));
    }
    Ok(name.to_owned())
}

/// Invitation tokens are 64 hexadecimal characters (issued in lower case).
fn validate_invitation_token(token: &str) -> Result<String, AccountError> {
    let token = token.trim().to_ascii_lowercase();
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AccountError::Invalid(
            "That invitation code isn't valid. Paste the full code you were sent.".into(),
        ));
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_validation() {
        assert_eq!(
            validate_email("  ada@example.com ").unwrap(),
            "ada@example.com"
        );
        assert!(validate_email("a.b+tag@sub.example.co").is_ok());
        for bad in [
            "",
            "   ",
            "ada",
            "ada@",
            "@example.com",
            "ada@example",
            "ada@@example.com",
            "a@b@example.com",
            "ada @example.com",
            "ada@example..com",
            "ada@.example.com",
            "ada@example.com.",
        ] {
            assert!(validate_email(bad).is_err(), "{bad:?} should be rejected");
        }
        assert!(validate_email(&format!("{}@example.com", "a".repeat(250))).is_err());
    }

    #[test]
    fn password_minimum_is_six_characters_and_not_trimmed() {
        assert!(validate_password("12345").is_err());
        assert!(validate_password("123456").is_ok());
        assert!(validate_password("     6").is_ok());
        // Counted in characters, not bytes.
        assert!(validate_password("ééééé").is_err());
    }

    #[test]
    fn names_are_trimmed_and_bounded() {
        assert_eq!(validate_name("  Studio  ", "x").unwrap(), "Studio");
        assert!(validate_name("   ", "x").is_err());
        assert!(validate_name(&"n".repeat(80), "x").is_ok());
        assert!(validate_name(&"n".repeat(81), "x").is_err());
        assert!(validate_name("a\u{0007}b", "x").is_err());
    }

    #[test]
    fn invitation_tokens_are_64_hex_characters() {
        let token = "ab".repeat(32);
        assert_eq!(
            validate_invitation_token(&format!(" {token} ")).unwrap(),
            token
        );
        assert_eq!(
            validate_invitation_token(&token.to_ascii_uppercase()).unwrap(),
            token
        );
        assert!(validate_invitation_token("").is_err());
        assert!(validate_invitation_token(&"a".repeat(63)).is_err());
        assert!(validate_invitation_token(&"g".repeat(64)).is_err());
    }

    #[test]
    fn ids_compare_case_insensitively() {
        assert!(same_id("ABC-def", " abc-DEF"));
        assert!(!same_id("abc", "abd"));
    }

    #[test]
    fn access_context_debug_redacts_the_token() {
        let ctx = AccessContext {
            access_token: "eyJ.secret.sig".into(),
            user_id: "u1".into(),
        };
        assert!(!format!("{ctx:?}").contains("secret"));
    }
}
