//! Account manager tests: sign-in/up/out, session restore (ok / offline / expired), rotating
//! refresh tokens, memberships and the sync workspace, against in-memory fakes.

mod cloud_common;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};

use cloud_common::*;
use studio_pulse_lib::cloud::account::{
    AccountError, AccountManager, AccountState, AccountStatus, REFRESH_MARGIN_MS,
};
use studio_pulse_lib::cloud::api::{RemoteApi, RemoteError, WorkspaceRole};
use studio_pulse_lib::cloud::config::ConfigError;
use studio_pulse_lib::cloud::credentials::{
    CredentialError, CredentialStore, MemoryCredentialStore, StoredSession,
};
use studio_pulse_lib::cloud::ledger::SyncLedger;

const INVITE_TOKEN: &str = "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";

/// Persist a session for the default user as an earlier launch would have.
fn store_session(world: &World) -> String {
    let session = world.remote.issue_session(&world.user_id);
    world
        .credentials
        .save(&StoredSession {
            refresh_token: session.refresh_token.clone(),
            user_id: world.user_id.clone(),
            email: Some(EMAIL.into()),
            display_name: Some("Ada".into()),
        })
        .unwrap();
    world.ledger.set_account_user(Some(&world.user_id)).unwrap();
    session.refresh_token
}

fn observe(account: &AccountManager) -> Arc<Mutex<Vec<AccountStatus>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    account.set_observer(Box::new(move |s: &AccountStatus| {
        sink.lock().unwrap().push(s.clone())
    }));
    seen
}

fn states(seen: &Arc<Mutex<Vec<AccountStatus>>>) -> Vec<AccountState> {
    seen.lock().unwrap().iter().map(|s| s.state).collect()
}

// ---- restore --------------------------------------------------------------------------------

#[test]
fn restore_without_a_stored_session_is_signed_out() {
    let w = World::new();
    w.ledger.set_account_user(Some("left-over")).unwrap();
    w.account.restore();
    let status = w.account.status();
    assert_eq!(status.state, AccountState::SignedOut);
    assert_eq!(status.user_id, None);
    assert_eq!(
        w.ledger.account_user().unwrap(),
        None,
        "new intervals stay unowned"
    );
    assert!(w.remote.calls().is_empty());
    assert_eq!(w.account.current_user_id(), None);
}

#[test]
fn restore_refreshes_rotates_the_token_and_loads_workspaces() {
    let w = World::new();
    w.remote
        .add_membership(&w.user_id, WS_A, "Studio A", WorkspaceRole::Owner);
    let original = store_session(&w);
    // A workspace this account no longer belongs to is dropped.
    w.ledger.set_sync_workspace(Some(WS_B)).unwrap();

    w.account.restore();

    let status = w.account.status();
    assert_eq!(status.state, AccountState::SignedIn);
    assert_eq!(status.user_id.as_deref(), Some(w.user_id.as_str()));
    assert_eq!(status.email.as_deref(), Some(EMAIL));
    assert_eq!(status.display_name.as_deref(), Some("Ada"));
    assert_eq!(status.workspaces.len(), 1);
    assert_eq!(status.workspaces[0].id, WS_A);
    assert_eq!(status.sync_workspace_id, None);
    assert_eq!(w.ledger.sync_workspace().unwrap(), None);

    let stored = w.stored().unwrap();
    assert_ne!(
        stored.refresh_token, original,
        "the rotated token is persisted"
    );
    assert!(w
        .remote
        .valid_refresh_tokens()
        .contains(&stored.refresh_token));
    assert!(!w.remote.valid_refresh_tokens().contains(&original));

    // The fresh access token is used as is.
    w.account.access().unwrap();
    assert_eq!(w.remote.refresh_calls(), 1);
}

#[test]
fn restore_keeps_a_selected_workspace_that_is_still_a_membership() {
    let w = World::new();
    w.remote
        .add_membership(&w.user_id, WS_A, "Studio A", WorkspaceRole::Member);
    w.remote
        .add_membership(&w.user_id, WS_B, "Studio B", WorkspaceRole::Member);
    store_session(&w);
    w.ledger.set_sync_workspace(Some(WS_B)).unwrap();
    w.account.restore();
    assert_eq!(w.account.status().sync_workspace_id.as_deref(), Some(WS_B));
}

#[test]
fn restore_offline_stays_signed_in_and_access_retries_later() {
    let w = World::new();
    let original = store_session(&w);
    w.ledger.set_sync_workspace(Some(WS_A)).unwrap();
    w.remote
        .state()
        .refresh_failures
        .push_back(RemoteError::Network("could not connect".into()));

    w.account.restore();

    let status = w.account.status();
    assert_eq!(
        status.state,
        AccountState::SignedIn,
        "offline never signs out"
    );
    assert_eq!(status.email.as_deref(), Some(EMAIL));
    assert!(status.workspaces.is_empty(), "unknown while offline");
    assert_eq!(
        status.sync_workspace_id.as_deref(),
        Some(WS_A),
        "kept while offline"
    );
    assert_eq!(
        w.account.current_user_id().as_deref(),
        Some(w.user_id.as_str())
    );
    assert_eq!(
        w.stored().unwrap().refresh_token,
        original,
        "nothing rotated"
    );

    // Back online: the next access() refreshes.
    let ctx = w.account.access().unwrap();
    assert_eq!(ctx.user_id, w.user_id);
    assert_ne!(w.stored().unwrap().refresh_token, original);
    assert_eq!(w.remote.refresh_calls(), 2);
}

