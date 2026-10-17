//! Live test of the Windows Credential Manager store (ignored by default: it writes a scratch
//! generic credential for the current Windows user and deletes it again).
//!
//! Run: `cargo test --test cloud_credentials -- --ignored`

#![cfg(windows)]

use studio_pulse_lib::cloud::credentials::{
    CredentialStore, StoredSession, WindowsCredentialStore,
};

/// Deletes the scratch credential however the test ends.
struct Cleanup<'a>(&'a WindowsCredentialStore);

impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        let _ = self.0.clear();
    }
}

fn session(refresh_token: &str) -> StoredSession {
    StoredSession {
        refresh_token: refresh_token.into(),
        user_id: "0190a7f0-0000-7000-8000-000000000001".into(),
        email: Some("ada@example.com".into()),
        display_name: Some("Ada Lovelace ✓".into()),
    }
}

#[test]
#[ignore = "writes and deletes a scratch entry in this Windows user's Credential Manager"]
fn windows_credential_store_round_trips_a_scratch_entry_and_deletes_it() {
    let scratch = format!("live-test-{}", uuid::Uuid::new_v4());
    let store = WindowsCredentialStore::new(&scratch);
    let _cleanup = Cleanup(&store);

    // Absent: nothing to load, and clearing is not an error.
    assert_eq!(store.load().unwrap(), None);
    store.clear().unwrap();

    store.save(&session("scratch-refresh-1")).unwrap();
    assert_eq!(store.load().unwrap(), Some(session("scratch-refresh-1")));

    // Rotation overwrites in place.
    store.save(&session("scratch-refresh-2")).unwrap();
    assert_eq!(store.load().unwrap(), Some(session("scratch-refresh-2")));

    // Too large for Credential Manager: refused clearly, the stored one is untouched.
    let err = store.save(&session(&"r".repeat(4_000))).unwrap_err();
    assert!(err.to_string().contains("too large"), "{err}");
    assert!(!err.to_string().contains("rrrr"));
    assert_eq!(store.load().unwrap(), Some(session("scratch-refresh-2")));

    // Another project's target is separate.
    let other = WindowsCredentialStore::new(&format!("{scratch}-other"));
    assert_eq!(other.load().unwrap(), None);

    store.clear().unwrap();
    assert_eq!(store.load().unwrap(), None);
    store.clear().unwrap();
}
