//! `SupabaseHttp` against a local stub server (std `TcpListener` on 127.0.0.1, canned responses):
//! endpoints, headers, JSON argument names, response parsing and error mapping. No real network.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{json, Value};
use studio_pulse_lib::cloud::api::{
    EntryOutcome, RemoteApi, RemoteError, RemoteTimeEntry, SignUpOutcome, TimeEntryVisibility,
    WorkspaceRole,
};
use studio_pulse_lib::cloud::config::SupabaseConfig;
use studio_pulse_lib::cloud::http::SupabaseHttp;

const KEY: &str = "sb_publishable_stub_key_123";
const ACCESS: &str = "eyJ-stub-access-token";
const PASSWORD: &str = "hunter2-correct-horse";

/// One canned HTTP response.
#[derive(Clone)]
struct Canned {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: String,
}

fn reply(status: u16, body: Value) -> Canned {
    Canned {
        status,
        headers: Vec::new(),
        body: body.to_string(),
    }
}

fn raw(status: u16, body: &str) -> Canned {
    Canned {
        status,
        headers: Vec::new(),
        body: body.into(),
    }
}

/// What the stub received.
#[derive(Debug, Clone)]
struct Recorded {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    body: String,
}

impl Recorded {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).expect("request body is JSON")
    }
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

struct Stub {
    url: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
    thread: Option<JoinHandle<()>>,
}

impl Stub {
    /// Serve `responses` in order, one connection each.
    fn serve(responses: Vec<Canned>) -> Stub {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&requests);
        let thread = std::thread::spawn(move || {
            for canned in responses {
                let (stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream);
                let recorded = read_request(&mut reader);
                log.lock().unwrap().push(recorded);
                write_response(reader.get_mut(), &canned);
            }
        });
        Stub {
            url,
            requests,
            thread: Some(thread),
        }
    }

    fn http(&self) -> SupabaseHttp {
        SupabaseHttp::new(SupabaseConfig::validate(&self.url, KEY).unwrap()).unwrap()
    }

    /// Wait for the stub to have served everything, then return what it received.
    fn finish(mut self) -> Vec<Recorded> {
        self.thread.take().unwrap().join().unwrap();
        self.requests.lock().unwrap().clone()
    }

    fn single(self) -> Recorded {
        let mut all = self.finish();
        assert_eq!(all.len(), 1);
        all.remove(0)
    }
}

fn read_request(reader: &mut BufReader<std::net::TcpStream>) -> Recorded {
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap().to_owned();
    let target = parts.next().unwrap().to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).unwrap();
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':').unwrap();
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
    }
    let length: usize = headers
        .get("content-length")
        .map_or(0, |v| v.parse().unwrap());
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    Recorded {
        method,
        target,
        headers,
        body: String::from_utf8(body).unwrap(),
    }
}

fn write_response(stream: &mut std::net::TcpStream, canned: &Canned) {
    let mut head = format!("HTTP/1.1 {} Stub\r\nConnection: close\r\n", canned.status);
    for (name, value) in &canned.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if canned.status == 204 {
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).unwrap();
    } else {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            canned.body.len()
        ));
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(canned.body.as_bytes()).unwrap();
    }
    stream.flush().unwrap();
}

fn session_json() -> Value {
    json!({
        "access_token": ACCESS,
        "token_type": "bearer",
        "expires_in": 3600,
        "expires_at": 1_791_886_500,
        "refresh_token": "stub-refresh-1",
        "user": {
            "id": "0190a7f0-0000-7000-8000-000000000001",
            "email": "ada@example.com",
            "user_metadata": { "display_name": "Ada" }
        }
    })
}

fn assert_public_request(request: &Recorded) {
    assert_eq!(request.method, "POST");
    assert_eq!(request.header("apikey"), Some(KEY));
    assert_eq!(
        request.header("authorization"),
        None,
        "no bearer on auth calls"
    );
    assert_eq!(request.header("content-type"), Some("application/json"));
}