fn workspace_fetches(world: &World) -> usize {
    world
        .remote
        .calls()
        .iter()
        .filter(|c| **c == Call::MyWorkspaces)
        .count()
}

#[test]
fn memberships_unknown_after_an_offline_restore_are_loaded_once_back_online() {
    let w = World::new();
    store_session(&w);
    w.remote
        .add_membership(&w.user_id, WS_A, "Studio A", WorkspaceRole::Owner);
    w.ledger.set_sync_workspace(Some(WS_A)).unwrap();
    w.remote
        .state()
        .refresh_failures
        .push_back(RemoteError::Network("could not connect".into()));
    w.account.restore();
    assert!(w.account.status().workspaces.is_empty());

    // Still offline: nothing changes, and the next attempt tries again.
    w.remote
        .state()
        .refresh_failures
        .push_back(RemoteError::Network("could not connect".into()));
    w.account.ensure_workspaces_loaded();
    assert!(w.account.status().workspaces.is_empty());

    // Back online: the memberships load and the selection is kept.
    let seen = observe(&w.account);
    w.account.ensure_workspaces_loaded();
    let status = w.account.status();
    assert_eq!(status.workspaces.len(), 1);
    assert_eq!(status.workspaces[0].name, "Studio A");
    assert_eq!(status.sync_workspace_id.as_deref(), Some(WS_A));
    assert_eq!(
        seen.lock().unwrap().last().map(|s| s.workspaces.len()),
        Some(1),
        "the UI is told"
    );

    // Loaded: further calls fetch nothing.
    let fetches = workspace_fetches(&w);
    w.account.ensure_workspaces_loaded();
    w.account.ensure_workspaces_loaded();
    assert_eq!(workspace_fetches(&w), fetches);
}

#[test]
fn memberships_that_failed_to_load_at_restore_are_retried() {
    let w = World::new();
    store_session(&w);
    w.remote
        .add_membership(&w.user_id, WS_A, "Studio A", WorkspaceRole::Owner);
    w.remote
        .state()
        .workspaces_failures
        .push_back(RemoteError::Server(503));
    w.account.restore();
    assert!(w.account.status().workspaces.is_empty());

    w.account.ensure_workspaces_loaded();
    assert_eq!(w.account.status().workspaces.len(), 1);
}

#[test]
fn ensure_workspaces_loaded_does_nothing_when_signed_out_or_already_loaded() {
    let w = World::new();
    w.account.restore();
    w.account.ensure_workspaces_loaded();
    assert_eq!(workspace_fetches(&w), 0, "signed out");

    w.account.sign_in(EMAIL, PASSWORD).unwrap();
    let after_sign_in = workspace_fetches(&w);
    w.account.ensure_workspaces_loaded();
    assert_eq!(
        workspace_fetches(&w),
        after_sign_in,
        "sign-in already loaded them (an empty list counts)"
    );
}

#[test]
fn restore_while_supabase_fails_or_limits_stays_signed_in() {
    for err in [
        RemoteError::Server(503),
        RemoteError::RateLimited {
            retry_after_ms: Some(5_000),
        },
    ] {
        let w = World::new();
        store_session(&w);
        w.remote.state().refresh_failures.push_back(err.clone());
        w.account.restore();
        assert_eq!(w.account.status().state, AccountState::SignedIn, "{err:?}");
        assert!(w.stored().is_some());
        assert!(
            w.account.access().is_ok(),
            "{err:?}: the next access refreshes"
        );
    }
}

#[test]
fn restore_with_a_rejected_refresh_token_expires_and_keeps_local_data() {
    let w = World::new();
    store_session(&w);
    w.remote.revoke_all_sessions();
    let ids = w.ledger.record(3);
    w.ledger.set_sync_workspace(Some(WS_A)).unwrap();
    let before = w.ledger.snapshot();
    let seen = observe(&w.account);

    w.account.restore();

    let status = w.account.status();
    assert_eq!(status.state, AccountState::SessionExpired);
    assert_eq!(
        status.email.as_deref(),
        Some(EMAIL),
        "shown so the user knows who to sign in as"
    );
    assert_eq!(status.user_id.as_deref(), Some(w.user_id.as_str()));
    assert!(status.workspaces.is_empty());
    assert_eq!(w.stored(), None, "the dead credential is removed");
    assert_eq!(w.ledger.snapshot(), before, "no local interval changed");
    assert_eq!(
        w.ledger.row(&ids[0]).user_id.as_deref(),
        Some(w.user_id.as_str())
    );
    assert_eq!(w.ledger.sync_workspace().unwrap().as_deref(), Some(WS_A));
    assert_eq!(w.account.current_user_id(), None);
    assert_eq!(w.account.access().unwrap_err(), AccountError::NotSignedIn);
    assert_eq!(states(&seen).last(), Some(&AccountState::SessionExpired));
}

