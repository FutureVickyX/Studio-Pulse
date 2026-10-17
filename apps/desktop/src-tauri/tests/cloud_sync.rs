//! Sync service tests: `SyncCore::run_once` against the in-memory ledger and Supabase fakes, and
//! the `spawn`ed thread's command handling. No network, no database.

mod cloud_common;

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cloud_common::*;
use studio_pulse_lib::cloud::account::{AccountManager, AccountState};
use studio_pulse_lib::cloud::api::{
    AuthSession, EntryOutcome, EntryResult, InvitationCreated, RemoteApi, RemoteError,
    RemoteTimeEntry, SignUpOutcome, WorkspaceRole, WorkspaceSummary,
};
use studio_pulse_lib::cloud::config::ConfigError;
use studio_pulse_lib::cloud::credentials::{CredentialStore, MemoryCredentialStore};
use studio_pulse_lib::cloud::ledger::SyncLedger;
use studio_pulse_lib::cloud::sync::{
    backoff_delay_ms, spawn, PassOutcome, SyncCommand, SyncCore, SyncHandle, SyncOverview,
    SyncPhase, SyncSettings,
};
use studio_pulse_lib::store::iso_from_ms;

fn set(ids: &[String]) -> HashSet<String> {
    ids.iter().cloned().collect()
}

fn attempts(world: &World, id: &str) -> u32 {
    world.ledger.row(id).attempts
}

// ---- uploading ------------------------------------------------------------------------------

#[test]
fn pending_entries_are_uploaded_and_marked_synced() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(3);
    let mut core = w.core(settings(100));

    assert_eq!(core.run_once(), PassOutcome::Idle);

    for id in &ids {
        let row = w.ledger.row(id);
        assert_eq!(row.status, RowStatus::Synced);
        assert_eq!(row.workspace_id.as_deref(), Some(WS_A));
        assert_eq!(row.synced_at_ms, Some(T0));
    }
    assert_eq!(w.remote.entry_ids(), set(&ids));
    // Uploaded as the signed-in user, into the selected workspace, values unchanged.
    let server = w.remote.state().entries.get(&ids[0]).cloned().unwrap();
    assert_eq!(server.user_id, w.user_id);
    assert_eq!(server.workspace_id, WS_A);
    let local = w.ledger.row(&ids[0]).entry;
    assert_eq!(server.entry.started_at, iso_from_ms(local.started_at_ms));
    assert_eq!(server.entry.ended_at, iso_from_ms(local.ended_at_ms));
    assert_eq!(server.entry.recorded_at, iso_from_ms(local.created_at_ms));
    assert_eq!(server.entry.active_ms, local.active_ms);
    assert_eq!(server.entry.device_id, DEVICE_ID);

    let overview = core.overview();
    assert_eq!(overview.phase, SyncPhase::Idle);
    assert_eq!(overview.pending_count, 0);
    assert_eq!(overview.last_success_at, Some(iso_from_ms(T0)));
    assert_eq!(overview.last_attempt_at, Some(iso_from_ms(T0)));
    assert_eq!(overview.next_attempt_at, None);
    assert_eq!(overview.last_error, None);
    assert_eq!(overview.workspace_id.as_deref(), Some(WS_A));
    assert_eq!(overview.workspace_name.as_deref(), Some("Studio A"));
}

#[test]
fn synced_entries_are_not_uploaded_again() {
    let w = World::signed_in_with_workspace();
    let first = w.ledger.record(3);
    let mut core = w.core(settings(100));
    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(w.remote.sync_batches(), vec![first.clone()]);

    let second = w.ledger.record(2);
    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(w.remote.sync_batches(), vec![first, second]);
    assert_eq!(w.remote.inserts().len(), 5);
}

#[test]
fn open_intervals_are_never_uploaded() {
    let w = World::signed_in_with_workspace();
    let open = w.ledger.record_open();
    let mut core = w.core(settings(100));
    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert!(w.remote.sync_calls().is_empty());
    assert_eq!(w.ledger.status_of(&open), RowStatus::Pending);
}

