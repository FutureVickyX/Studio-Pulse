//! The real [`RemoteApi`]: Supabase Auth REST and PostgREST RPCs over blocking `reqwest` with the
//! Windows-native TLS stack (Schannel).
//!
//! Every request carries `apikey: <publishable key>`; authenticated requests add
//! `Authorization: Bearer <user access token>`, so the database evaluates Row Level Security as
//! that user. Error bodies are mapped to [`RemoteError`] variants and are never logged verbatim
//! (they may echo user input).

use super::api::{
    AuthSession, EntryResult, InvitationCreated, RemoteApi, RemoteError, RemoteTimeEntry,
    SignUpOutcome, WorkspaceRole, WorkspaceSummary,
};
use super::config::SupabaseConfig;

/// Connect timeout for every request.
pub const CONNECT_TIMEOUT_SECS: u64 = 10;
/// Overall timeout for every request.
pub const REQUEST_TIMEOUT_SECS: u64 = 30;

pub struct SupabaseHttp {
    #[allow(dead_code)]
    config: SupabaseConfig,
}

impl SupabaseHttp {
    pub fn new(config: SupabaseConfig) -> Result<Self, RemoteError> {
        Ok(Self { config })
    }
}

impl RemoteApi for SupabaseHttp {
    fn sign_in_with_password(
        &self,
        _email: &str,
        _password: &str,
    ) -> Result<AuthSession, RemoteError> {
        todo!("SupabaseHttp::sign_in_with_password")
    }

    fn sign_up(
        &self,
        _email: &str,
        _password: &str,
        _display_name: &str,
    ) -> Result<SignUpOutcome, RemoteError> {
        todo!("SupabaseHttp::sign_up")
    }

    fn refresh_session(&self, _refresh_token: &str) -> Result<AuthSession, RemoteError> {
        todo!("SupabaseHttp::refresh_session")
    }

    fn sign_out(&self, _access_token: &str) -> Result<(), RemoteError> {
        todo!("SupabaseHttp::sign_out")
    }

    fn my_workspaces(&self, _access_token: &str) -> Result<Vec<WorkspaceSummary>, RemoteError> {
        todo!("SupabaseHttp::my_workspaces")
    }

    fn create_workspace(&self, _access_token: &str, _name: &str) -> Result<String, RemoteError> {
        todo!("SupabaseHttp::create_workspace")
    }

    fn accept_invitation(&self, _access_token: &str, _token: &str) -> Result<String, RemoteError> {
        todo!("SupabaseHttp::accept_invitation")
    }

    fn create_invitation(
        &self,
        _access_token: &str,
        _workspace_id: &str,
        _email: &str,
        _role: WorkspaceRole,
    ) -> Result<InvitationCreated, RemoteError> {
        todo!("SupabaseHttp::create_invitation")
    }

    fn sync_time_entries(
        &self,
        _access_token: &str,
        _workspace_id: &str,
        _entries: &[RemoteTimeEntry],
    ) -> Result<Vec<EntryResult>, RemoteError> {
        todo!("SupabaseHttp::sync_time_entries")
    }
}