#[test]
fn restore_after_another_account_clears_its_workspace() {
    let w = World::new();
    store_session(&w);
    w.ledger.set_account_user(Some("someone-else")).unwrap();
    w.ledger.set_sync_workspace(Some(WS_B)).unwrap();
    w.remote
        .state()
        .refresh_failures
        .push_back(RemoteError::Network("offline".into()));
    w.account.restore();
    assert_eq!(
        w.ledger.account_user().unwrap().as_deref(),
        Some(w.user_id.as_str())
    );
    assert_eq!(w.ledger.sync_workspace().unwrap(), None);
}

// ---- sign in / up ---------------------------------------------------------------------------

#[test]
fn sign_in_stamps_the_user_persists_the_session_and_selects_the_only_workspace() {
    let w = World::new();
    w.remote
        .add_membership(&w.user_id, WS_A, "Studio A", WorkspaceRole::Owner);
    let seen = observe(&w.account);

    let status = w.account.sign_in(&format!("  {EMAIL} "), PASSWORD).unwrap();

    assert_eq!(status.state, AccountState::SignedIn);
    assert_eq!(status.user_id.as_deref(), Some(w.user_id.as_str()));
    assert_eq!(status.sync_workspace_id.as_deref(), Some(WS_A));
    assert_eq!(status.workspaces.len(), 1);
    let stored = w.stored().unwrap();
    assert_eq!(stored.user_id, w.user_id);
    assert_eq!(stored.email.as_deref(), Some(EMAIL));
    assert_eq!(stored.display_name.as_deref(), Some("Ada"));
    assert!(w
        .remote
        .valid_refresh_tokens()
        .contains(&stored.refresh_token));
    assert_eq!(
        w.ledger.account_user().unwrap().as_deref(),
        Some(w.user_id.as_str())
    );
    // Intervals recorded from now on belong to this account.
    let id = w.ledger.record(1)[0].clone();
    assert_eq!(
        w.ledger.row(&id).user_id.as_deref(),
        Some(w.user_id.as_str())
    );
    assert_eq!(states(&seen).last(), Some(&AccountState::SignedIn));
    assert_eq!(
        w.remote.calls()[0],
        Call::SignIn {
            email: EMAIL.into()
        },
        "the email is trimmed"
    );
}

#[test]
fn sign_in_with_several_workspaces_selects_none() {
    let w = World::new();
    w.remote
        .add_membership(&w.user_id, WS_A, "Studio A", WorkspaceRole::Owner);
    w.remote
        .add_membership(&w.user_id, WS_B, "Studio B", WorkspaceRole::Member);
    let status = w.account.sign_in(EMAIL, PASSWORD).unwrap();
    assert_eq!(status.workspaces.len(), 2);
    assert_eq!(status.sync_workspace_id, None);
}

#[test]
fn sign_in_still_succeeds_when_workspaces_cannot_be_loaded() {
    let w = World::new();
    w.remote
        .state()
        .workspaces_failures
        .push_back(RemoteError::Server(502));
    let status = w.account.sign_in(EMAIL, PASSWORD).unwrap();
    assert_eq!(status.state, AccountState::SignedIn);
    assert!(status.workspaces.is_empty());
}

#[test]
fn a_wrong_password_changes_nothing() {
    let w = World::new();
    w.account.restore();
    let err = w.account.sign_in(EMAIL, "wrong password").unwrap_err();
    assert_eq!(err, AccountError::Remote(RemoteError::InvalidCredentials));
    assert_eq!(err.to_string(), "Wrong email or password.");
    assert!(!err.to_string().contains("wrong password"));
    assert_eq!(w.account.status().state, AccountState::SignedOut);
    assert_eq!(w.stored(), None);
    assert_eq!(w.ledger.account_user().unwrap(), None);
}

#[test]
fn unconfirmed_email_is_reported() {
    let w = World::new();
    w.remote.state().users[0].confirmed = false;
    assert_eq!(
        w.account.sign_in(EMAIL, PASSWORD).unwrap_err(),
        AccountError::Remote(RemoteError::EmailNotConfirmed)
    );
}