#[test]
fn a_failed_request_leaves_entries_pending_and_counts_the_attempt() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(3);
    w.remote
        .state()
        .sync_failures
        .push_back(RemoteError::Server(503));
    let mut core = w.core(settings(100));

    assert_eq!(core.run_once(), PassOutcome::RetryAfter(1_000));
    let overview = core.overview();
    assert_eq!(overview.phase, SyncPhase::Backoff);
    assert_eq!(overview.pending_count, 3);
    assert_eq!(
        overview.last_error.as_deref(),
        Some("Supabase returned an error (HTTP 503).")
    );
    assert_eq!(overview.next_attempt_at, Some(iso_from_ms(T0 + 1_000)));
    assert_eq!(overview.last_success_at, None);
    for id in &ids {
        assert_eq!(w.ledger.status_of(id), RowStatus::Pending);
        assert_eq!(attempts(&w, id), 1);
    }
    assert!(w.remote.entry_ids().is_empty());

    // The retry succeeds.
    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(w.ledger.ids_with(RowStatus::Synced), ids);
    assert_eq!(core.overview().last_error, None);
}

#[test]
fn a_lost_response_then_retry_creates_no_duplicate_and_marks_synced() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(3);
    // The server commits the batch, but the answer never reaches the desktop.
    w.remote.state().lost_responses = 1;
    let mut core = w.core(settings(100));

    assert!(matches!(core.run_once(), PassOutcome::RetryAfter(_)));
    assert_eq!(core.overview().phase, SyncPhase::WaitingForNetwork);
    assert_eq!(w.remote.entry_ids(), set(&ids), "committed server-side");
    for id in &ids {
        assert_eq!(
            w.ledger.status_of(id),
            RowStatus::Pending,
            "never marked synced without a confirmation"
        );
    }

    assert_eq!(core.run_once(), PassOutcome::Idle);
    for id in &ids {
        assert_eq!(w.ledger.status_of(id), RowStatus::Synced);
    }
    // Both calls carried the same ids; the server inserted each exactly once.
    assert_eq!(w.remote.sync_batches(), vec![ids.clone(), ids.clone()]);
    let inserts = w.remote.inserts();
    assert_eq!(inserts.len(), 3);
    assert_eq!(set(&inserts), set(&ids));
}

#[test]
fn offline_then_reconnect_uploads_everything_with_growing_delays() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(2);
    {
        let mut state = w.remote.state();
        for _ in 0..3 {
            state
                .sync_failures
                .push_back(RemoteError::Network("could not connect".into()));
        }
    }
    let mut core = w.core(settings(100));
    assert_eq!(core.run_once(), PassOutcome::RetryAfter(1_000));
    assert_eq!(core.overview().phase, SyncPhase::WaitingForNetwork);
    assert_eq!(core.run_once(), PassOutcome::RetryAfter(2_000));
    assert_eq!(core.run_once(), PassOutcome::RetryAfter(4_000));
    assert_eq!(attempts(&w, &ids[0]), 3);
    assert_eq!(
        w.account.status().state,
        AccountState::SignedIn,
        "offline never signs out"
    );

    // Back online.
    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(w.ledger.ids_with(RowStatus::Synced), ids);

    // Success reset the backoff: the next failure starts from the base delay again.
    w.ledger.record(1);
    w.remote
        .state()
        .sync_failures
        .push_back(RemoteError::Network("could not connect".into()));
    assert_eq!(core.run_once(), PassOutcome::RetryAfter(1_000));
}

#[test]
fn offline_without_an_access_token_waits_for_the_network() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(2);
    // The access token expired while offline; the refresh cannot reach Supabase.
    w.clock.advance(TOKEN_TTL_MS);
    w.remote
        .state()
        .refresh_failures
        .push_back(RemoteError::Network("could not connect".into()));
    let mut core = w.core(settings(100));

    assert_eq!(core.run_once(), PassOutcome::RetryAfter(1_000));
    assert_eq!(core.overview().phase, SyncPhase::WaitingForNetwork);
    assert!(
        w.remote.sync_calls().is_empty(),
        "nothing sent without a token"
    );
    assert_eq!(w.account.status().state, AccountState::SignedIn);

    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(w.ledger.ids_with(RowStatus::Synced), ids);
}