fn assert_user_request(request: &Recorded, path: &str) {
    assert_eq!(request.method, "POST");
    assert_eq!(request.target, path);
    assert_eq!(request.header("apikey"), Some(KEY));
    assert_eq!(
        request.header("authorization").map(str::to_owned),
        Some(format!("Bearer {ACCESS}"))
    );
    assert_eq!(request.header("content-type"), Some("application/json"));
}

fn sample_entry(id: &str) -> RemoteTimeEntry {
    RemoteTimeEntry {
        id: id.into(),
        device_id: "0190a7f0-0000-7000-8000-0000000000d1".into(),
        application_id: "figma".into(),
        application_name: "Figma".into(),
        kind: "active".into(),
        started_at: "2026-10-13T09:15:00.000Z".into(),
        ended_at: "2026-10-13T09:16:00.000Z".into(),
        active_ms: 60_000,
        idle_ms: 0,
        end_reason: "appSwitch".into(),
        project_id: None,
        task_id: None,
        revision: 1,
        recorded_at: "2026-10-13T09:16:00.005Z".into(),
    }
}

// ---- Auth -----------------------------------------------------------------------------------

#[test]
fn sign_in_posts_the_password_grant_and_parses_the_session() {
    let stub = Stub::serve(vec![reply(200, session_json())]);
    let before = chrono::Utc::now().timestamp_millis();
    let session = stub
        .http()
        .sign_in_with_password("ada@example.com", PASSWORD)
        .unwrap();
    let after = chrono::Utc::now().timestamp_millis();

    assert_eq!(session.access_token, ACCESS);
    assert_eq!(session.refresh_token, "stub-refresh-1");
    assert_eq!(session.user.id, "0190a7f0-0000-7000-8000-000000000001");
    assert_eq!(session.user.email.as_deref(), Some("ada@example.com"));
    assert_eq!(session.user.display_name.as_deref(), Some("Ada"));
    assert!(session.expires_at_ms >= before + 3_600_000);
    assert!(session.expires_at_ms <= after + 3_600_000);
    assert!(!format!("{session:?}").contains(ACCESS));

    let request = stub.single();
    assert_public_request(&request);
    assert_eq!(request.target, "/auth/v1/token?grant_type=password");
    assert_eq!(
        request.json(),
        json!({ "email": "ada@example.com", "password": PASSWORD })
    );
}

#[test]
fn sign_in_failures_map_to_account_errors() {
    let cases = [
        (
            raw(
                400,
                r#"{"code":400,"error_code":"invalid_credentials","msg":"Invalid login credentials"}"#,
            ),
            RemoteError::InvalidCredentials,
        ),
        (
            raw(
                400,
                r#"{"error":"invalid_grant","error_description":"Invalid login credentials"}"#,
            ),
            RemoteError::InvalidCredentials,
        ),
        (
            raw(
                400,
                r#"{"code":400,"error_code":"email_not_confirmed","msg":"Email not confirmed"}"#,
            ),
            RemoteError::EmailNotConfirmed,
        ),
        (
            Canned {
                status: 429,
                headers: vec![("Retry-After", "12".into())],
                body: r#"{"error_code":"over_request_rate_limit"}"#.into(),
            },
            RemoteError::RateLimited {
                retry_after_ms: Some(12_000),
            },
        ),
        (
            raw(502, "<html>bad gateway</html>"),
            RemoteError::Server(502),
        ),
    ];
    for (canned, expected) in cases {
        let stub = Stub::serve(vec![canned]);
        let err = stub
            .http()
            .sign_in_with_password("ada@example.com", PASSWORD)
            .unwrap_err();
        assert_eq!(err, expected);
        assert!(!err.to_string().contains(PASSWORD));
        stub.finish();
    }
}