#[test]
fn input_is_validated_before_anything_is_sent() {
    let w = World::new();
    let invalid =
        |r: Result<AccountStatus, AccountError>| matches!(r, Err(AccountError::Invalid(_)));
    assert!(invalid(w.account.sign_in("not-an-email", PASSWORD)));
    assert!(invalid(w.account.sign_in("", PASSWORD)));
    assert!(invalid(w.account.sign_in(EMAIL, "12345")));
    assert!(matches!(
        w.account.sign_up(EMAIL, PASSWORD, "   "),
        Err(AccountError::Invalid(_))
    ));
    assert!(matches!(
        w.account.sign_up(EMAIL, PASSWORD, &"x".repeat(81)),
        Err(AccountError::Invalid(_))
    ));
    assert!(matches!(
        w.account.sign_up("a@b", PASSWORD, "Ada"),
        Err(AccountError::Invalid(_))
    ));
    assert!(w.remote.calls().is_empty());

    w.account.sign_in(EMAIL, PASSWORD).unwrap();
    let calls = w.remote.calls().len();
    assert!(invalid(w.account.create_workspace("  ")));
    assert!(invalid(w.account.create_workspace(&"w".repeat(81))));
    assert!(invalid(w.account.accept_invitation("")));
    assert!(invalid(w.account.accept_invitation("abc")));
    assert!(invalid(w.account.accept_invitation(&"z".repeat(64))));
    assert!(matches!(
        w.account
            .create_invitation(WS_A, "nope", WorkspaceRole::Member),
        Err(AccountError::Invalid(_))
    ));
    assert!(matches!(
        w.account
            .create_invitation(WS_A, "bo@example.com", WorkspaceRole::Owner),
        Err(AccountError::Invalid(_))
    ));
    assert!(invalid(w.account.select_sync_workspace(Some("  "))));
    assert_eq!(w.remote.calls().len(), calls, "nothing reached the server");
}

#[test]
fn sign_up_signs_in_when_no_confirmation_is_required() {
    let w = World::new();
    w.account.restore();
    let result = w
        .account
        .sign_up("bo@example.com", "a fine password", "  Bo  ")
        .unwrap();
    assert_eq!(result.status, "signedIn");
    assert_eq!(result.account.state, AccountState::SignedIn);
    assert_eq!(result.account.display_name.as_deref(), Some("Bo"));
    assert_eq!(
        w.remote.calls()[0],
        Call::SignUp {
            email: "bo@example.com".into(),
            display_name: "Bo".into()
        }
    );
    assert!(w.stored().is_some());
}

#[test]
fn sign_up_with_confirmation_required_stays_signed_out() {
    let w = World::new();
    w.account.restore();
    w.remote.state().require_confirmation = true;
    let result = w
        .account
        .sign_up("bo@example.com", "a fine password", "Bo")
        .unwrap();
    assert_eq!(result.status, "confirmationRequired");
    assert_eq!(result.account.state, AccountState::SignedOut);
    assert_eq!(w.stored(), None);
    assert_eq!(w.ledger.account_user().unwrap(), None);
}

#[test]
fn signing_in_as_another_account_does_not_inherit_its_workspace() {
    let w = World::signed_in_with_workspace();
    let mine = w.ledger.record(2);
    w.remote.revoke_all_sessions();
    w.account.handle_unauthorized().unwrap_err();
    assert_eq!(w.account.status().state, AccountState::SessionExpired);

    let other = w.remote.add_user("bo@example.com", PASSWORD, None);
    let status = w.account.sign_in("bo@example.com", PASSWORD).unwrap();
    assert_eq!(status.user_id.as_deref(), Some(other.as_str()));
    assert_eq!(
        status.sync_workspace_id, None,
        "Ada's workspace is not Bo's"
    );
    assert_eq!(
        w.ledger.account_user().unwrap().as_deref(),
        Some(other.as_str())
    );
    // Ada's intervals stay Ada's.
    assert_eq!(
        w.ledger.row(&mine[0]).user_id.as_deref(),
        Some(w.user_id.as_str())
    );
}

// ---- sign out -------------------------------------------------------------------------------

#[test]
fn sign_out_keeps_local_data_and_clears_the_account() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(3);
    let before = w.ledger.snapshot();
    let refresh = w.stored().unwrap().refresh_token;
    let seen = observe(&w.account);

    let status = w.account.sign_out().unwrap();

    assert_eq!(status.state, AccountState::SignedOut);
    assert_eq!(status.user_id, None);
    assert_eq!(status.email, None);
    assert!(status.workspaces.is_empty());
    assert_eq!(status.sync_workspace_id, None);
    assert_eq!(w.stored(), None);
    assert_eq!(w.ledger.account_user().unwrap(), None);
    assert_eq!(
        w.ledger.sync_workspace().unwrap(),
        None,
        "the next account picks its own"
    );
    assert_eq!(
        w.ledger.snapshot(),
        before,
        "every local interval is kept as it was"
    );
    assert_eq!(w.ledger.status_of(&ids[0]), RowStatus::Pending);
    // The server session was revoked with the current access token.
    assert!(w.remote.calls().iter().any(
        |c| matches!(c, Call::SignOut { access_token } if access_token.starts_with("access-"))
    ));
    assert!(!w.remote.valid_refresh_tokens().contains(&refresh));
    assert_eq!(states(&seen), [AccountState::SignedOut]);
    assert_eq!(w.account.access().unwrap_err(), AccountError::NotSignedIn);
}