#[test]
fn a_partial_batch_marks_rejected_entries_failed_and_never_retries_them() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(5);
    {
        let mut state = w.remote.state();
        state.reject_ids.insert(
            ids[1].clone(),
            "23514: new row violates check constraint".into(),
        );
        state
            .reject_ids
            .insert(ids[3].clone(), "22P02: invalid input syntax".into());
    }
    let mut core = w.core(settings(100));
    assert_eq!(core.run_once(), PassOutcome::Idle);

    assert_eq!(
        w.ledger.ids_with(RowStatus::Synced),
        vec![ids[0].clone(), ids[2].clone(), ids[4].clone()]
    );
    assert_eq!(
        w.ledger.ids_with(RowStatus::Failed),
        vec![ids[1].clone(), ids[3].clone()]
    );
    assert_eq!(
        w.ledger.row(&ids[1]).last_error.as_deref(),
        Some("23514: new row violates check constraint")
    );
    let overview = core.overview();
    assert_eq!(overview.rejected_count, 2);
    assert_eq!(overview.pending_count, 0);
    assert_eq!(overview.phase, SyncPhase::Idle);

    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(
        w.remote.sync_calls().len(),
        1,
        "rejected entries are not retried"
    );
}

#[test]
fn ids_missing_from_the_response_stay_pending() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(4);
    w.remote.state().omit_ids.insert(ids[2].clone());
    let mut core = w.core(settings(100));

    assert_eq!(core.run_once(), PassOutcome::RetryAfter(1_000));
    let overview = core.overview();
    assert_eq!(overview.phase, SyncPhase::Backoff);
    assert!(overview
        .last_error
        .as_deref()
        .unwrap()
        .contains("did not confirm 1 of 4"));
    assert_eq!(overview.pending_count, 1);
    assert_eq!(w.ledger.status_of(&ids[2]), RowStatus::Pending);
    assert_eq!(attempts(&w, &ids[2]), 1);
    for i in [0, 1, 3] {
        assert_eq!(w.ledger.status_of(&ids[i]), RowStatus::Synced);
        assert_eq!(attempts(&w, &ids[i]), 0);
    }

    w.remote.state().omit_ids.clear();
    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(w.ledger.status_of(&ids[2]), RowStatus::Synced);
    assert_eq!(
        w.remote.sync_batches().last().unwrap(),
        &vec![ids[2].clone()]
    );
}

#[test]
fn results_for_ids_that_were_not_sent_are_ignored() {
    // A server answering for the wrong ids confirms nothing: everything stays pending.
    struct WrongIds(Arc<FakeRemote>);
    impl RemoteApi for WrongIds {
        fn sign_in_with_password(&self, e: &str, p: &str) -> Result<AuthSession, RemoteError> {
            self.0.sign_in_with_password(e, p)
        }
        fn sign_up(&self, e: &str, p: &str, d: &str) -> Result<SignUpOutcome, RemoteError> {
            self.0.sign_up(e, p, d)
        }
        fn refresh_session(&self, r: &str) -> Result<AuthSession, RemoteError> {
            self.0.refresh_session(r)
        }
        fn sign_out(&self, a: &str) -> Result<(), RemoteError> {
            self.0.sign_out(a)
        }
        fn my_workspaces(&self, a: &str) -> Result<Vec<WorkspaceSummary>, RemoteError> {
            self.0.my_workspaces(a)
        }
        fn create_workspace(&self, a: &str, n: &str) -> Result<String, RemoteError> {
            self.0.create_workspace(a, n)
        }
        fn accept_invitation(&self, a: &str, t: &str) -> Result<String, RemoteError> {
            self.0.accept_invitation(a, t)
        }
        fn create_invitation(
            &self,
            a: &str,
            w: &str,
            e: &str,
            r: WorkspaceRole,
        ) -> Result<InvitationCreated, RemoteError> {
            self.0.create_invitation(a, w, e, r)
        }
        fn sync_time_entries(
            &self,
            _a: &str,
            _w: &str,
            entries: &[RemoteTimeEntry],
        ) -> Result<Vec<EntryResult>, RemoteError> {
            Ok(entries
                .iter()
                .map(|_| EntryResult {
                    id: uuid::Uuid::now_v7().to_string(),
                    outcome: EntryOutcome::Synced,
                })
                .collect())
        }
    }
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(2);
    let api: Arc<dyn RemoteApi> = Arc::new(WrongIds(Arc::clone(&w.remote)));
    let ledger: Arc<dyn SyncLedger> = w.ledger.clone();
    let mut core = SyncCore::new(
        ledger,
        Arc::clone(&w.account),
        Some(api),
        settings(100),
        w.clock.boxed(),
        Box::new(|| 0.5),
    );
    assert_eq!(core.run_once(), PassOutcome::RetryAfter(1_000));
    for id in &ids {
        assert_eq!(w.ledger.status_of(id), RowStatus::Pending);
        assert_eq!(attempts(&w, id), 1);
    }
}

