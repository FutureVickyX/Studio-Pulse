//! Errors returned to the UI. Serialized shape = `CommandError` in shared-types.
//! Messages are written for people and never include file contents, window titles or SQL.

use serde::Serialize;

use crate::cloud::account::AccountError;
use crate::cloud::api::RemoteError;
use crate::startup::StartupError;
use crate::store::StoreError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Validation,
    NotFound,
    StartupRegistration,
    Storage,
    Platform,
    Internal,
    /// This build has no (valid) Supabase configuration.
    NotConfigured,
    /// No session, or the session expired: sign in.
    Unauthenticated,
    /// Signed in but not allowed (e.g. not a member of the workspace).
    Forbidden,
    /// Supabase could not be reached; nothing was lost, it will be retried.
    Network,
    RateLimited,
    /// Any other error reported by Supabase.
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct CommandError {
    pub code: ErrorCode,
    pub message: String,
}

pub type CommandResult<T> = Result<T, CommandError>;

impl CommandError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Validation, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

impl From<StoreError> for CommandError {
    fn from(err: StoreError) -> Self {
        match err {
            StoreError::NotFound(what) => Self::not_found(what),
            StoreError::Invalid(why) => Self::validation(why),
            other => {
                log::error!("storage error: {other}");
                Self::new(
                    ErrorCode::Storage,
                    "The local database could not complete the request.",
                )
            }
        }
    }
}

impl From<AccountError> for CommandError {
    fn from(err: AccountError) -> Self {
        let message = err.to_string();
        let code = match &err {
            AccountError::NotConfigured(_) => ErrorCode::NotConfigured,
            AccountError::NotSignedIn => ErrorCode::Unauthenticated,
            AccountError::Invalid(_) => ErrorCode::Validation,
            AccountError::Local(_) => ErrorCode::Storage,
            AccountError::Remote(remote) => match remote {
                RemoteError::Network(_) | RemoteError::Server(_) => ErrorCode::Network,
                RemoteError::Unauthorized => ErrorCode::Unauthenticated,
                RemoteError::InvalidCredentials
                | RemoteError::EmailNotConfirmed
                | RemoteError::Rejected(_) => ErrorCode::Validation,
                RemoteError::Forbidden(_) => ErrorCode::Forbidden,
                RemoteError::NotFound(_) => ErrorCode::NotFound,
                RemoteError::RateLimited { .. } => ErrorCode::RateLimited,
            },
        };
        Self::new(code, message)
    }
}

impl From<StartupError> for CommandError {
    fn from(err: StartupError) -> Self {
        Self::new(ErrorCode::StartupRegistration, err.to_string())
    }
}