/// A Credential Manager stand-in whose `clear` can be made to fail.
#[derive(Default)]
struct StuckCredentials {
    inner: MemoryCredentialStore,
    fail_clear: AtomicBool,
    failed_clears: AtomicUsize,
}

impl CredentialStore for StuckCredentials {
    fn load(&self) -> Result<Option<StoredSession>, CredentialError> {
        self.inner.load()
    }
    fn save(&self, session: &StoredSession) -> Result<(), CredentialError> {
        self.inner.save(session)
    }
    fn clear(&self) -> Result<(), CredentialError> {
        if self.fail_clear.load(Ordering::SeqCst) {
            self.failed_clears.fetch_add(1, Ordering::SeqCst);
            return Err(CredentialError(
                "could not remove the saved sign-in (0x80070005)".into(),
            ));
        }
        self.inner.clear()
    }
}

#[test]
fn sign_out_that_cannot_remove_the_saved_sign_in_stays_signed_in_and_says_so() {
    let w = World::new();
    w.remote
        .add_membership(&w.user_id, WS_A, "Studio A", WorkspaceRole::Owner);
    let credentials = Arc::new(StuckCredentials::default());
    let api: Arc<dyn RemoteApi> = w.remote.clone();
    let ledger: Arc<dyn SyncLedger> = w.ledger.clone();
    let account = AccountManager::new(
        Ok(test_config()),
        Some(api),
        credentials.clone(),
        ledger,
        w.clock.boxed_sync(),
    );
    account.sign_in(EMAIL, PASSWORD).unwrap();
    credentials.fail_clear.store(true, Ordering::SeqCst);

    let err = account.sign_out().unwrap_err();

    assert!(
        matches!(&err, AccountError::Local(message) if message.contains("still signed in")),
        "{err}"
    );
    assert_eq!(
        credentials.failed_clears.load(Ordering::SeqCst),
        2,
        "tried twice"
    );
    assert_eq!(account.status().state, AccountState::SignedIn);
    assert!(credentials.load().unwrap().is_some());
    assert_eq!(
        w.ledger.account_user().unwrap().as_deref(),
        Some(w.user_id.as_str())
    );
    assert_eq!(w.ledger.sync_workspace().unwrap().as_deref(), Some(WS_A));
    assert!(
        !w.remote
            .calls()
            .iter()
            .any(|c| matches!(c, Call::SignOut { .. })),
        "the server session is kept as well"
    );

    // Once Windows cooperates, signing out works.
    credentials.fail_clear.store(false, Ordering::SeqCst);
    assert_eq!(account.sign_out().unwrap().state, AccountState::SignedOut);
    assert!(credentials.load().unwrap().is_none());
    assert_eq!(w.ledger.account_user().unwrap(), None);
}

#[test]
fn sign_out_that_cannot_clear_the_stamp_never_looks_signed_out() {
    let w = World::signed_in_with_workspace();
    let seen = observe(&w.account);
    w.ledger.fail_set_account_user.store(true, Ordering::SeqCst);

    assert!(matches!(
        w.account.sign_out().unwrap_err(),
        AccountError::Local(_)
    ));

    assert_eq!(w.account.status().state, AccountState::SignedIn);
    assert_eq!(
        w.ledger.account_user().unwrap().as_deref(),
        Some(w.user_id.as_str())
    );
    assert!(
        states(&seen).iter().all(|s| *s == AccountState::SignedIn),
        "never published as signed out"
    );

    // The saved sign-in is gone, so the next launch starts signed out and drops the stamp.
    w.ledger
        .fail_set_account_user
        .store(false, Ordering::SeqCst);
    let restarted = w.restart();
    restarted.restore();
    assert_eq!(restarted.status().state, AccountState::SignedOut);
    assert_eq!(w.ledger.account_user().unwrap(), None);
}

#[test]
fn sign_out_without_an_access_token_revokes_through_a_refresh() {
    let w = World::new();
    let refresh = store_session(&w);
    w.remote
        .state()
        .refresh_failures
        .push_back(RemoteError::Network("offline".into()));
    w.account.restore(); // signed in, offline, no access token
    w.account.sign_out().unwrap();
    let calls = w.remote.calls();
    assert!(matches!(calls[calls.len() - 2], Call::Refresh));
    assert!(matches!(calls[calls.len() - 1], Call::SignOut { .. }));
    assert!(!w.remote.valid_refresh_tokens().contains(&refresh));
    assert!(
        w.remote.valid_refresh_tokens().is_empty(),
        "the rotated token died too"
    );
    assert_eq!(w.stored(), None, "the rotated token was never stored");
}