#[test]
fn result_ids_match_case_insensitively() {
    let w = World::signed_in_with_workspace();
    // A local id in upper case (UUIDs are case-insensitive; the server answers in lower case).
    let id = w.ledger.record(1)[0].clone();
    let upper = id.to_ascii_uppercase();
    w.ledger.state().rows[0].entry.id = upper.clone();
    let mut core = w.core(settings(100));
    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(w.ledger.status_of(&upper), RowStatus::Synced);
}

// ---- authentication and membership ------------------------------------------------------------

#[test]
fn unauthorized_refreshes_the_session_once_and_retries() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(3);
    let old_refresh = w.stored().unwrap().refresh_token;
    // The server stopped accepting the access token although it has not expired locally.
    w.remote.invalidate_access_tokens();
    let mut core = w.core(settings(100));

    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(w.ledger.ids_with(RowStatus::Synced), ids);
    assert_eq!(w.remote.refresh_calls(), 1);
    let tokens: Vec<String> = w
        .remote
        .sync_calls()
        .into_iter()
        .map(|c| match c {
            Call::Sync { access_token, .. } => access_token,
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(tokens.len(), 2);
    assert_ne!(tokens[0], tokens[1], "the retry used the renewed token");
    // The rotated refresh token was persisted; the spent one is dead.
    let new_refresh = w.stored().unwrap().refresh_token;
    assert_ne!(new_refresh, old_refresh);
    let valid = w.remote.valid_refresh_tokens();
    assert!(valid.contains(&new_refresh));
    assert!(!valid.contains(&old_refresh));
}

#[test]
fn a_rejected_refresh_expires_the_session_and_keeps_entries_pending() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(3);
    w.remote.revoke_all_sessions();
    let mut core = w.core(settings(100));

    assert_eq!(core.run_once(), PassOutcome::Blocked);
    let overview = core.overview();
    assert_eq!(overview.phase, SyncPhase::NeedsSignIn);
    assert!(overview.last_error.as_deref().unwrap().contains("expired"));
    assert_eq!(
        overview.pending_count, 3,
        "the expired account's entries still count"
    );

    let status = w.account.status();
    assert_eq!(status.state, AccountState::SessionExpired);
    assert_eq!(status.email.as_deref(), Some(EMAIL));
    assert_eq!(w.stored(), None, "the dead refresh token is removed");
    for id in &ids {
        assert_eq!(w.ledger.status_of(id), RowStatus::Pending);
    }
    assert_eq!(w.ledger.row_count(), 3, "nothing local is deleted");
    assert_eq!(
        w.ledger.state().account_user.as_deref(),
        Some(w.user_id.as_str())
    );

    let calls = w.remote.sync_calls().len();
    assert_eq!(core.run_once(), PassOutcome::Blocked);
    assert_eq!(
        w.remote.sync_calls().len(),
        calls,
        "no uploads while expired"
    );

    // Signing in again resumes the upload of the same entries.
    w.account.sign_in(EMAIL, PASSWORD).unwrap();
    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(w.ledger.ids_with(RowStatus::Synced), ids);
}

#[test]
fn removal_from_the_workspace_is_an_error_and_keeps_entries_pending() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(3);
    w.remote.remove_membership(&w.user_id, WS_A);
    let mut core = w.core(settings(100));

    assert_eq!(core.run_once(), PassOutcome::Blocked);
    let overview = core.overview();
    assert_eq!(overview.phase, SyncPhase::Error);
    assert_eq!(
        overview.last_error.as_deref(),
        Some("not a member of this workspace")
    );
    assert_eq!(overview.pending_count, 3);
    assert_eq!(overview.next_attempt_at, None);
    for id in &ids {
        assert_eq!(w.ledger.status_of(id), RowStatus::Pending);
    }
    assert!(w.remote.entry_ids().is_empty());

    // Re-invited: the next pass (Sync now / account change) uploads.
    w.remote
        .add_membership(&w.user_id, WS_A, "Studio A", WorkspaceRole::Member);
    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(w.ledger.ids_with(RowStatus::Synced), ids);
}

// ---- batching and ownership -----------------------------------------------------------------

