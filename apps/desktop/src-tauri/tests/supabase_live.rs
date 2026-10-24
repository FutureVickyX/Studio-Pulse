//! Live end-to-end checks against a real Supabase project (ignored by default).
//!
//! - `live_sync_is_idempotent_and_never_duplicates`: the HTTP contract. It signs in with a test
//!   account, uploads three synthetic intervals to a workspace the account belongs to, sends the
//!   same batch again (a retry after a lost response), checks that every entry is confirmed both
//!   times and that exactly one row per id is visible, then deletes the rows with the client's
//!   own `delete_time_entries` (checking they are gone) and signs out.
//! - `live_desktop_pipeline_claims_uploads_and_never_duplicates`: the pipeline the app runs: the
//!   SQLite outbox ([`Store`]), [`AccountManager`] and [`SyncCore`] over the real HTTP client.
//!   History recorded while signed out stays local until it is claimed, open intervals never
//!   upload, a lost response is retried without duplicates, a persisted refresh token restores
//!   the session, and signing out stops uploads. The session is kept in memory, so the app's own
//!   Credential Manager entry is never touched.
//!
//! Environment (all required; the test skips with a message when one is missing):
//! - `STUDIO_PULSE_SUPABASE_URL`, `STUDIO_PULSE_SUPABASE_PUBLISHABLE_KEY` (public values)
//! - `SP_LIVE_EMAIL`, `SP_LIVE_PASSWORD` (a dedicated test account)
//! - `SP_LIVE_WORKSPACE_ID` (a workspace that account is an active member of)
//!
//! Run: `cargo test --test supabase_live -- --ignored --nocapture`
//!
//! Nothing secret is printed: tokens stay in memory, errors carry only safe messages.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use rusqlite::{params, Connection};
use studio_pulse_lib::cloud::account::{AccountManager, AccountState};
use studio_pulse_lib::cloud::api::{EntryOutcome, EntryResult, RemoteApi, RemoteTimeEntry};
use studio_pulse_lib::cloud::config::SupabaseConfig;
use studio_pulse_lib::cloud::credentials::{CredentialStore, MemoryCredentialStore};
use studio_pulse_lib::cloud::http::SupabaseHttp;
use studio_pulse_lib::cloud::ledger::SyncLedger;
use studio_pulse_lib::cloud::sync::{PassOutcome, SyncCore, SyncPhase, SyncSettings};
use studio_pulse_lib::store::Store;
use studio_pulse_lib::tracker::{EndReason, Interval, IntervalKind};
use tempfile::TempDir;

const VARS: [&str; 5] = [
    "STUDIO_PULSE_SUPABASE_URL",
    "STUDIO_PULSE_SUPABASE_PUBLISHABLE_KEY",
    "SP_LIVE_EMAIL",
    "SP_LIVE_PASSWORD",
    "SP_LIVE_WORKSPACE_ID",
];

fn iso(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .expect("a representable instant")
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Three closed one-minute active intervals in the last few minutes, fresh UUIDv7 ids.
fn synthetic_entries() -> Vec<RemoteTimeEntry> {
    let device_id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().timestamp_millis();
    (0..3)
        .map(|i| {
            let started = now - (3 - i) * 120_000;
            let ended = started + 60_000;
            RemoteTimeEntry {
                id: uuid::Uuid::now_v7().to_string(),
                device_id: device_id.clone(),
                application_id: "studio-pulse-live-test".into(),
                application_name: "Studio Pulse live test".into(),
                kind: "active".into(),
                started_at: iso(started),
                ended_at: iso(ended),
                active_ms: 60_000,
                idle_ms: 0,
                end_reason: "appSwitch".into(),
                project_id: None,
                task_id: None,
                revision: 1,
                recorded_at: iso(ended + 1_000),
            }
        })
        .collect()
}

fn assert_all_synced(entries: &[RemoteTimeEntry], results: &[EntryResult], pass: &str) {
    assert_eq!(results.len(), entries.len(), "{pass}: one result per entry");
    for entry in entries {
        let result = results
            .iter()
            .find(|r| r.id.eq_ignore_ascii_case(&entry.id))
            .unwrap_or_else(|| panic!("{pass}: no result for one of the entries"));
        assert_eq!(result.outcome, EntryOutcome::Synced, "{pass}");
    }
}

fn rest_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("HTTP client")
}