#[test]
fn sign_out_while_offline_still_signs_out_locally() {
    let w = World::signed_in_with_workspace();
    w.clock.advance(TOKEN_TTL_MS); // the access token expired
    w.remote
        .state()
        .refresh_failures
        .push_back(RemoteError::Network("offline".into()));
    let status = w.account.sign_out().unwrap();
    assert_eq!(status.state, AccountState::SignedOut);
    assert_eq!(w.stored(), None);
    assert!(!w
        .remote
        .calls()
        .iter()
        .any(|c| matches!(c, Call::SignOut { .. })));
}

#[test]
fn sign_out_after_expiry_needs_no_server() {
    let w = World::new();
    store_session(&w);
    w.remote.revoke_all_sessions();
    w.account.restore();
    let calls = w.remote.calls().len();
    assert_eq!(w.account.sign_out().unwrap().state, AccountState::SignedOut);
    assert_eq!(w.remote.calls().len(), calls);
}

// ---- workspaces -----------------------------------------------------------------------------

#[test]
fn select_sync_workspace_requires_a_current_membership() {
    let w = World::new();
    w.remote
        .add_membership(&w.user_id, WS_A, "Studio A", WorkspaceRole::Owner);
    w.remote
        .add_membership(&w.user_id, WS_B, "Studio B", WorkspaceRole::Member);
    w.account.sign_in(EMAIL, PASSWORD).unwrap();

    let status = w.account.select_sync_workspace(Some(WS_B)).unwrap();
    assert_eq!(status.sync_workspace_id.as_deref(), Some(WS_B));

    // Ids compare case-insensitively; the server's spelling is stored.
    let status = w
        .account
        .select_sync_workspace(Some(&WS_A.to_ascii_uppercase()))
        .unwrap();
    assert_eq!(status.sync_workspace_id.as_deref(), Some(WS_A));

    let err = w
        .account
        .select_sync_workspace(Some("0190a7f0-0000-7000-8000-00000000ffff"))
        .unwrap_err();
    assert!(matches!(err, AccountError::Invalid(_)));
    assert_eq!(w.ledger.sync_workspace().unwrap().as_deref(), Some(WS_A));

    // Removed on the server meanwhile: the check uses a fresh list, and the stale selection goes.
    w.account.select_sync_workspace(Some(WS_B)).unwrap();
    w.remote.remove_membership(&w.user_id, WS_B);
    assert!(matches!(
        w.account.select_sync_workspace(Some(WS_B)),
        Err(AccountError::Invalid(_))
    ));
    assert_eq!(w.ledger.sync_workspace().unwrap(), None);

    let status = w.account.select_sync_workspace(None).unwrap();
    assert_eq!(status.sync_workspace_id, None);
}

#[test]
fn selecting_a_workspace_requires_sign_in() {
    let w = World::new();
    w.account.restore();
    assert_eq!(
        w.account.select_sync_workspace(Some(WS_A)).unwrap_err(),
        AccountError::NotSignedIn
    );
    assert_eq!(
        w.account.refresh_workspaces().unwrap_err(),
        AccountError::NotSignedIn
    );
}

#[test]
fn refresh_workspaces_drops_a_workspace_the_user_left() {
    let w = World::signed_in_with_workspace();
    w.remote.remove_membership(&w.user_id, WS_A);
    let status = w.account.refresh_workspaces().unwrap();
    assert!(status.workspaces.is_empty());
    assert_eq!(status.sync_workspace_id, None);
}

#[test]
fn create_workspace_selects_it_when_none_is_selected() {
    let w = World::new();
    w.account.sign_in(EMAIL, PASSWORD).unwrap();
    let status = w.account.create_workspace("  Night Studio ").unwrap();
    assert_eq!(status.workspaces.len(), 1);
    assert_eq!(status.workspaces[0].name, "Night Studio");
    assert_eq!(status.workspaces[0].role, WorkspaceRole::Owner);
    assert_eq!(
        status.sync_workspace_id.as_deref(),
        Some(status.workspaces[0].id.as_str())
    );
    assert!(w.remote.calls().contains(&Call::CreateWorkspace {
        name: "Night Studio".into()
    }));

    // A second one is created but does not take over the selection.
    let first = status.sync_workspace_id.clone();
    let status = w.account.create_workspace("Day Studio").unwrap();
    assert_eq!(status.workspaces.len(), 2);
    assert_eq!(status.sync_workspace_id, first);
}

#[test]
fn accepting_an_invitation_joins_and_selects_it_when_none_is_selected() {
    let w = World::new();
    w.account.sign_in(EMAIL, PASSWORD).unwrap();
    w.remote.state().invitations.insert(
        INVITE_TOKEN.into(),
        (WS_B.into(), "Studio B".into(), WorkspaceRole::Member),
    );
    // Pasted with spaces and in upper case: normalised to the issued form.
    let status = w
        .account
        .accept_invitation(&format!(" {} ", INVITE_TOKEN.to_ascii_uppercase()))
        .unwrap();
    assert_eq!(status.sync_workspace_id.as_deref(), Some(WS_B));
    assert!(w.remote.calls().contains(&Call::AcceptInvitation {
        token: INVITE_TOKEN.into()
    }));

    // Used once: a second attempt is "not found", with the server's message.
    let err = w.account.accept_invitation(INVITE_TOKEN).unwrap_err();
    assert_eq!(
        err,
        AccountError::Remote(RemoteError::NotFound(
            "this invitation is invalid or has expired".into()
        ))
    );
}