#[test]
fn sign_up_sends_the_display_name_and_detects_confirmation() {
    // Email confirmation on: GoTrue answers with the user only.
    let stub = Stub::serve(vec![reply(
        200,
        json!({ "id": "0190a7f0-0000-7000-8000-000000000002", "email": "bo@example.com",
                "confirmation_sent_at": "2026-10-17T10:00:00Z" }),
    )]);
    let outcome = stub
        .http()
        .sign_up("bo@example.com", PASSWORD, "Bo")
        .unwrap();
    assert_eq!(outcome, SignUpOutcome::ConfirmationRequired);
    let request = stub.single();
    assert_public_request(&request);
    assert_eq!(request.target, "/auth/v1/signup");
    assert_eq!(
        request.json(),
        json!({ "email": "bo@example.com", "password": PASSWORD,
                "data": { "display_name": "Bo" } })
    );

    // Confirmation off: a session comes back.
    let stub = Stub::serve(vec![reply(200, session_json())]);
    let outcome = stub
        .http()
        .sign_up("ada@example.com", PASSWORD, "Ada")
        .unwrap();
    assert!(matches!(outcome, SignUpOutcome::SignedIn(s) if s.access_token == ACCESS));
    stub.finish();

    // Already registered.
    let stub = Stub::serve(vec![raw(
        422,
        r#"{"code":422,"error_code":"user_already_exists","msg":"User already registered"}"#,
    )]);
    let err = stub
        .http()
        .sign_up("ada@example.com", PASSWORD, "Ada")
        .unwrap_err();
    assert!(matches!(err, RemoteError::Rejected(m) if m.contains("already exists")));
    stub.finish();
}