fn id_filter(entries: &[RemoteTimeEntry]) -> String {
    let ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
    format!("in.({})", ids.join(","))
}

/// `{url}/rest/v1/time_entries?<params>` (PostgREST filters as query parameters).
fn time_entries_url(config: &SupabaseConfig, params: &[(&str, String)]) -> reqwest::Url {
    reqwest::Url::parse_with_params(&format!("{}/rest/v1/time_entries", config.url), params)
        .expect("a valid URL")
}

/// The ids of `time_entries` rows visible to the user among `entries` (RLS: their own rows).
fn visible_ids(
    config: &SupabaseConfig,
    access_token: &str,
    entries: &[RemoteTimeEntry],
) -> Vec<String> {
    let response = rest_client()
        .get(time_entries_url(
            config,
            &[("select", "id".to_owned()), ("id", id_filter(entries))],
        ))
        .header("apikey", &config.publishable_key)
        .bearer_auth(access_token)
        .send()
        .expect("select time_entries");
    let status = response.status();
    assert!(status.is_success(), "select time_entries: HTTP {status}");
    let rows: Vec<serde_json::Value> = response.json().expect("a JSON array");
    rows.iter()
        .filter_map(|row| row.get("id").and_then(|v| v.as_str()).map(str::to_owned))
        .collect()
}

/// `[url, key, email, password, workspace_id]` (trimmed), or `None` with a message when one is
/// missing.
fn live_env() -> Option<[String; 5]> {
    let values: Vec<Option<String>> = VARS
        .iter()
        .map(|name| std::env::var(name).ok().filter(|v| !v.trim().is_empty()))
        .collect();
    let missing: Vec<&str> = VARS
        .iter()
        .zip(&values)
        .filter(|(_, value)| value.is_none())
        .map(|(name, _)| *name)
        .collect();
    if !missing.is_empty() {
        eprintln!(
            "skipping the live Supabase test: set {} (see tests/supabase_live.rs)",
            missing.join(", ")
        );
        return None;
    }
    let trimmed: Vec<String> = values
        .into_iter()
        .map(|value| value.unwrap_or_default().trim().to_owned())
        .collect();
    trimmed.try_into().ok()
}

#[test]
#[ignore = "talks to a real Supabase project; see the module docs for the environment"]
fn live_sync_is_idempotent_and_never_duplicates() {
    let Some([url, key, email, password, workspace_id]) = live_env() else {
        return;
    };

    let config = SupabaseConfig::validate(&url, &key)
        .unwrap_or_else(|err| panic!("STUDIO_PULSE_SUPABASE_URL / _PUBLISHABLE_KEY: {err}"));
    let http = SupabaseHttp::new(config.clone()).expect("HTTP client");

    let session = http
        .sign_in_with_password(email.trim(), &password)
        .unwrap_or_else(|err| panic!("sign in: {err}"));
    let workspaces = http
        .my_workspaces(&session.access_token)
        .unwrap_or_else(|err| panic!("my_workspaces: {err}"));
    assert!(
        workspaces
            .iter()
            .any(|w| w.id.eq_ignore_ascii_case(workspace_id.trim())),
        "the test account must be an active member of SP_LIVE_WORKSPACE_ID"
    );

    let entries = synthetic_entries();
    let first = http
        .sync_time_entries(&session.access_token, workspace_id.trim(), &entries)
        .unwrap_or_else(|err| panic!("first upload: {err}"));
    assert_all_synced(&entries, &first, "first upload");

    // The same batch again, as after a lost response: confirmed ("already present"), not doubled.
    let retry = http
        .sync_time_entries(&session.access_token, workspace_id.trim(), &entries)
        .unwrap_or_else(|err| panic!("retry: {err}"));
    assert_all_synced(&entries, &retry, "retry");

    let mut visible = visible_ids(&config, &session.access_token, &entries);
    visible.sort();
    let mut expected: Vec<String> = entries.iter().map(|e| e.id.to_ascii_lowercase()).collect();
    expected.sort();
    assert_eq!(visible, expected, "exactly one row per entry id");

    // The client's own DELETE (used for history deleted while its upload was in flight).
    let ids: Vec<String> = entries.iter().map(|e| e.id.clone()).collect();
    http.delete_time_entries(&session.access_token, &ids)
        .unwrap_or_else(|err| panic!("delete_time_entries: {err}"));
    assert!(
        visible_ids(&config, &session.access_token, &entries).is_empty(),
        "the rows are gone"
    );
    if http.sign_out(&session.access_token).is_err() {
        eprintln!("cleanup: sign-out did not complete; the test session lapses on its own");
    }
    eprintln!("live Supabase sync: 3 entries uploaded, retried idempotently, cleaned up");
}

