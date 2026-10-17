//! The remote contract: everything the desktop asks of Supabase, as a trait so the account
//! manager and sync service can be tested with a fake ([`RemoteApi`]).
//!
//! Remote schema and functions: `supabase/migrations/*.sql`.

use serde::{Deserialize, Serialize};

/// A signed-in Supabase Auth session. `Debug` never prints the tokens.
#[derive(Clone, PartialEq, Eq)]
pub struct AuthSession {
    pub access_token: String,
    pub refresh_token: String,
    /// UTC epoch ms when the access token expires.
    pub expires_at_ms: i64,
    pub user: AuthUser,
}

impl std::fmt::Debug for AuthSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthSession")
            .field("access_token", &"<redacted>")
            .field("refresh_token", &"<redacted>")
            .field("expires_at_ms", &self.expires_at_ms)
            .field("user", &self.user)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    /// auth.users.id (UUID).
    pub id: String,
    pub email: Option<String>,
    /// `user_metadata.display_name`, when set at sign-up.
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignUpOutcome {
    /// The project does not require email confirmation: the user is signed in.
    SignedIn(AuthSession),
    /// The project requires the user to confirm their email before signing in.
    ConfirmationRequired,
}

/// Serialized shape = `WorkspaceRole` in shared-types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceRole {
    Owner,
    Admin,
    Member,
}

/// Serialized shape = `TimeEntryVisibility` in shared-types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimeEntryVisibility {
    Private,
    Admins,
}

/// Serialized shape = `WorkspaceSummary` in shared-types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    pub role: WorkspaceRole,
    pub time_entry_visibility: TimeEntryVisibility,
}

/// Serialized shape = `InvitationCreated` in shared-types. `Debug` never prints the token.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationCreated {
    pub invitation_id: String,
    pub token: String,
    /// ISO-8601.
    pub expires_at: String,
}

impl std::fmt::Debug for InvitationCreated {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InvitationCreated")
            .field("invitation_id", &self.invitation_id)
            .field("token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// One entry of the `sync_time_entries` payload, serialized exactly as the SQL function reads
/// it (camelCase keys). Built from a closed local interval; nothing here is derived or invented.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTimeEntry {
    pub id: String,
    pub device_id: String,
    pub application_id: String,
    pub application_name: String,
    /// `active` | `idle`.
    pub kind: String,
    /// ISO-8601 UTC with milliseconds.
    pub started_at: String,
    pub ended_at: String,
    pub active_ms: i64,
    pub idle_ms: i64,
    pub end_reason: String,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub revision: i64,
    /// When the desktop first recorded the interval (ISO-8601 UTC).
    pub recorded_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryOutcome {
    /// Inserted now, or already present and owned by the caller (a retry after a lost response).
    Synced,
    /// The entry itself is invalid or its id belongs to someone else; retrying cannot succeed.
    Rejected(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryResult {
    pub id: String,
    pub outcome: EntryOutcome,
}

/// Everything that can go wrong talking to Supabase. Messages are shown to the user and logged:
/// they never contain tokens, passwords or response bodies with user data.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RemoteError {
    /// DNS, connection, TLS or timeout. Transient.
    #[error("Can't reach Supabase ({0}).")]
    Network(String),
    /// 401 / expired or invalid JWT. The caller refreshes the session and retries once.
    #[error("The session has expired.")]
    Unauthorized,
    #[error("Wrong email or password.")]
    InvalidCredentials,
    #[error("Confirm your email address before signing in.")]
    EmailNotConfirmed,
    /// 403 / SQLSTATE 42501 / 28000: not allowed (e.g. not a member of the workspace).
    #[error("{0}")]
    Forbidden(String),
    /// P0002 / 404.
    #[error("{0}")]
    NotFound(String),
    /// A 4xx the user can act on (weak password, email already registered, invalid input).
    #[error("{0}")]
    Rejected(String),
    /// 429.
    #[error("Supabase is limiting requests. Studio Pulse will try again shortly.")]
    RateLimited { retry_after_ms: Option<u64> },
    /// 5xx. Transient.
    #[error("Supabase returned an error (HTTP {0}).")]
    Server(u16),
}

impl RemoteError {
    /// Retrying later may succeed without the user doing anything.
    pub fn is_transient(&self) -> bool {
        matches!(
            self,
            Self::Network(_) | Self::RateLimited { .. } | Self::Server(_)
        )
    }
}

/// The remote operations. Implementations must be safe to call from any thread.
pub trait RemoteApi: Send + Sync {
    /// Auth: `POST /auth/v1/token?grant_type=password`.
    fn sign_in_with_password(
        &self,
        email: &str,
        password: &str,
    ) -> Result<AuthSession, RemoteError>;

    /// Auth: `POST /auth/v1/signup` with `data.display_name`.
    fn sign_up(
        &self,
        email: &str,
        password: &str,
        display_name: &str,
    ) -> Result<SignUpOutcome, RemoteError>;

    /// Auth: `POST /auth/v1/token?grant_type=refresh_token`. Refresh tokens rotate: persist the
    /// returned one.
    fn refresh_session(&self, refresh_token: &str) -> Result<AuthSession, RemoteError>;

    /// Auth: `POST /auth/v1/logout` (best effort; revokes the refresh token server-side).
    fn sign_out(&self, access_token: &str) -> Result<(), RemoteError>;

    /// RPC `my_workspaces()`.
    fn my_workspaces(&self, access_token: &str) -> Result<Vec<WorkspaceSummary>, RemoteError>;

    /// RPC `create_workspace(p_name)`. Returns the new workspace id.
    fn create_workspace(&self, access_token: &str, name: &str) -> Result<String, RemoteError>;

    /// RPC `accept_invitation(p_token)`. Returns the workspace id.
    fn accept_invitation(&self, access_token: &str, token: &str) -> Result<String, RemoteError>;

    /// RPC `create_invitation(p_workspace_id, p_email, p_role)`.
    fn create_invitation(
        &self,
        access_token: &str,
        workspace_id: &str,
        email: &str,
        role: WorkspaceRole,
    ) -> Result<InvitationCreated, RemoteError>;

    /// RPC `sync_time_entries(p_workspace_id, p_entries)`: one result per entry.
    fn sync_time_entries(
        &self,
        access_token: &str,
        workspace_id: &str,
        entries: &[RemoteTimeEntry],
    ) -> Result<Vec<EntryResult>, RemoteError>;
}