#[test]
fn refresh_posts_the_refresh_token_and_maps_rejection_to_unauthorized() {
    let stub = Stub::serve(vec![reply(200, session_json())]);
    let session = stub.http().refresh_session("stub-refresh-0").unwrap();
    assert_eq!(session.refresh_token, "stub-refresh-1");
    let request = stub.single();
    assert_public_request(&request);
    assert_eq!(request.target, "/auth/v1/token?grant_type=refresh_token");
    assert_eq!(request.json(), json!({ "refresh_token": "stub-refresh-0" }));

    for canned in [
        raw(
            400,
            r#"{"code":400,"error_code":"refresh_token_not_found","msg":"Invalid Refresh Token: Refresh Token Not Found"}"#,
        ),
        raw(
            400,
            r#"{"code":400,"error_code":"refresh_token_already_used","msg":"Invalid Refresh Token: Already Used"}"#,
        ),
        raw(401, r#"{"code":401,"msg":"session expired"}"#),
    ] {
        let stub = Stub::serve(vec![canned]);
        assert_eq!(
            stub.http().refresh_session("dead").unwrap_err(),
            RemoteError::Unauthorized
        );
        stub.finish();
    }

    // A gateway rejecting the app's key is not an expired session.
    let stub = Stub::serve(vec![raw(401, r#"{"message":"Invalid API key"}"#)]);
    let err = stub.http().refresh_session("still-good").unwrap_err();
    assert!(matches!(err, RemoteError::Rejected(_)), "{err:?}");
    stub.finish();
}

#[test]
fn logout_sends_the_bearer_and_accepts_an_already_ended_session() {
    for status in [204, 401, 403, 404] {
        let stub = Stub::serve(vec![raw(status, "{}")]);
        stub.http().sign_out(ACCESS).unwrap();
        let request = stub.single();
        assert_user_request(&request, "/auth/v1/logout?scope=local");
    }
    let stub = Stub::serve(vec![raw(500, "{}")]);
    assert_eq!(
        stub.http().sign_out(ACCESS).unwrap_err(),
        RemoteError::Server(500)
    );
    stub.finish();
}

// ---- RPCs -----------------------------------------------------------------------------------

#[test]
fn my_workspaces_calls_the_rpc_as_the_user_and_parses_rows() {
    let stub = Stub::serve(vec![reply(
        200,
        json!([
            { "workspace_id": "0190a7f0-0000-7000-8000-00000000aaaa", "name": "Studio A",
              "role": "owner", "time_entry_visibility": "private",
              "joined_at": "2026-10-01T08:00:00+00:00" },
            { "workspace_id": "0190a7f0-0000-7000-8000-00000000bbbb", "name": "Studio B",
              "role": "member", "time_entry_visibility": "admins",
              "joined_at": "2026-10-02T08:00:00+00:00" }
        ]),
    )]);
    let workspaces = stub.http().my_workspaces(ACCESS).unwrap();
    assert_eq!(workspaces.len(), 2);
    assert_eq!(workspaces[0].id, "0190a7f0-0000-7000-8000-00000000aaaa");
    assert_eq!(workspaces[0].role, WorkspaceRole::Owner);
    assert_eq!(workspaces[1].name, "Studio B");
    assert_eq!(workspaces[1].role, WorkspaceRole::Member);
    assert_eq!(
        workspaces[1].time_entry_visibility,
        TimeEntryVisibility::Admins
    );
    let request = stub.single();
    assert_user_request(&request, "/rest/v1/rpc/my_workspaces");
    assert_eq!(request.json(), json!({}));
}

#[test]
fn create_workspace_sends_p_name_and_takes_the_row_id() {
    let stub = Stub::serve(vec![reply(
        200,
        json!({ "id": "0190a7f0-0000-7000-8000-00000000cccc", "name": "Night Studio",
                "time_entry_visibility": "private", "created_by": "u",
                "created_at": "2026-10-17T10:00:00+00:00", "updated_at": "2026-10-17T10:00:00+00:00" }),
    )]);
    let id = stub
        .http()
        .create_workspace(ACCESS, "Night Studio")
        .unwrap();
    assert_eq!(id, "0190a7f0-0000-7000-8000-00000000cccc");
    let request = stub.single();
    assert_user_request(&request, "/rest/v1/rpc/create_workspace");
    assert_eq!(request.json(), json!({ "p_name": "Night Studio" }));
}

#[test]
fn accept_invitation_sends_p_token_and_reads_the_scalar_result() {
    let token = "ab".repeat(32);
    let stub = Stub::serve(vec![reply(
        200,
        json!("0190a7f0-0000-7000-8000-00000000bbbb"),
    )]);
    let id = stub.http().accept_invitation(ACCESS, &token).unwrap();
    assert_eq!(id, "0190a7f0-0000-7000-8000-00000000bbbb");
    let request = stub.single();
    assert_user_request(&request, "/rest/v1/rpc/accept_invitation");
    assert_eq!(request.json(), json!({ "p_token": token }));

    // PostgREST answers P0002 with HTTP 500; it is still "not found", not a server failure.
    let stub = Stub::serve(vec![raw(
        500,
        r#"{"code":"P0002","details":null,"hint":null,"message":"this invitation is invalid or has expired"}"#,
    )]);
    assert_eq!(
        stub.http().accept_invitation(ACCESS, &token).unwrap_err(),
        RemoteError::NotFound("this invitation is invalid or has expired".into())
    );
    stub.finish();

    let stub = Stub::serve(vec![raw(
        403,
        r#"{"code":"42501","details":null,"hint":null,"message":"this invitation was sent to a different email address"}"#,
    )]);
    assert_eq!(
        stub.http().accept_invitation(ACCESS, &token).unwrap_err(),
        RemoteError::Forbidden("this invitation was sent to a different email address".into())
    );
    stub.finish();
}

#[test]
fn create_invitation_sends_named_arguments_and_reads_the_one_time_token() {
    let token = "cd".repeat(32);
    let stub = Stub::serve(vec![reply(
        200,
        json!([{ "invitation_id": "0190a7f0-0000-7000-8000-00000000dddd", "token": token,
                 "expires_at": "2026-10-24T10:00:00+00:00" }]),
    )]);
    let invitation = stub
        .http()
        .create_invitation(
            ACCESS,
            "0190a7f0-0000-7000-8000-00000000aaaa",
            "bo@example.com",
            WorkspaceRole::Admin,
        )
        .unwrap();
    assert_eq!(
        invitation.invitation_id,
        "0190a7f0-0000-7000-8000-00000000dddd"
    );
    assert_eq!(invitation.token, token);
    assert_eq!(invitation.expires_at, "2026-10-24T10:00:00+00:00");
    assert!(!format!("{invitation:?}").contains(&token));
    let request = stub.single();
    assert_user_request(&request, "/rest/v1/rpc/create_invitation");
    assert_eq!(
        request.json(),
        json!({ "p_workspace_id": "0190a7f0-0000-7000-8000-00000000aaaa",
                "p_email": "bo@example.com", "p_role": "admin" })
    );
}

#[test]
fn sync_time_entries_sends_camel_case_entries_and_maps_each_result() {
    let ids = ["a1", "b2", "c3", "d4"];
    let stub = Stub::serve(vec![reply(
        200,
        json!([
            { "entry_id": "a1", "status": "synced", "detail": null },
            { "entry_id": "b2", "status": "synced", "detail": "already present" },
            { "entry_id": "c3", "status": "rejected",
              "detail": "23514: new row for relation \"time_entries\" violates check constraint" },
            { "entry_id": "d4", "status": "postponed", "detail": "x" }
        ]),
    )]);
    let entries: Vec<RemoteTimeEntry> = ids.iter().map(|id| sample_entry(id)).collect();
    let results = stub
        .http()
        .sync_time_entries(ACCESS, "0190a7f0-0000-7000-8000-00000000aaaa", &entries)
        .unwrap();
    assert_eq!(results.len(), 4);
    assert_eq!(results[0].outcome, EntryOutcome::Synced);
    assert_eq!(results[1].outcome, EntryOutcome::Synced);
    assert!(matches!(&results[2].outcome, EntryOutcome::Rejected(d) if d.starts_with("23514")));
    assert!(
        matches!(&results[3].outcome, EntryOutcome::Rejected(d) if d.contains("postponed")),
        "an unknown status is never treated as synced"
    );

    let request = stub.single();
    assert_user_request(&request, "/rest/v1/rpc/sync_time_entries");
    let body = request.json();
    assert_eq!(
        body["p_workspace_id"],
        "0190a7f0-0000-7000-8000-00000000aaaa"
    );
    let sent = body["p_entries"].as_array().unwrap();
    assert_eq!(sent.len(), 4);
    assert_eq!(
        sent[0],
        json!({
            "id": "a1", "deviceId": "0190a7f0-0000-7000-8000-0000000000d1",
            "applicationId": "figma", "applicationName": "Figma", "kind": "active",
            "startedAt": "2026-10-13T09:15:00.000Z", "endedAt": "2026-10-13T09:16:00.000Z",
            "activeMs": 60_000, "idleMs": 0, "endReason": "appSwitch",
            "projectId": null, "taskId": null, "revision": 1,
            "recordedAt": "2026-10-13T09:16:00.005Z"
        })
    );
}

#[test]
fn whole_call_failures_map_from_postgrest_errors() {
    let entries = [sample_entry("a1")];
    let cases = [
        (
            raw(
                403,
                r#"{"code":"42501","details":null,"hint":null,"message":"not a member of this workspace"}"#,
            ),
            RemoteError::Forbidden("not a member of this workspace".into()),
        ),
        (
            raw(
                403,
                r#"{"code":"28000","message":"sign in to sync time entries"}"#,
            ),
            RemoteError::Forbidden("sign in to sync time entries".into()),
        ),
        (
            raw(
                400,
                r#"{"code":"22023","message":"entries must be a JSON array"}"#,
            ),
            RemoteError::Rejected("entries must be a JSON array".into()),
        ),
        (
            raw(
                401,
                r#"{"code":"PGRST301","message":"JWSError JWSInvalidSignature"}"#,
            ),
            RemoteError::Unauthorized,
        ),
        (
            raw(401, r#"{"code":"PGRST303","message":"JWT expired"}"#),
            RemoteError::Unauthorized,
        ),
        (
            Canned {
                status: 429,
                headers: vec![("Retry-After", "7".into())],
                body: String::new(),
            },
            RemoteError::RateLimited {
                retry_after_ms: Some(7_000),
            },
        ),
        (raw(503, "upstream connect error"), RemoteError::Server(503)),
        (
            raw(
                500,
                r#"{"code":"40001","message":"could not serialize access"}"#,
            ),
            RemoteError::Server(500),
        ),
    ];
    for (canned, expected) in cases {
        let stub = Stub::serve(vec![canned]);
        let err = stub
            .http()
            .sync_time_entries(ACCESS, "ws", &entries)
            .unwrap_err();
        assert_eq!(err, expected);
        assert!(!err.to_string().contains(ACCESS));
        stub.finish();
    }
}

#[test]
fn an_unparseable_success_is_not_a_confirmation() {
    let entries = [sample_entry("a1")];
    for body in ["<html>captive portal</html>", r#"{"not":"a list"}"#] {
        let stub = Stub::serve(vec![raw(200, body)]);
        let err = stub
            .http()
            .sync_time_entries(ACCESS, "ws", &entries)
            .unwrap_err();
        assert!(matches!(err, RemoteError::Network(_)), "{err:?}");
        assert!(err.is_transient());
        stub.finish();
    }
}

#[test]
fn redirects_are_not_followed() {
    // A redirect could carry the apikey and bearer token to another origin.
    let stub = Stub::serve(vec![Canned {
        status: 302,
        headers: vec![("Location", "http://127.0.0.1:9/elsewhere".into())],
        body: String::new(),
    }]);
    let err = stub.http().my_workspaces(ACCESS).unwrap_err();
    assert!(matches!(err, RemoteError::Server(302)), "{err:?}");
    assert_eq!(stub.finish().len(), 1);
}

/// Tauri runs `#[tauri::command(async)]` bodies on its tokio workers. reqwest's blocking client
/// panics in debug builds when it is built or driven there, so `SupabaseHttp` must move that
/// work off the runtime thread itself.
#[test]
fn building_and_calling_on_an_async_runtime_worker_works() {
    let stub = Stub::serve(vec![reply(
        200,
        json!([{ "workspace_id": "0190a7f0-0000-7000-8000-00000000aaaa", "name": "Studio A",
                 "role": "owner", "time_entry_visibility": "private",
                 "joined_at": "2026-10-01T08:00:00+00:00" }]),
    )]);
    let url = stub.url.clone();
    let task = tauri::async_runtime::spawn(async move {
        let http = SupabaseHttp::new(SupabaseConfig::validate(&url, KEY).unwrap()).unwrap();
        http.my_workspaces(ACCESS)
    });
    let result = tauri::async_runtime::block_on(task)
        .expect("the request panicked on the async runtime worker");
    let workspaces = result.unwrap();
    assert_eq!(workspaces.len(), 1);
    assert_eq!(workspaces[0].name, "Studio A");
    assert_user_request(&stub.single(), "/rest/v1/rpc/my_workspaces");
}

#[test]
fn an_unreachable_server_is_a_network_error_without_details() {
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let http = SupabaseHttp::new(
        SupabaseConfig::validate(&format!("http://127.0.0.1:{port}"), KEY).unwrap(),
    )
    .unwrap();
    let err = http
        .sign_in_with_password("ada@example.com", PASSWORD)
        .unwrap_err();
    assert!(matches!(err, RemoteError::Network(_)), "{err:?}");
    assert!(err.is_transient());
    let text = err.to_string();
    for secret in [PASSWORD, KEY, "127.0.0.1", "ada@example.com"] {
        assert!(!text.contains(secret), "{text}");
    }
}
