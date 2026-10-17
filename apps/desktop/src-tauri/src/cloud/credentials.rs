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
    #[cfg_attr(not(windows), allow(dead_code))]
    target: String,
}

impl WindowsCredentialStore {
    pub fn new(project_ref: &str) -> Self {
        Self {
            target: format!("Studio Pulse/supabase/{project_ref}"),
        }
    }
}

/// The credential blob: the session as UTF-8 JSON, refused when Windows could not store it.
#[cfg_attr(not(windows), allow(dead_code))]
fn encode_blob(session: &StoredSession) -> Result<Vec<u8>, CredentialError> {
    let blob = serde_json::to_vec(session)
        .map_err(|_| CredentialError("the session could not be encoded".into()))?;
    if blob.len() > MAX_BLOB_BYTES {
        return Err(CredentialError(format!(
            "the session is too large to store ({} bytes; the limit is {MAX_BLOB_BYTES})",
            blob.len()
        )));
    }
    Ok(blob)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn decode_blob(blob: &[u8]) -> Result<StoredSession, CredentialError> {
    let session: StoredSession = serde_json::from_slice(blob)
        .map_err(|_| CredentialError("the saved sign-in is unreadable".into()))?;
    if session.refresh_token.is_empty() || session.user_id.is_empty() {
        return Err(CredentialError("the saved sign-in is incomplete".into()));
    }
    Ok(session)
}

/// `CRED_MAX_CREDENTIAL_BLOB_SIZE` (5 × 512 bytes).
const MAX_BLOB_BYTES: usize = 2_560;

#[cfg(windows)]
mod win {
    use super::{decode_blob, encode_blob, CredentialError, StoredSession, MAX_BLOB_BYTES};
    use windows::core::{HRESULT, PCWSTR, PWSTR};
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_MAX_CREDENTIAL_BLOB_SIZE,
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    const _: () = assert!(MAX_BLOB_BYTES == CRED_MAX_CREDENTIAL_BLOB_SIZE as usize);

    /// NUL-terminated UTF-16.
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn not_found(err: &windows::core::Error) -> bool {
        err.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0)
    }

    fn failure(action: &str, err: &windows::core::Error) -> CredentialError {
        // The HRESULT only: no target names, user ids or blobs.
        CredentialError(format!("{action} (0x{:08X})", err.code().0))
    }

    pub(super) fn read(target: &str) -> Result<Option<StoredSession>, CredentialError> {
        let target = wide(target);
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `target` is a NUL-terminated UTF-16 buffer that outlives the call, and
        // `credential` is a valid out-pointer. On success Windows allocates the CREDENTIALW,
        // which we release with CredFree below and do not use afterwards.
        let result = unsafe {
            CredReadW(
                PCWSTR(target.as_ptr()),
                CRED_TYPE_GENERIC,
                None,
                &mut credential,
            )
        };
        match result {
            Ok(()) => {
                if credential.is_null() {
                    return Err(CredentialError("Windows returned no credential".into()));
                }
                // SAFETY: on success `credential` points to a valid CREDENTIALW whose
                // CredentialBlob holds CredentialBlobSize bytes (or is null when the size is 0).
                // The bytes are copied before CredFree releases the allocation.
                let blob = unsafe {
                    let c = &*credential;
                    let bytes = if c.CredentialBlob.is_null() || c.CredentialBlobSize == 0 {
                        Vec::new()
                    } else {
                        std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize)
                            .to_vec()
                    };
                    CredFree(credential as *const core::ffi::c_void);
                    bytes
                };
                decode_blob(&blob).map(Some)
            }
            Err(err) if not_found(&err) => Ok(None),
            Err(err) => Err(failure("could not read the saved sign-in", &err)),
        }
    }

    pub(super) fn write(target: &str, session: &StoredSession) -> Result<(), CredentialError> {
        let mut blob = encode_blob(session)?;
        let mut target = wide(target);
        let mut user_name = wide(&session.user_id);
        let mut comment = wide("Studio Pulse sign-in (Supabase refresh token)");
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            Comment: PWSTR(comment.as_mut_ptr()),
            CredentialBlobSize: u32::try_from(blob.len())
                .map_err(|_| CredentialError("the session is too large to store".into()))?,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: PWSTR(user_name.as_mut_ptr()),
            ..Default::default()
        };
        // SAFETY: every pointer in `credential` refers to a live, NUL-terminated (strings) or
        // correctly sized (blob) buffer owned by this frame for the duration of the call;
        // CredWriteW copies the data and keeps no reference to it.
        unsafe { CredWriteW(&credential, 0) }
            .map_err(|err| failure("could not save the sign-in", &err))
    }

    pub(super) fn delete(target: &str) -> Result<(), CredentialError> {
        let target = wide(target);
        // SAFETY: `target` is a NUL-terminated UTF-16 buffer that outlives the call.
        match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(err) if not_found(&err) => Ok(()),
            Err(err) => Err(failure("could not remove the saved sign-in", &err)),
        }
    }
}

