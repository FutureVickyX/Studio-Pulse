//! Live end-to-end check of the sync contract against a real Supabase project (ignored by
//! default). It signs in with a test account, uploads three synthetic intervals to a workspace
//! the account belongs to, sends the same batch again (a retry after a lost response), checks
//! that every entry is confirmed both times and that exactly one row per id is visible, then
//! deletes the synthetic rows and signs out.
//!
//! Environment (all required; the test skips with a message when one is missing):
//! - `STUDIO_PULSE_SUPABASE_URL`, `STUDIO_PULSE_SUPABASE_PUBLISHABLE_KEY` (public values)
//! - `SP_LIVE_EMAIL`, `SP_LIVE_PASSWORD` (a dedicated test account)
//! - `SP_LIVE_WORKSPACE_ID` (a workspace that account is an active member of)
//!
//! Run: `cargo test --test supabase_live -- --ignored --nocapture`
//!
//! Nothing secret is printed: tokens stay in memory, errors carry only safe messages.

use std::time::Duration;

use chrono::{SecondsFormat, TimeZone, Utc};
use studio_pulse_lib::cloud::api::{EntryOutcome, EntryResult, RemoteApi, RemoteTimeEntry};
use studio_pulse_lib::cloud::config::SupabaseConfig;
use studio_pulse_lib::cloud::http::SupabaseHttp;

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

/// Remove the synthetic rows again (the owner may delete their own entries).
fn delete_rows(config: &SupabaseConfig, access_token: &str, entries: &[RemoteTimeEntry]) {
    let result = rest_client()
        .delete(time_entries_url(config, &[("id", id_filter(entries))]))
        .header("apikey", &config.publishable_key)
        .bearer_auth(access_token)
        .send();
    match result {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => eprintln!(
            "cleanup: deleting the synthetic rows returned HTTP {}",
            response.status()
        ),
        Err(_) => eprintln!("cleanup: could not delete the synthetic rows"),
    }
}

#[test]
#[ignore = "talks to a real Supabase project; see the module docs for the environment"]
fn live_sync_is_idempotent_and_never_duplicates() {
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
        return;
    }
    let [url, key, email, password, workspace_id]: [String; 5] = values
        .into_iter()
        .map(Option::unwrap)
        .collect::<Vec<_>>()
        .try_into()
        .unwrap();

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

    delete_rows(&config, &session.access_token, &entries);
    if http.sign_out(&session.access_token).is_err() {
        eprintln!("cleanup: sign-out did not complete; the test session lapses on its own");
    }
    eprintln!("live Supabase sync: 3 entries uploaded, retried idempotently, cleaned up");
}