#[test]
fn batches_respect_batch_size_and_loop_until_empty() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(7);
    let mut core = w.core(settings(3));

    assert_eq!(core.run_once(), PassOutcome::Idle);
    let batches = w.remote.sync_batches();
    let sizes: Vec<usize> = batches.iter().map(Vec::len).collect();
    assert_eq!(sizes, [3, 3, 1]);
    assert_eq!(batches.concat(), ids, "oldest first, each exactly once");
    assert_eq!(w.ledger.ids_with(RowStatus::Synced), ids);
}

#[test]
fn a_large_backlog_yields_between_passes_and_finishes() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(60);
    let mut core = w.core(settings(1));

    assert_eq!(
        core.run_once(),
        PassOutcome::RetryAfter(0),
        "yields to the thread"
    );
    assert_eq!(core.overview().phase, SyncPhase::Syncing);
    let mut passes = 1;
    while core.run_once() != PassOutcome::Idle {
        passes += 1;
        assert!(passes < 10, "the backlog must drain");
    }
    assert!(w.remote.sync_batches().iter().all(|b| b.len() == 1));
    assert_eq!(w.remote.sync_batches().concat(), ids);
    assert_eq!(w.ledger.ids_with(RowStatus::Synced), ids);
}

#[test]
fn batch_size_is_clamped_to_the_server_limit() {
    let w = World::signed_in_with_workspace();
    w.ledger.record(501);
    let mut core = w.core(SyncSettings {
        batch_size: 10_000,
        ..settings(0)
    });
    assert_eq!(core.run_once(), PassOutcome::Idle);
    let sizes: Vec<usize> = w.remote.sync_batches().iter().map(Vec::len).collect();
    assert_eq!(sizes, [500, 1]);

    // And a batch size of 0 still makes progress.
    w.ledger.record(2);
    let mut core = w.core(settings(0));
    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(w.ledger.ids_with(RowStatus::Pending), Vec::<String>::new());
}

#[test]
fn other_users_entries_are_never_uploaded() {
    let w = World::signed_in_with_workspace();
    let someone_else = w
        .ledger
        .record_for(Some("0190a7f0-0000-7000-8000-0000000000ee"), 2);
    let unowned = w.ledger.record_for(None, 2);
    let mine = w.ledger.record(2);
    let mut core = w.core(settings(100));

    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(w.remote.entry_ids(), set(&mine));
    let overview = core.overview();
    assert_eq!(overview.pending_count, 0);
    assert_eq!(overview.unclaimed_count, 2);

    // Only an explicit claim makes signed-out history this account's.
    assert_eq!(w.ledger.claim_unowned(&w.user_id).unwrap(), 2);
    assert_eq!(core.run_once(), PassOutcome::Idle);
    let mut expected = set(&mine);
    expected.extend(unowned.iter().cloned());
    assert_eq!(w.remote.entry_ids(), expected);

    let sent: HashSet<String> = w.remote.sync_batches().concat().into_iter().collect();
    for id in &someone_else {
        assert!(!sent.contains(id), "another account's interval was sent");
        assert_eq!(w.ledger.status_of(id), RowStatus::Pending);
    }
}

// ---- phases without an upload ---------------------------------------------------------------

#[test]
fn not_configured_is_disabled() {
    let clock = TestClock::new(T0);
    let ledger = Arc::new(FakeLedger::default());
    ledger.record_for(None, 2);
    let account = Arc::new(AccountManager::new(
        Err(ConfigError::Missing),
        None,
        Arc::new(MemoryCredentialStore::default()),
        ledger.clone(),
        clock.boxed_sync(),
    ));
    account.restore();
    let mut core = SyncCore::new(
        ledger,
        account,
        None,
        settings(10),
        clock.boxed(),
        Box::new(|| 0.5),
    );
    assert_eq!(core.overview().phase, SyncPhase::Disabled);
    assert_eq!(core.run_once(), PassOutcome::Blocked);
    assert_eq!(core.overview().phase, SyncPhase::Disabled);
}

#[test]
fn signed_out_needs_sign_in_only_when_history_is_waiting() {
    let w = World::new();
    w.account.restore();
    let mut core = w.core(settings(10));
    assert_eq!(core.run_once(), PassOutcome::Blocked);
    assert_eq!(core.overview().phase, SyncPhase::Disabled);

    w.ledger.record(2); // recorded while signed out: unowned
    assert_eq!(core.run_once(), PassOutcome::Blocked);
    let overview = core.overview();
    assert_eq!(overview.phase, SyncPhase::NeedsSignIn);
    assert_eq!(overview.unclaimed_count, 2);
    assert_eq!(overview.pending_count, 0);
    assert!(w.remote.sync_calls().is_empty());
}