// ---- the desktop pipeline ------------------------------------------------------------------

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// A Figma interval as the tracker records it (closed with an app switch unless `open`).
fn figma(id: &str, started_at_ms: i64, ended_at_ms: i64, open: bool) -> Interval {
    Interval {
        id: id.to_owned(),
        application_id: "figma".into(),
        application_name: "Figma".into(),
        kind: IntervalKind::Active,
        started_at_ms,
        ended_at_ms,
        open,
        end_reason: (!open).then_some(EndReason::AppSwitch),
    }
}

fn instant_ms(value: &serde_json::Value, field: &str) -> i64 {
    let text = value[field]
        .as_str()
        .unwrap_or_else(|| panic!("{field} is a string"));
    DateTime::parse_from_rfc3339(text)
        .unwrap_or_else(|err| panic!("{field} is RFC 3339: {err}"))
        .timestamp_millis()
}

/// The caller's `time_entries` rows among `ids`.
fn server_rows(
    config: &SupabaseConfig,
    access_token: &str,
    ids: &[String],
) -> Vec<serde_json::Value> {
    const COLUMNS: &str = "id,user_id,workspace_id,device_id,application_id,kind,started_at,\
                           ended_at,active_ms,idle_ms,end_reason";
    let url = reqwest::Url::parse_with_params(
        &format!("{}/rest/v1/time_entries", config.url),
        &[
            ("select", COLUMNS.to_owned()),
            ("id", format!("in.({})", ids.join(","))),
        ],
    )
    .expect("a valid URL");
    let response = rest_client()
        .get(url)
        .header("apikey", &config.publishable_key)
        .bearer_auth(access_token)
        .send()
        .expect("select time_entries");
    let status = response.status();
    assert!(status.is_success(), "select time_entries: HTTP {status}");
    response.json().expect("a JSON array")
}

/// `(sync_status, workspace_id)` of a local row, read through a second connection.
fn local_sync_state(path: &Path, id: &str) -> (String, Option<String>) {
    Connection::open(path)
        .expect("open the database")
        .query_row(
            "SELECT sync_status, workspace_id FROM tracking_events WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the row exists")
}

/// Deletes the test's server rows when the test ends, also when an assertion failed.
struct DeleteRowsOnDrop {
    config: SupabaseConfig,
    email: String,
    password: String,
    ids: Vec<String>,
}

impl Drop for DeleteRowsOnDrop {
    fn drop(&mut self) {
        let Ok(http) = SupabaseHttp::new(self.config.clone()) else {
            return;
        };
        let Ok(session) = http.sign_in_with_password(&self.email, &self.password) else {
            eprintln!("cleanup: could not sign in to delete the test rows");
            return;
        };
        if http
            .delete_time_entries(&session.access_token, &self.ids)
            .is_err()
        {
            eprintln!("cleanup: deleting the test rows did not complete");
        }
        let _ = http.sign_out(&session.access_token);
    }
}

fn same_id(a: Option<&str>, b: &str) -> bool {
    a.is_some_and(|a| a.eq_ignore_ascii_case(b))
}