#[test]
fn accepting_an_invitation_keeps_an_existing_selection() {
    let w = World::signed_in_with_workspace();
    w.remote.state().invitations.insert(
        INVITE_TOKEN.into(),
        (WS_B.into(), "Studio B".into(), WorkspaceRole::Member),
    );
    let status = w.account.accept_invitation(INVITE_TOKEN).unwrap();
    assert_eq!(status.workspaces.len(), 2);
    assert_eq!(status.sync_workspace_id.as_deref(), Some(WS_A));
}

#[test]
fn create_invitation_returns_the_token_once_and_never_prints_it() {
    let w = World::signed_in_with_workspace();
    let invitation = w
        .account
        .create_invitation(WS_A, " Bo@Example.com ", WorkspaceRole::Admin)
        .unwrap();
    assert_eq!(invitation.token.len(), 64);
    assert!(!format!("{invitation:?}").contains(&invitation.token));
    assert!(w.remote.calls().contains(&Call::CreateInvitation {
        workspace_id: WS_A.into(),
        email: "Bo@Example.com".into(),
        role: WorkspaceRole::Admin,
    }));

    // Members cannot invite: the server's refusal is passed on.
    w.remote
        .add_membership(&w.user_id, WS_B, "Studio B", WorkspaceRole::Member);
    let err = w
        .account
        .create_invitation(WS_B, "cy@example.com", WorkspaceRole::Member)
        .unwrap_err();
    assert!(matches!(
        err,
        AccountError::Remote(RemoteError::Forbidden(_))
    ));
}

// ---- tokens ---------------------------------------------------------------------------------

#[test]
fn access_refreshes_only_within_the_margin() {
    let w = World::signed_in_with_workspace();
    let first = w.account.access().unwrap();

    w.clock.advance(TOKEN_TTL_MS - REFRESH_MARGIN_MS - 1_000);
    let same = w.account.access().unwrap();
    assert_eq!(same.access_token, first.access_token);
    assert_eq!(w.remote.refresh_calls(), 0);

    w.clock.advance(2_000); // now inside the margin
    let renewed = w.account.access().unwrap();
    assert_ne!(renewed.access_token, first.access_token);
    assert_eq!(w.remote.refresh_calls(), 1);
    assert!(w
        .remote
        .valid_refresh_tokens()
        .contains(&w.stored().unwrap().refresh_token));
}

#[test]
fn a_still_valid_token_is_used_when_an_early_refresh_fails() {
    let w = World::signed_in_with_workspace();
    let first = w.account.access().unwrap();
    w.clock.advance(TOKEN_TTL_MS - REFRESH_MARGIN_MS / 2);
    w.remote
        .state()
        .refresh_failures
        .push_back(RemoteError::Network("offline".into()));
    let ctx = w.account.access().unwrap();
    assert_eq!(ctx.access_token, first.access_token);
}

#[test]
fn handle_unauthorized_refreshes_once_then_expires_on_rejection() {
    let w = World::signed_in_with_workspace();
    let first = w.account.access().unwrap();
    let renewed = w.account.handle_unauthorized().unwrap();
    assert_ne!(renewed.access_token, first.access_token);
    assert_eq!(w.remote.refresh_calls(), 1);

    w.remote.revoke_all_sessions();
    let seen = observe(&w.account);
    let err = w.account.handle_unauthorized().unwrap_err();
    assert_eq!(err, AccountError::Remote(RemoteError::Unauthorized));
    assert_eq!(w.remote.refresh_calls(), 2, "exactly one more refresh");
    assert_eq!(w.account.status().state, AccountState::SessionExpired);
    assert_eq!(states(&seen), [AccountState::SessionExpired]);
    assert_eq!(w.stored(), None);
    assert_eq!(
        w.account.handle_unauthorized().unwrap_err(),
        AccountError::NotSignedIn
    );
}

#[test]
fn a_transient_refresh_failure_never_expires_the_session() {
    let w = World::signed_in_with_workspace();
    w.remote
        .state()
        .refresh_failures
        .push_back(RemoteError::Server(500));
    let err = w.account.handle_unauthorized().unwrap_err();
    assert_eq!(err, AccountError::Remote(RemoteError::Server(500)));
    assert_eq!(w.account.status().state, AccountState::SignedIn);
    assert!(w.stored().is_some());
}