#[test]
fn signed_in_without_a_workspace_needs_one() {
    let w = World::new();
    w.account.sign_in(EMAIL, PASSWORD).unwrap();
    w.ledger.record(2);
    let mut core = w.core(settings(10));
    assert_eq!(core.run_once(), PassOutcome::Blocked);
    let overview = core.overview();
    assert_eq!(overview.phase, SyncPhase::NeedsWorkspace);
    assert_eq!(overview.pending_count, 2);
    assert!(w.remote.sync_calls().is_empty());
}

// ---- backoff --------------------------------------------------------------------------------

#[test]
fn rate_limiting_honours_retry_after_within_bounds() {
    let w = World::signed_in_with_workspace();
    w.ledger.record(1);
    let mut core = w.core(settings(10)); // max delay 8 s
    let cases = [
        (Some(7_000), 7_000),
        (Some(36_000_000), 8_000),
        (Some(0), 1_000),
    ];
    for (retry_after_ms, expected) in cases {
        w.remote
            .state()
            .sync_failures
            .push_back(RemoteError::RateLimited { retry_after_ms });
        assert_eq!(core.run_once(), PassOutcome::RetryAfter(expected));
        assert_eq!(core.overview().phase, SyncPhase::Backoff);
    }
    // Without Retry-After: the regular backoff (4th consecutive failure → 8 s, the cap).
    w.remote
        .state()
        .sync_failures
        .push_back(RemoteError::RateLimited {
            retry_after_ms: None,
        });
    assert_eq!(core.run_once(), PassOutcome::RetryAfter(8_000));
}

#[test]
fn the_core_applies_jitter_to_its_delays() {
    let w = World::signed_in_with_workspace();
    w.ledger.record(1);
    let api: Arc<dyn RemoteApi> = w.remote.clone();
    let ledger: Arc<dyn SyncLedger> = w.ledger.clone();
    let mut core = SyncCore::new(
        ledger,
        Arc::clone(&w.account),
        Some(api),
        settings(10),
        w.clock.boxed(),
        Box::new(|| 0.0),
    );
    w.remote
        .state()
        .sync_failures
        .push_back(RemoteError::Server(502));
    assert_eq!(core.run_once(), PassOutcome::RetryAfter(800));
}

#[test]
fn backoff_is_bounded_and_monotone_without_jitter() {
    let s = SyncSettings {
        batch_size: 100,
        base_delay_ms: 5_000,
        max_delay_ms: 15 * 60_000,
        idle_interval_ms: 300_000,
    };
    let mut previous = 0;
    for attempt in 1..=200 {
        let delay = backoff_delay_ms(attempt, &s, 0.5);
        assert!(delay >= previous, "attempt {attempt}: {delay} < {previous}");
        assert!(delay <= s.max_delay_ms);
        previous = delay;
    }
    assert_eq!(backoff_delay_ms(1, &s, 0.5), 5_000);
    assert_eq!(backoff_delay_ms(2, &s, 0.5), 10_000);
    assert_eq!(backoff_delay_ms(200, &s, 0.5), s.max_delay_ms);
}

#[test]
fn backoff_jitter_stays_within_twenty_percent() {
    let s = SyncSettings::default();
    for attempt in 1..=12 {
        let nominal = backoff_delay_ms(attempt, &s, 0.5) as f64;
        for step in 0..=100 {
            let unit = f64::from(step) / 100.0;
            let delay = backoff_delay_ms(attempt, &s, unit) as f64;
            assert!(
                delay >= (nominal * 0.8).floor(),
                "{attempt} {unit}: {delay}"
            );
            assert!(delay <= (nominal * 1.2).ceil(), "{attempt} {unit}: {delay}");
        }
    }
    // Never above 1.2 × max, whatever the input.
    let worst = backoff_delay_ms(u32::MAX, &s, 1.0);
    assert!(worst <= s.max_delay_ms * 12 / 10);
}

// ---- local failures -------------------------------------------------------------------------