#[cfg(windows)]
impl CredentialStore for WindowsCredentialStore {
    fn load(&self) -> Result<Option<StoredSession>, CredentialError> {
        win::read(&self.target)
    }

    fn save(&self, session: &StoredSession) -> Result<(), CredentialError> {
        win::write(&self.target, session)
    }

    fn clear(&self) -> Result<(), CredentialError> {
        win::delete(&self.target)
    }
}

#[cfg(not(windows))]
impl CredentialStore for WindowsCredentialStore {
    fn load(&self) -> Result<Option<StoredSession>, CredentialError> {
        Err(unsupported())
    }

    fn save(&self, _session: &StoredSession) -> Result<(), CredentialError> {
        Err(unsupported())
    }

    fn clear(&self) -> Result<(), CredentialError> {
        Err(unsupported())
    }
}

#[cfg(not(windows))]
fn unsupported() -> CredentialError {
    CredentialError("Windows Credential Manager is only available on Windows".into())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn session(refresh: &str) -> StoredSession {
        StoredSession {
            refresh_token: refresh.into(),
            user_id: "0190a7f0-0000-7000-8000-000000000001".into(),
            email: Some("ada@example.com".into()),
            display_name: Some("Ada".into()),
        }
    }

    #[test]
    fn target_name_is_namespaced_by_project() {
        let store = WindowsCredentialStore::new("abcd1234");
        assert_eq!(store.target, "Studio Pulse/supabase/abcd1234");
    }

    #[test]
    fn blob_round_trips_as_camel_case_json() {
        let blob = encode_blob(&session("rt-1")).unwrap();
        let text = String::from_utf8(blob.clone()).unwrap();
        assert!(text.contains("\"refreshToken\":\"rt-1\""));
        assert!(text.contains("\"userId\""));
        assert_eq!(decode_blob(&blob).unwrap(), session("rt-1"));
    }

    #[test]
    fn oversized_blob_is_refused_clearly() {
        let err = encode_blob(&session(&"r".repeat(3_000))).unwrap_err();
        assert!(err.0.contains("too large"), "{err}");
        // The message never echoes the token.
        assert!(!err.to_string().contains("rrrr"));
    }

    #[test]
    fn corrupt_or_incomplete_blob_is_an_error() {
        assert!(decode_blob(b"not json").is_err());
        assert!(decode_blob(br#"{"refreshToken":"","userId":"u"}"#).is_err());
        assert!(decode_blob(br#"{"refreshToken":"x","userId":""}"#).is_err());
    }

    #[test]
    fn debug_never_prints_the_refresh_token() {
        let text = format!("{:?}", session("super-secret-refresh"));
        assert!(!text.contains("super-secret-refresh"));
    }

    #[test]
    fn memory_store_round_trip_and_clear() {
        let store = MemoryCredentialStore::default();
        assert_eq!(store.load().unwrap(), None);
        store.save(&session("a")).unwrap();
        store.save(&session("b")).unwrap();
        assert_eq!(store.load().unwrap(), Some(session("b")));
        store.clear().unwrap();
        store.clear().unwrap();
        assert_eq!(store.load().unwrap(), None);
    }
}