#[test]
fn rotated_refresh_tokens_survive_a_restart() {
    let w = World::signed_in_with_workspace();
    let original = w.stored().unwrap().refresh_token;
    w.account.handle_unauthorized().unwrap();
    w.account.handle_unauthorized().unwrap();
    let latest = w.stored().unwrap().refresh_token;
    assert_ne!(latest, original);
    assert_eq!(w.remote.valid_refresh_tokens().len(), 1);
    assert!(w.remote.valid_refresh_tokens().contains(&latest));

    // Next launch: the persisted (latest) token restores the session.
    let restarted = w.restart();
    restarted.restore();
    assert_eq!(restarted.status().state, AccountState::SignedIn);
    assert_eq!(restarted.status().sync_workspace_id.as_deref(), Some(WS_A));
}

#[test]
fn concurrent_callers_share_one_refresh() {
    let w = World::signed_in_with_workspace();
    w.clock.advance(TOKEN_TTL_MS); // expired: every caller needs a new token
    let threads = 8;
    let barrier = Arc::new(Barrier::new(threads));
    let handles: Vec<_> = (0..threads)
        .map(|_| {
            let account = Arc::clone(&w.account);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                account.access().map(|ctx| ctx.access_token)
            })
        })
        .collect();
    let tokens: Vec<String> = handles
        .into_iter()
        .map(|h| h.join().unwrap().unwrap())
        .collect();
    assert_eq!(
        w.remote.refresh_calls(),
        1,
        "a rotating token is spent once"
    );
    assert!(tokens.windows(2).all(|p| p[0] == p[1]));
    assert_eq!(w.account.status().state, AccountState::SignedIn);
}

// ---- observer and configuration ---------------------------------------------------------------

#[test]
fn the_observer_hears_each_change_once() {
    let w = World::new();
    w.remote
        .add_membership(&w.user_id, WS_A, "Studio A", WorkspaceRole::Owner);
    let seen = observe(&w.account);
    w.account.restore();
    assert_eq!(states(&seen), [AccountState::SignedOut]);

    w.account.sign_in(EMAIL, PASSWORD).unwrap();
    let after_sign_in = seen.lock().unwrap().len();
    assert_eq!(
        seen.lock()
            .unwrap()
            .last()
            .unwrap()
            .sync_workspace_id
            .as_deref(),
        Some(WS_A)
    );

    // Nothing changed: no notification.
    w.account.refresh_workspaces().unwrap();
    w.account.access().unwrap();
    assert_eq!(seen.lock().unwrap().len(), after_sign_in);

    w.account.select_sync_workspace(None).unwrap();
    assert_eq!(seen.lock().unwrap().len(), after_sign_in + 1);
    w.account.sign_out().unwrap();
    assert_eq!(states(&seen).last(), Some(&AccountState::SignedOut));
    let all = seen.lock().unwrap().clone();
    for pair in all.windows(2) {
        assert_ne!(pair[0], pair[1]);
    }
}

#[test]
fn a_build_without_configuration_is_not_configured() {
    for config in [Err(ConfigError::Missing), Err(ConfigError::SecretKey)] {
        let clock = TestClock::new(T0);
        let ledger = Arc::new(FakeLedger::default());
        let account = AccountManager::new(
            config.clone(),
            None,
            Arc::new(MemoryCredentialStore::default()),
            ledger,
            clock.boxed_sync(),
        );
        account.restore();
        let status = account.status();
        assert_eq!(status.state, AccountState::NotConfigured);
        let message = status.configuration_error.unwrap();
        assert_eq!(message, config.unwrap_err().to_string());
        assert!(matches!(
            account.sign_in(EMAIL, PASSWORD),
            Err(AccountError::NotConfigured(_))
        ));
        assert!(matches!(
            account.access(),
            Err(AccountError::NotConfigured(_))
        ));
        assert!(matches!(
            account.handle_unauthorized(),
            Err(AccountError::NotConfigured(_))
        ));
        assert_eq!(
            account.sign_out().unwrap().state,
            AccountState::NotConfigured
        );
    }
}

#[test]
fn status_serializes_in_the_shared_types_shape_without_secrets() {
    let w = World::signed_in_with_workspace();
    let token = w.account.access().unwrap().access_token;
    let refresh = w.stored().unwrap().refresh_token;
    let json = serde_json::to_value(w.account.status()).unwrap();
    assert_eq!(json["state"], "signedIn");
    assert_eq!(json["syncWorkspaceId"], WS_A);
    assert_eq!(json["workspaces"][0]["timeEntryVisibility"], "private");
    assert_eq!(json["workspaces"][0]["role"], "owner");
    assert!(json.get("configurationError").is_some());
    let text = json.to_string();
    assert!(!text.contains(&token));
    assert!(!text.contains(&refresh));
    let debug = format!(
        "{:?} {:?}",
        w.account.access().unwrap(),
        w.stored().unwrap()
    );
    assert!(!debug.contains(&token));
    assert!(!debug.contains(&refresh));
}