#[test]
fn a_local_write_failure_after_upload_is_retried_without_duplicates() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(2);
    w.ledger.fail_mark_synced.store(true, Ordering::SeqCst);
    let mut core = w.core(settings(100));

    assert_eq!(core.run_once(), PassOutcome::RetryAfter(1_000));
    let overview = core.overview();
    assert_eq!(overview.phase, SyncPhase::Error);
    assert!(overview.last_error.unwrap().contains("local database"));
    assert_eq!(w.ledger.ids_with(RowStatus::Pending), ids);

    w.ledger.fail_mark_synced.store(false, Ordering::SeqCst);
    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(w.ledger.ids_with(RowStatus::Synced), ids);
    assert_eq!(
        w.remote.inserts().len(),
        2,
        "the retry was answered 'already present'"
    );
}

#[test]
fn an_update_that_does_not_stick_cannot_loop_forever() {
    let w = World::signed_in_with_workspace();
    w.ledger.record(3);
    w.ledger.ignore_mark_synced.store(true, Ordering::SeqCst);
    let mut core = w.core(settings(3));

    assert!(matches!(core.run_once(), PassOutcome::RetryAfter(_)));
    assert_eq!(core.overview().phase, SyncPhase::Error);
    assert_eq!(
        w.remote.sync_calls().len(),
        1,
        "the same batch is not resent in the pass"
    );
}

// ---- the sync thread --------------------------------------------------------------------------

struct Running {
    handle: SyncHandle,
    seen: Arc<Mutex<Vec<SyncOverview>>>,
}

fn start(world: &World, settings: SyncSettings) -> Running {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let handle = spawn(
        world.core(settings),
        Box::new(move |o: &SyncOverview| sink.lock().unwrap().push(o.clone())),
    )
    .expect("spawn the sync thread");
    Running { handle, seen }
}

fn sync_now(handle: &SyncHandle) {
    let (reply, done) = mpsc::channel();
    handle.send(SyncCommand::SyncNow { reply });
    done.recv_timeout(Duration::from_secs(10))
        .expect("SyncNow replies after its pass");
}

fn shutdown(handle: &SyncHandle) {
    let (reply, done) = mpsc::channel();
    handle.send(SyncCommand::Shutdown { reply });
    done.recv_timeout(Duration::from_secs(10))
        .expect("Shutdown replies");
}

fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    condition()
}

#[test]
fn sync_now_uploads_on_the_sync_thread_and_replies_after_the_pass() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(3);
    let running = start(&w, settings(100));

    sync_now(&running.handle);
    assert_eq!(
        w.ledger.ids_with(RowStatus::Synced),
        ids,
        "done before the reply"
    );
    for call in w.remote.sync_calls() {
        let Call::Sync { thread, .. } = call else {
            unreachable!()
        };
        assert_eq!(thread.as_deref(), Some("studio-pulse-sync"));
    }
    let overview = running.handle.overview();
    assert_eq!(overview.phase, SyncPhase::Idle);
    assert_eq!(overview.pending_count, 0);
    let phases: Vec<SyncPhase> = running
        .seen
        .lock()
        .unwrap()
        .iter()
        .map(|o| o.phase)
        .collect();
    assert!(phases.contains(&SyncPhase::Syncing), "{phases:?}");
    assert_eq!(phases.last(), Some(&SyncPhase::Idle));
    shutdown(&running.handle);
}

#[test]
fn the_observer_is_called_only_when_the_overview_changes() {
    let w = World::signed_in_with_workspace();
    let running = start(&w, settings(100));
    sync_now(&running.handle);
    let after_first = running.seen.lock().unwrap().len();
    sync_now(&running.handle);
    sync_now(&running.handle);
    assert_eq!(running.seen.lock().unwrap().len(), after_first);
    let seen = running.seen.lock().unwrap().clone();
    for pair in seen.windows(2) {
        assert_ne!(
            pair[0], pair[1],
            "consecutive identical overviews were published"
        );
    }
    shutdown(&running.handle);
}