#[test]
#[ignore = "talks to a real Supabase project; see the module docs for the environment"]
fn live_desktop_pipeline_claims_uploads_and_never_duplicates() {
    let Some([url, key, email, password, workspace_id]) = live_env() else {
        return;
    };
    let config = SupabaseConfig::validate(&url, &key)
        .unwrap_or_else(|err| panic!("STUDIO_PULSE_SUPABASE_URL / _PUBLISHABLE_KEY: {err}"));
    let api: Arc<dyn RemoteApi> = Arc::new(SupabaseHttp::new(config.clone()).expect("HTTP client"));

    let dir = TempDir::new().expect("a temporary directory");
    let path = dir.path().join("studio-pulse.db");
    let store = Arc::new(Store::open(&path).expect("open the store"));
    let ledger: Arc<dyn SyncLedger> = store.clone();
    let device = store.device_id().expect("device id");

    let new_id = || uuid::Uuid::now_v7().to_string();
    let signed_out = [new_id(), new_id()];
    let open_id = new_id();
    let signed_in = new_id();
    let after_sign_out = new_id();
    let _cleanup = DeleteRowsOnDrop {
        config: config.clone(),
        email: email.clone(),
        password: password.clone(),
        ids: vec![
            signed_out[0].clone(),
            signed_out[1].clone(),
            open_id.clone(),
            signed_in.clone(),
            after_sign_out.clone(),
        ],
    };
    // Whole milliseconds 20 minutes ago; one duration is deliberately not a whole second.
    let base = now_ms() - 20 * 60_000;

    // 1. Signed out: two closed intervals and an open one are recorded with no owner.
    store
        .upsert_intervals(
            &device,
            &[
                figma(&signed_out[0], base, base + 60_000, false),
                figma(&signed_out[1], base + 60_000, base + 125_500, false),
                figma(&open_id, base + 125_500, base + 130_000, true),
            ],
        )
        .expect("record while signed out");
    assert_eq!(ledger.outbox_counts(None).expect("counts").unclaimed, 2);

    // 2. Sign in. The session lives in memory here (the app uses Credential Manager).
    let credentials: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
    let account = Arc::new(AccountManager::new(
        Ok(config.clone()),
        Some(Arc::clone(&api)),
        Arc::clone(&credentials),
        Arc::clone(&ledger),
        Box::new(now_ms),
    ));
    let status = account
        .sign_in(&email, &password)
        .unwrap_or_else(|err| panic!("sign in: {err}"));
    assert_eq!(status.state, AccountState::SignedIn);
    let user_id = status.user_id.clone().expect("a user id");
    assert!(
        credentials.load().expect("credentials").is_some(),
        "the refresh token is persisted"
    );
    let counts = ledger.outbox_counts(Some(&user_id)).expect("counts");
    assert_eq!(
        (counts.pending, counts.unclaimed),
        (0, 2),
        "signed-out history is not the account's"
    );

    // 3. The sync workspace must be one of the account's memberships on the server.
    assert!(
        account
            .select_sync_workspace(Some(&uuid::Uuid::new_v4().to_string()))
            .is_err(),
        "a workspace the account is not a member of is refused"
    );
    let status = account
        .select_sync_workspace(Some(&workspace_id))
        .unwrap_or_else(|err| panic!("select the workspace: {err}"));
    assert!(same_id(status.sync_workspace_id.as_deref(), &workspace_id));

    let new_core = |account: &Arc<AccountManager>| {
        SyncCore::new(
            Arc::clone(&ledger),
            Arc::clone(account),
            Some(Arc::clone(&api)),
            SyncSettings::default(),
            Box::new(now_ms),
            Box::new(|| 0.5),
        )
    };
    let mut core = new_core(&account);

    // 4. Nothing of the unclaimed history uploads.
    assert_eq!(core.run_once(), PassOutcome::Idle);
    let token = account.access().expect("an access token").access_token;
    assert!(
        server_rows(&config, &token, &signed_out).is_empty(),
        "unclaimed history stayed local"
    );

    // 5. An interval recorded while signed in is stamped with the account and uploaded.
    store
        .upsert_intervals(
            &device,
            &[figma(&signed_in, base + 200_000, base + 260_000, false)],
        )
        .expect("record while signed in");
    assert_eq!(
        ledger
            .outbox_counts(Some(&user_id))
            .expect("counts")
            .pending,
        1
    );
    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(local_sync_state(&path, &signed_in).0, "synced");
    assert_eq!(
        server_rows(&config, &token, std::slice::from_ref(&signed_in)).len(),
        1
    );

    // 6. Explicit claim: closed and open history becomes the account's; only closed rows upload.
    assert_eq!(ledger.claim_unowned(&user_id).expect("claim"), 3);
    assert_eq!(core.run_once(), PassOutcome::Idle);
    for id in &signed_out {
        let (status, workspace) = local_sync_state(&path, id);
        assert_eq!(status, "synced");
        assert!(same_id(workspace.as_deref(), &workspace_id));
    }
    assert!(
        server_rows(&config, &token, std::slice::from_ref(&open_id)).is_empty(),
        "an open interval is never uploaded"
    );

    // 7. The server holds exactly what was measured: UTC instants, the split, the owner.
    let rows = server_rows(&config, &token, &signed_out);
    assert_eq!(rows.len(), 2);
    let row = rows
        .iter()
        .find(|r| same_id(r["id"].as_str(), &signed_out[1]))
        .expect("the second interval");
    assert_eq!(instant_ms(row, "started_at"), base + 60_000);
    assert_eq!(instant_ms(row, "ended_at"), base + 125_500);
    assert_eq!(row["active_ms"].as_i64(), Some(65_500));
    assert_eq!(row["idle_ms"].as_i64(), Some(0));
    assert_eq!(row["kind"], "active");
    assert_eq!(row["application_id"], "figma");
    assert_eq!(row["end_reason"], "appSwitch");
    assert!(same_id(row["user_id"].as_str(), &user_id));
    assert!(same_id(row["workspace_id"].as_str(), &workspace_id));
    assert!(same_id(row["device_id"].as_str(), &device));

    // 8. A lost response: the row is still pending locally, the retry is confirmed as already
    //    present, and nothing is duplicated.
    Connection::open(&path)
        .expect("open the database")
        .execute(
            "UPDATE tracking_events SET sync_status = 'pending', workspace_id = NULL, \
             synced_at_ms = NULL WHERE id = ?1",
            params![signed_out[0]],
        )
        .expect("simulate a lost response");
    assert_eq!(core.run_once(), PassOutcome::Idle);
    assert_eq!(local_sync_state(&path, &signed_out[0]).0, "synced");
    assert_eq!(
        server_rows(&config, &token, &signed_out).len(),
        2,
        "no duplicates"
    );

    // 9. Next launch: the persisted refresh token restores the same account.
    let restarted = Arc::new(AccountManager::new(
        Ok(config.clone()),
        Some(Arc::clone(&api)),
        Arc::clone(&credentials),
        Arc::clone(&ledger),
        Box::new(now_ms),
    ));
    restarted.restore();
    let status = restarted.status();
    assert_eq!(
        status.state,
        AccountState::SignedIn,
        "the session is restored"
    );
    assert_eq!(status.user_id.as_deref(), Some(user_id.as_str()));
    drop(core);
    let mut core = new_core(&restarted);

    // 10. The open interval closes and the next pass uploads it.
    store
        .upsert_intervals(
            &device,
            &[figma(&open_id, base + 125_500, base + 140_000, false)],
        )
        .expect("close the open interval");
    assert_eq!(core.run_once(), PassOutcome::Idle);
    let token = restarted.access().expect("an access token").access_token;
    let uploaded = [
        signed_out[0].clone(),
        signed_out[1].clone(),
        open_id.clone(),
        signed_in.clone(),
    ];
    assert_eq!(server_rows(&config, &token, &uploaded).len(), 4);
    let counts = ledger.outbox_counts(Some(&user_id)).expect("counts");
    assert_eq!(
        (counts.pending, counts.unclaimed, counts.rejected),
        (0, 0, 0)
    );

    // 11. Sign out: the session is gone, new intervals have no owner, and nothing uploads.
    let status = restarted
        .sign_out()
        .unwrap_or_else(|err| panic!("sign out: {err}"));
    assert_eq!(status.state, AccountState::SignedOut);
    assert!(
        credentials.load().expect("credentials").is_none(),
        "the refresh token is cleared"
    );
    store
        .upsert_intervals(
            &device,
            &[figma(
                &after_sign_out,
                base + 300_000,
                base + 310_000,
                false,
            )],
        )
        .expect("record after signing out");
    assert_eq!(ledger.outbox_counts(None).expect("counts").unclaimed, 1);
    assert_eq!(core.run_once(), PassOutcome::Blocked);
    assert_eq!(core.overview().phase, SyncPhase::NeedsSignIn);
    assert_eq!(local_sync_state(&path, &after_sign_out).0, "pending");

    eprintln!(
        "live desktop pipeline: claim, upload, retry without duplicates, restore and sign-out verified"
    );
}
