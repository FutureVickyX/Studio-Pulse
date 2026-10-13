//! Errors returned to the UI. Serialized shape = `CommandError` in shared-types.
//! Messages are written for people and never include file contents, window titles or SQL.

use serde::Serialize;

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

impl From<StartupError> for CommandError {
    fn from(err: StartupError) -> Self {
        Self::new(ErrorCode::StartupRegistration, err.to_string())
    }
}