#[test]
fn a_kick_while_backing_off_refreshes_counts_without_submitting() {
    let w = World::signed_in_with_workspace();
    w.ledger.record(3);
    w.remote
        .state()
        .sync_failures
        .push_back(RemoteError::Server(503));
    let running = start(
        &w,
        SyncSettings {
            base_delay_ms: 60_000,
            max_delay_ms: 120_000,
            ..settings(100)
        },
    );
    sync_now(&running.handle);
    assert_eq!(running.handle.overview().phase, SyncPhase::Backoff);
    assert_eq!(w.remote.sync_calls().len(), 1);

    w.ledger.record(1);
    running.handle.send(SyncCommand::Kick);
    assert!(
        wait_until(Duration::from_secs(6), || running
            .handle
            .overview()
            .pending_count
            == 4),
        "the kick refreshed the counts"
    );
    assert_eq!(
        w.remote.sync_calls().len(),
        1,
        "no submission while backing off"
    );

    // "Sync now" ignores the backoff.
    sync_now(&running.handle);
    assert_eq!(w.remote.sync_calls().len(), 2);
    assert_eq!(running.handle.overview().phase, SyncPhase::Idle);
    assert_eq!(running.handle.overview().pending_count, 0);
    shutdown(&running.handle);
}

#[test]
fn a_kick_uploads_after_the_debounce() {
    let w = World::signed_in_with_workspace();
    let running = start(&w, settings(100));
    sync_now(&running.handle); // nothing pending: idle

    let ids = w.ledger.record(2);
    let kicked = Instant::now();
    running.handle.send(SyncCommand::Kick);
    running.handle.send(SyncCommand::Kick);
    assert!(wait_until(Duration::from_secs(8), || {
        w.ledger.ids_with(RowStatus::Synced) == ids
    }));
    assert!(
        kicked.elapsed() >= Duration::from_millis(1_500),
        "kicks are debounced"
    );
    assert_eq!(w.remote.sync_calls().len(), 1, "two kicks, one upload");
    shutdown(&running.handle);
}

#[test]
fn an_account_change_runs_a_pass_soon() {
    let w = World::new();
    w.remote
        .add_membership(&w.user_id, WS_A, "Studio A", WorkspaceRole::Owner);
    w.remote
        .add_membership(&w.user_id, WS_B, "Studio B", WorkspaceRole::Member);
    w.account.sign_in(EMAIL, PASSWORD).unwrap(); // two memberships: none selected
    let ids = w.ledger.record(2);
    let running = start(&w, settings(100));
    sync_now(&running.handle);
    assert_eq!(running.handle.overview().phase, SyncPhase::NeedsWorkspace);

    w.account.select_sync_workspace(Some(WS_B)).unwrap();
    running.handle.send(SyncCommand::AccountChanged);
    assert!(wait_until(Duration::from_secs(5), || {
        w.ledger.ids_with(RowStatus::Synced) == ids
    }));
    assert!(wait_until(Duration::from_secs(2), || {
        running.handle.overview().workspace_name.as_deref() == Some("Studio B")
    }));
    assert_eq!(w.ledger.row(&ids[0]).workspace_id.as_deref(), Some(WS_B));
    shutdown(&running.handle);
}

#[test]
fn a_panicking_pass_does_not_stop_the_thread() {
    let w = World::signed_in_with_workspace();
    let ids = w.ledger.record(2);
    w.ledger.panic_on_read.store(true, Ordering::SeqCst);
    let running = start(&w, settings(100));

    sync_now(&running.handle);
    let overview = running.handle.overview();
    assert_eq!(overview.phase, SyncPhase::Error);
    assert!(overview.last_error.unwrap().contains("internal error"));

    w.ledger.panic_on_read.store(false, Ordering::SeqCst);
    sync_now(&running.handle);
    assert_eq!(w.ledger.ids_with(RowStatus::Synced), ids);
    assert_eq!(running.handle.overview().phase, SyncPhase::Idle);
    shutdown(&running.handle);
}

#[test]
fn shutdown_replies_and_stops_the_thread() {
    let w = World::signed_in_with_workspace();
    let running = start(&w, settings(100));
    shutdown(&running.handle);
    // Later commands are dropped (logged), never block or panic.
    running.handle.send(SyncCommand::Kick);
    let (reply, done) = mpsc::channel();
    running.handle.send(SyncCommand::SyncNow { reply });
    assert!(done.recv_timeout(Duration::from_millis(200)).is_err());
}

#[test]
fn credentials_are_untouched_by_sync() {
    // The sync service never reads or writes the credential store except through refreshes.
    let w = World::signed_in_with_workspace();
    w.ledger.record(1);
    let before = w.stored();
    let mut core = w.core(settings(10));
    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(w.stored(), before);
    assert!(w.credentials.load().unwrap().is_some());
}
