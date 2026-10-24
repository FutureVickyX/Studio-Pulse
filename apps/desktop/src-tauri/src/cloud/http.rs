//! The real [`RemoteApi`]: Supabase Auth REST and PostgREST RPCs over blocking `reqwest` with the
//! Windows-native TLS stack (Schannel).
//!
//! Every request carries `apikey: <publishable key>`; authenticated requests add
//! `Authorization: Bearer <user access token>`, so the database evaluates Row Level Security as
//! that user. Error bodies are mapped to [`RemoteError`] variants and are never logged verbatim
//! (they may echo user input).
//!
//! Threading: safe to call from any thread. reqwest's blocking client panics in debug builds when
//! it is built or driven on a thread that runs an async runtime (Tauri runs
//! `#[tauri::command(async)]` bodies on its tokio workers), so such calls are moved to a
//! short-lived plain thread ([`off_async_runtime`]); the caller still waits for the result. On
//! the sync thread and other plain threads the request runs in place.

use std::io::Read;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{HeaderValue, ACCEPT, RETRY_AFTER};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};

use super::api::{
    AuthSession, AuthUser, EntryOutcome, EntryResult, InvitationCreated, RemoteApi, RemoteError,
    RemoteTimeEntry, SignUpOutcome, TimeEntryVisibility, WorkspaceRole, WorkspaceSummary,
};
use super::config::SupabaseConfig;

/// Connect timeout for every request.
pub const CONNECT_TIMEOUT_SECS: u64 = 10;
/// Overall timeout for every request.
pub const REQUEST_TIMEOUT_SECS: u64 = 30;

/// Responses larger than this are cut off (and then fail to parse): nothing legitimate is close.
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
/// Server-provided messages shown to the user are cut to this many characters.
const MAX_MESSAGE_CHARS: usize = 300;

pub struct SupabaseHttp {
    config: SupabaseConfig,
    client: Client,
}

impl SupabaseHttp {
    pub fn new(config: SupabaseConfig) -> Result<Self, RemoteError> {
        Self::with_timeouts(
            config,
            Duration::from_secs(CONNECT_TIMEOUT_SECS),
            Duration::from_secs(REQUEST_TIMEOUT_SECS),
        )
    }

    fn with_timeouts(
        config: SupabaseConfig,
        connect: Duration,
        request: Duration,
    ) -> Result<Self, RemoteError> {
        let client = off_async_runtime(|| {
            Client::builder()
                .tls_backend_native()
                .connect_timeout(connect)
                .timeout(request)
                // Supabase never redirects API calls; following one could hand the apikey or a
                // bearer token to another origin.
                .redirect(reqwest::redirect::Policy::none())
                .user_agent(concat!("StudioPulse/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|_| RemoteError::Network("could not start the HTTPS client".into()))
        })?;
        Ok(Self { config, client })
    }

    /// POST a JSON body; returns the status, `Retry-After` and the (bounded) body. Transport
    /// failures become [`RemoteError::Network`] with a short reason (never the URL or body).
    fn post(&self, path: &str, bearer: Option<&str>, body: &Value) -> Result<Reply, RemoteError> {
        off_async_runtime(|| self.send_in_place(Method::POST, path, bearer, Some(body)))
    }

    /// DELETE without a body (PostgREST filters are in the query string).
    fn delete(&self, path: &str, bearer: &str) -> Result<Reply, RemoteError> {
        off_async_runtime(|| self.send_in_place(Method::DELETE, path, Some(bearer), None))
    }

    fn send_in_place(
        &self,
        method: Method,
        path: &str,
        bearer: Option<&str>,
        body: Option<&Value>,
    ) -> Result<Reply, RemoteError> {
        let mut apikey = HeaderValue::from_str(&self.config.publishable_key)
            .map_err(|_| RemoteError::Network("the app's Supabase key is malformed".into()))?;
        apikey.set_sensitive(true);
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.config.url))
            .header("apikey", apikey)
            .header(ACCEPT, "application/json");
        if let Some(body) = body {
            request = request.json(body);
        }
        if let Some(token) = bearer {
            // Marked sensitive by reqwest (never printed in Debug output).
            request = request.bearer_auth(token);
        }
        let response = request.send().map_err(transport_error)?;
        let status = response.status().as_u16();
        let retry_after_ms = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_retry_after_ms);
        let mut bytes = Vec::new();
        response
            .take(MAX_RESPONSE_BYTES)
            .read_to_end(&mut bytes)
            .map_err(|_| RemoteError::Network("the connection was interrupted".into()))?;
        log::debug!("supabase {} -> HTTP {status}", endpoint_label(path));
        Ok(Reply {
            status,
            retry_after_ms,
            body: bytes,
        })
    }

    fn auth(&self, call: AuthCall, path: &str, body: &Value) -> Result<Reply, RemoteError> {
        let reply = self.post(path, None, body)?;
        if reply.is_success() {
            Ok(reply)
        } else {
            Err(auth_error(call, &reply))
        }
    }

    /// `POST /rest/v1/rpc/<function>` as the user; the parsed JSON result (`Null` when empty).
    fn rpc(&self, function: &str, access_token: &str, args: &Value) -> Result<Value, RemoteError> {
        let reply = self.post(
            &format!("/rest/v1/rpc/{function}"),
            Some(access_token),
            args,
        )?;
        if !reply.is_success() {
            return Err(rest_error(&reply));
        }
        if reply.body.iter().all(u8::is_ascii_whitespace) {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&reply.body).map_err(|_| unexpected_response())
    }
}

/// What came back from one request.
#[derive(Debug, Clone)]
struct Reply {
    status: u16,
    retry_after_ms: Option<u64>,
    body: Vec<u8>,
}

impl Reply {
    fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Which Auth endpoint failed (the same status means different things on each).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthCall {
    Password,
    SignUp,
    Refresh,
}

/// Run blocking reqwest work where reqwest allows it: in place on a plain thread, or on a
/// short-lived plain thread (awaited) when the caller is inside an async runtime context, where
/// reqwest's blocking client panics in debug builds.
fn off_async_runtime<T: Send>(
    work: impl FnOnce() -> Result<T, RemoteError> + Send,
) -> Result<T, RemoteError> {
    if tauri::async_runtime::TokioHandle::try_current().is_err() {
        return work();
    }
    std::thread::scope(|scope| {
        let spawned = std::thread::Builder::new()
            .name("studio-pulse-http".into())
            .spawn_scoped(scope, work);
        match spawned {
            // A panic inside reqwest becomes a transient failure, as elsewhere.
            Ok(handle) => handle
                .join()
                .unwrap_or_else(|_| Err(RemoteError::Network("the request failed".into()))),
            Err(_) => Err(RemoteError::Network("could not start the request".into())),
        }
    })
}

/// For logs only: the endpoint without its query string.
fn endpoint_label(path: &str) -> &str {
    path.split('?').next().unwrap_or(path)
}

fn unexpected_response() -> RemoteError {
    RemoteError::Network("unexpected response from Supabase".into())
}

/// A transport failure, described without the URL (or anything else from the request).
fn transport_error(err: reqwest::Error) -> RemoteError {
    let reason = if err.is_timeout() {
        "the request timed out"
    } else if err.is_connect() {
        "could not connect"
    } else if err.is_redirect() {
        "unexpected redirect"
    } else if err.is_body() || err.is_decode() {
        "the connection was interrupted"
    } else if err.is_builder() {
        "the request could not be built"
    } else {
        "the request failed"
    };
    RemoteError::Network(reason.into())
}

/// `Retry-After` in delta-seconds (HTTP dates are ignored: the caller's backoff applies).
fn parse_retry_after_ms(value: &str) -> Option<u64> {
    value
        .trim()
        .parse::<u64>()
        .ok()
        .map(|s| s.saturating_mul(1_000))
}

/// A server message fit to show: control characters removed, whitespace collapsed, bounded.
fn sanitize_message(message: &str) -> Option<String> {
    let cleaned = message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.is_empty() {
        return None;
    }
    if cleaned.chars().count() > MAX_MESSAGE_CHARS {
        let mut cut: String = cleaned.chars().take(MAX_MESSAGE_CHARS - 1).collect();
        cut.push('…');
        Some(cut)
    } else {
        Some(cleaned)
    }
}

/// The interesting fields of a GoTrue or PostgREST error body.
#[derive(Debug, Default)]
struct ErrorBody {
    /// PostgREST SQLSTATE / `PGRSTnnn`, or GoTrue's numeric HTTP code (as text).
    code: Option<String>,
    /// GoTrue `error_code`, or the OAuth-style `error` (`invalid_grant`).
    error_code: Option<String>,
    /// `message` / `msg` / `error_description`, sanitized.
    message: Option<String>,
}

fn error_body(bytes: &[u8]) -> Option<ErrorBody> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let object = value.as_object()?;
    let text = |key: &str| -> Option<String> {
        match object.get(key)? {
            Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        }
    };
    Some(ErrorBody {
        code: text("code"),
        error_code: text("error_code").or_else(|| text("error")),
        message: text("message")
            .or_else(|| text("msg"))
            .or_else(|| text("error_description"))
            .and_then(|m| sanitize_message(&m)),
    })
}

/// Map a failed Auth response.
fn auth_error(call: AuthCall, reply: &Reply) -> RemoteError {
    let status = reply.status;
    if status == 429 {
        return RemoteError::RateLimited {
            retry_after_ms: reply.retry_after_ms,
        };
    }
    if status >= 500 {
        return RemoteError::Server(status);
    }
    let Some(body) = error_body(&reply.body) else {
        // Not an answer from Supabase Auth (a proxy, a captive portal…): transient, and never a
        // reason to end the session.
        return RemoteError::Server(status);
    };
    if is_api_key_rejection(status, &body) {
        return api_key_rejected();
    }
    let code = body
        .error_code
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mentions = |needle: &str| {
        body.message
            .as_deref()
            .is_some_and(|m| m.to_ascii_lowercase().contains(needle))
    };
    match call {
        AuthCall::Password => match code.as_str() {
            "email_not_confirmed" => return RemoteError::EmailNotConfirmed,
            "invalid_credentials" | "invalid_grant" if mentions("email not confirmed") => {
                return RemoteError::EmailNotConfirmed
            }
            "invalid_credentials" | "invalid_grant" => return RemoteError::InvalidCredentials,
            "user_banned" => {
                return RemoteError::Forbidden("This account has been suspended.".into())
            }
            "validation_failed" | "email_address_invalid" => {
                return RemoteError::Rejected("Enter a valid email address and password.".into())
            }
            _ => {}
        },
        AuthCall::SignUp => match code.as_str() {
            "user_already_exists" | "email_exists" => {
                return RemoteError::Rejected(
                    "An account with this email address already exists. Sign in instead.".into(),
                )
            }
            "weak_password" => {
                return RemoteError::Rejected(
                    body.message
                        .unwrap_or_else(|| "Choose a stronger password.".into()),
                )
            }
            "email_address_invalid" | "validation_failed" => {
                return RemoteError::Rejected("Enter a valid email address.".into())
            }
            "signup_disabled" | "email_provider_disabled" => {
                return RemoteError::Rejected(
                    "New accounts can't be created for this Supabase project.".into(),
                )
            }
            "email_address_not_authorized" => {
                return RemoteError::Rejected("This email address can't be used to sign up.".into())
            }
            "over_email_send_rate_limit" | "over_request_rate_limit" => {
                return RemoteError::RateLimited {
                    retry_after_ms: reply.retry_after_ms,
                }
            }
            _ => {}
        },
        AuthCall::Refresh => {
            // GoTrue answers an unusable refresh token (not found, already used, session
            // expired or revoked) with 400 or 401.
            if status == 400 || status == 401 {
                return RemoteError::Unauthorized;
            }
        }
    }
    match status {
        401 => api_key_rejected(),
        403 => RemoteError::Forbidden(
            body.message
                .unwrap_or_else(|| "Supabase refused the request.".into()),
        ),
        404 => RemoteError::NotFound("Supabase Auth isn't available at this project URL.".into()),
        400..=499 => RemoteError::Rejected(
            body.message
                .unwrap_or_else(|| format!("Supabase rejected the request (HTTP {status}).")),
        ),
        _ => RemoteError::Server(status),
    }
}

/// The API gateway's answer to a missing, revoked or mistyped `apikey` (a build problem, not an
/// expired session: refreshing cannot fix it, and the session must not be ended over it).
fn is_api_key_rejection(status: u16, body: &ErrorBody) -> bool {
    status == 401
        && body.message.as_deref().is_some_and(|m| {
            let m = m.to_ascii_lowercase();
            m.contains("api key") || m.contains("apikey")
        })
}

fn api_key_rejected() -> RemoteError {
    RemoteError::Rejected("Supabase didn't accept this app's API key.".into())
}

/// Map a failed PostgREST response.
///
/// The SQLSTATE in the body decides before the HTTP status: PostgREST answers most `P0xxx`
/// codes (e.g. `P0002`, raised for an invalid invitation) with HTTP 500, which must not be
/// mistaken for a transient server failure.
fn rest_error(reply: &Reply) -> RemoteError {
    let status = reply.status;
    if status == 429 {
        return RemoteError::RateLimited {
            retry_after_ms: reply.retry_after_ms,
        };
    }
    let body = error_body(&reply.body).unwrap_or_default();
    if is_api_key_rejection(status, &body) {
        return api_key_rejected();
    }
    if status == 401 {
        return RemoteError::Unauthorized;
    }
    let code = body
        .code
        .as_deref()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let jwt_problem = matches!(code.as_str(), "PGRST301" | "PGRST302" | "PGRST303")
        || body
            .message
            .as_deref()
            .is_some_and(|m| m.to_ascii_lowercase().contains("jwt expired"));
    if jwt_problem {
        return RemoteError::Unauthorized;
    }
    let message = |fallback: &str| body.message.clone().unwrap_or_else(|| fallback.to_owned());
    match code.as_str() {
        "42501" | "28000" => {
            return RemoteError::Forbidden(message("You don't have access to do that."))
        }
        "P0002" => return RemoteError::NotFound(message("Not found.")),
        "P0001" => return RemoteError::Rejected(message("Supabase rejected the request.")),
        c if c.len() == 5 && (c.starts_with("22") || c.starts_with("23")) => {
            return RemoteError::Rejected(message("Supabase rejected the request."))
        }
        "PGRST202" | "42883" => {
            return RemoteError::NotFound(
                "This Supabase project is missing the Studio Pulse database functions.".into(),
            )
        }
        _ => {}
    }
    match status {
        500..=599 => RemoteError::Server(status),
        403 => RemoteError::Forbidden(message("You don't have access to do that.")),
        404 => RemoteError::NotFound(message("Not found.")),
        400..=499 => RemoteError::Rejected(message(&format!(
            "Supabase rejected the request (HTTP {status})."
        ))),
        _ => RemoteError::Server(status),
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn non_empty_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn as_i64_lenient(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_f64().filter(|f| f.is_finite()).map(|f| f as i64))
}

/// A GoTrue user object.
fn parse_user(value: &Value) -> Option<AuthUser> {
    let id = non_empty_str(value.get("id"))?;
    let email = non_empty_str(value.get("email"));
    let display_name = value
        .get("user_metadata")
        .and_then(|m| non_empty_str(m.get("display_name")));
    Some(AuthUser {
        id,
        email,
        display_name,
    })
}

/// A GoTrue session response. The access token's expiry is computed from `expires_in` against
/// the local clock (robust to clock skew), else from `expires_at`; with neither it is treated as
/// already due for refresh.
fn parse_session(value: &Value, now_ms: i64) -> Result<AuthSession, RemoteError> {
    let access_token = non_empty_str(value.get("access_token")).ok_or_else(unexpected_response)?;
    let refresh_token =
        non_empty_str(value.get("refresh_token")).ok_or_else(unexpected_response)?;
    let user = value
        .get("user")
        .and_then(parse_user)
        .ok_or_else(unexpected_response)?;
    let expires_at_ms = if let Some(secs) = value
        .get("expires_in")
        .and_then(as_i64_lenient)
        .filter(|s| *s > 0)
    {
        now_ms.saturating_add(secs.saturating_mul(1_000))
    } else if let Some(at) = value
        .get("expires_at")
        .and_then(as_i64_lenient)
        .filter(|s| *s > 0)
    {
        at.saturating_mul(1_000)
    } else {
        now_ms
    };
    Ok(AuthSession {
        access_token,
        refresh_token,
        expires_at_ms,
        user,
    })
}

fn parse_json(bytes: &[u8]) -> Result<Value, RemoteError> {
    serde_json::from_slice(bytes).map_err(|_| unexpected_response())
}

/// A single-row RPC result: the object itself, or the first element of an array.
fn single_row(value: Value) -> Option<Value> {
    match value {
        Value::Array(rows) => rows.into_iter().next(),
        other => Some(other),
    }
}

#[derive(Deserialize)]
struct WorkspaceRow {
    workspace_id: String,
    name: String,
    role: WorkspaceRole,
    time_entry_visibility: TimeEntryVisibility,
}

#[derive(Deserialize)]
struct SyncResultRow {
    entry_id: Option<String>,
    status: Option<String>,
    detail: Option<String>,
}

fn parse_sync_results(value: Value) -> Result<Vec<EntryResult>, RemoteError> {
    let rows: Vec<SyncResultRow> = match value {
        Value::Null => Vec::new(),
        other => serde_json::from_value(other).map_err(|_| unexpected_response())?,
    };
    let mut results = Vec::with_capacity(rows.len());
    for row in rows {
        // A row without an id cannot be attributed to an entry; the entry then counts as
        // unconfirmed and stays pending.
        let Some(id) = row.entry_id.filter(|id| !id.trim().is_empty()) else {
            continue;
        };
        let detail = row.detail.as_deref().and_then(sanitize_message);
        let outcome = match row.status.as_deref() {
            Some("synced") => EntryOutcome::Synced,
            Some("rejected") => {
                EntryOutcome::Rejected(detail.unwrap_or_else(|| "rejected by the server".into()))
            }
            other => {
                let status = other
                    .and_then(sanitize_message)
                    .unwrap_or_else(|| "missing".into());
                EntryOutcome::Rejected(match detail {
                    Some(d) => format!("unexpected sync status '{status}': {d}"),
                    None => format!("unexpected sync status '{status}'"),
                })
            }
        };
        results.push(EntryResult { id, outcome });
    }
    Ok(results)
}

impl RemoteApi for SupabaseHttp {
    fn sign_in_with_password(
        &self,
        email: &str,
        password: &str,
    ) -> Result<AuthSession, RemoteError> {
        let reply = self.auth(
            AuthCall::Password,
            "/auth/v1/token?grant_type=password",
            &json!({ "email": email, "password": password }),
        )?;
        parse_session(&parse_json(&reply.body)?, now_ms())
    }

    fn sign_up(
        &self,
        email: &str,
        password: &str,
        display_name: &str,
    ) -> Result<SignUpOutcome, RemoteError> {
        let reply = self.auth(
            AuthCall::SignUp,
            "/auth/v1/signup",
            &json!({
                "email": email,
                "password": password,
                "data": { "display_name": display_name },
            }),
        )?;
        let value = parse_json(&reply.body)?;
        // With email confirmation on, GoTrue answers with the user object and no session.
        if non_empty_str(value.get("access_token")).is_some() {
            Ok(SignUpOutcome::SignedIn(parse_session(&value, now_ms())?))
        } else {
            Ok(SignUpOutcome::ConfirmationRequired)
        }
    }

    fn refresh_session(&self, refresh_token: &str) -> Result<AuthSession, RemoteError> {
        let reply = self.auth(
            AuthCall::Refresh,
            "/auth/v1/token?grant_type=refresh_token",
            &json!({ "refresh_token": refresh_token }),
        )?;
        parse_session(&parse_json(&reply.body)?, now_ms())
    }

    fn sign_out(&self, access_token: &str) -> Result<(), RemoteError> {
        // scope=local revokes this device's session only, not the user's other sign-ins.
        let reply = self.post(
            "/auth/v1/logout?scope=local",
            Some(access_token),
            &json!({}),
        )?;
        match reply.status {
            200..=299 => Ok(()),
            // The session is already gone (expired, revoked or unknown): that is the goal.
            401 | 403 | 404 => Ok(()),
            _ => Err(rest_error(&reply)),
        }
    }

    fn my_workspaces(&self, access_token: &str) -> Result<Vec<WorkspaceSummary>, RemoteError> {
        let value = self.rpc("my_workspaces", access_token, &json!({}))?;
        let rows: Vec<WorkspaceRow> = match value {
            Value::Null => Vec::new(),
            other => serde_json::from_value(other).map_err(|_| unexpected_response())?,
        };
        Ok(rows
            .into_iter()
            .map(|row| WorkspaceSummary {
                id: row.workspace_id,
                name: row.name,
                role: row.role,
                time_entry_visibility: row.time_entry_visibility,
            })
            .collect())
    }

    fn create_workspace(&self, access_token: &str, name: &str) -> Result<String, RemoteError> {
        let value = self.rpc("create_workspace", access_token, &json!({ "p_name": name }))?;
        single_row(value)
            .and_then(|row| non_empty_str(row.get("id")))
            .ok_or_else(unexpected_response)
    }

    fn accept_invitation(&self, access_token: &str, token: &str) -> Result<String, RemoteError> {
        let value = self.rpc(
            "accept_invitation",
            access_token,
            &json!({ "p_token": token }),
        )?;
        match single_row(value) {
            Some(Value::String(id)) if !id.trim().is_empty() => Ok(id.trim().to_owned()),
            Some(Value::Object(row)) => {
                non_empty_str(row.get("accept_invitation")).ok_or_else(unexpected_response)
            }
            _ => Err(unexpected_response()),
        }
    }

    fn create_invitation(
        &self,
        access_token: &str,
        workspace_id: &str,
        email: &str,
        role: WorkspaceRole,
    ) -> Result<InvitationCreated, RemoteError> {
        let value = self.rpc(
            "create_invitation",
            access_token,
            &json!({ "p_workspace_id": workspace_id, "p_email": email, "p_role": role }),
        )?;
        let row = single_row(value).ok_or_else(unexpected_response)?;
        Ok(InvitationCreated {
            invitation_id: non_empty_str(row.get("invitation_id"))
                .ok_or_else(unexpected_response)?,
            token: non_empty_str(row.get("token")).ok_or_else(unexpected_response)?,
            expires_at: non_empty_str(row.get("expires_at")).ok_or_else(unexpected_response)?,
        })
    }

    fn sync_time_entries(
        &self,
        access_token: &str,
        workspace_id: &str,
        entries: &[RemoteTimeEntry],
    ) -> Result<Vec<EntryResult>, RemoteError> {
        let value = self.rpc(
            "sync_time_entries",
            access_token,
            &json!({ "p_workspace_id": workspace_id, "p_entries": entries }),
        )?;
        parse_sync_results(value)
    }

    fn delete_time_entries(&self, access_token: &str, ids: &[String]) -> Result<(), RemoteError> {
        // Only well-formed UUIDs go into the filter (they need no quoting); nothing else can be
        // a server id. Chunks keep the URL far below proxy limits.
        let ids: Vec<String> = ids
            .iter()
            .filter_map(|id| uuid::Uuid::parse_str(id.trim()).ok())
            .map(|id| id.to_string())
            .collect();
        for chunk in ids.chunks(DELETE_CHUNK) {
            let reply = self.delete(
                &format!("/rest/v1/time_entries?id=in.({})", chunk.join(",")),
                access_token,
            )?;
            if !reply.is_success() {
                return Err(rest_error(&reply));
            }
        }
        Ok(())
    }
}

/// Ids per `DELETE` request (about 3.7 kB of query string).
const DELETE_CHUNK: usize = 100;

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(status: u16, body: &str) -> Reply {
        Reply {
            status,
            retry_after_ms: None,
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn retry_after_parses_delta_seconds_only() {
        assert_eq!(parse_retry_after_ms("7"), Some(7_000));
        assert_eq!(parse_retry_after_ms(" 0 "), Some(0));
        assert_eq!(parse_retry_after_ms("Wed, 21 Oct 2026 07:28:00 GMT"), None);
        assert_eq!(parse_retry_after_ms("-3"), None);
    }

    #[test]
    fn sanitize_strips_controls_and_bounds_length() {
        assert_eq!(sanitize_message("  a\n\tb  ").as_deref(), Some("a b"));
        assert_eq!(sanitize_message(" \n "), None);
        let long = "x".repeat(1_000);
        let cut = sanitize_message(&long).unwrap();
        assert_eq!(cut.chars().count(), MAX_MESSAGE_CHARS);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn password_grant_errors() {
        let r = reply(
            400,
            r#"{"code":400,"error_code":"invalid_credentials","msg":"Invalid login credentials"}"#,
        );
        assert_eq!(
            auth_error(AuthCall::Password, &r),
            RemoteError::InvalidCredentials
        );
        let r = reply(
            400,
            r#"{"error":"invalid_grant","error_description":"Invalid login credentials"}"#,
        );
        assert_eq!(
            auth_error(AuthCall::Password, &r),
            RemoteError::InvalidCredentials
        );
        let r = reply(
            400,
            r#"{"code":400,"error_code":"email_not_confirmed","msg":"Email not confirmed"}"#,
        );
        assert_eq!(
            auth_error(AuthCall::Password, &r),
            RemoteError::EmailNotConfirmed
        );
        let r = reply(
            400,
            r#"{"error":"invalid_grant","error_description":"Email not confirmed"}"#,
        );
        assert_eq!(
            auth_error(AuthCall::Password, &r),
            RemoteError::EmailNotConfirmed
        );
    }

    #[test]
    fn refresh_grant_rejections_are_unauthorized() {
        for body in [
            r#"{"code":400,"error_code":"refresh_token_not_found","msg":"Invalid Refresh Token: Refresh Token Not Found"}"#,
            r#"{"code":400,"error_code":"refresh_token_already_used","msg":"Invalid Refresh Token: Already Used"}"#,
            r#"{"error":"invalid_grant","error_description":"Invalid Refresh Token"}"#,
        ] {
            assert_eq!(
                auth_error(AuthCall::Refresh, &reply(400, body)),
                RemoteError::Unauthorized
            );
        }
        assert_eq!(
            auth_error(AuthCall::Refresh, &reply(401, r#"{"message":"Invalid"}"#)),
            RemoteError::Unauthorized
        );
    }

    #[test]
    fn a_rejected_api_key_never_ends_the_session() {
        // The gateway's answer to a bad apikey must not look like a dead refresh token.
        let r = reply(401, r#"{"message":"Invalid API key"}"#);
        let err = auth_error(AuthCall::Refresh, &r);
        assert_eq!(
            err,
            RemoteError::Rejected("Supabase didn't accept this app's API key.".into())
        );
        assert_ne!(err, RemoteError::Unauthorized);
    }

    #[test]
    fn non_json_auth_errors_are_transient_and_never_end_the_session() {
        let r = reply(400, "<html>captive portal</html>");
        assert_eq!(auth_error(AuthCall::Refresh, &r), RemoteError::Server(400));
        assert!(auth_error(AuthCall::Refresh, &r).is_transient());
    }

    #[test]
    fn auth_rate_limit_and_server_errors() {
        let mut r = reply(429, r#"{"error_code":"over_request_rate_limit"}"#);
        r.retry_after_ms = Some(3_000);
        assert_eq!(
            auth_error(AuthCall::Password, &r),
            RemoteError::RateLimited {
                retry_after_ms: Some(3_000)
            }
        );
        assert_eq!(
            auth_error(AuthCall::Refresh, &reply(503, "")),
            RemoteError::Server(503)
        );
    }

    #[test]
    fn sign_up_errors_have_actionable_messages() {
        let r = reply(
            422,
            r#"{"code":422,"error_code":"user_already_exists","msg":"User already registered"}"#,
        );
        assert!(
            matches!(auth_error(AuthCall::SignUp, &r), RemoteError::Rejected(m) if m.contains("already exists"))
        );
        let r = reply(
            422,
            r#"{"code":422,"error_code":"weak_password","msg":"Password should be at least 8 characters."}"#,
        );
        assert_eq!(
            auth_error(AuthCall::SignUp, &r),
            RemoteError::Rejected("Password should be at least 8 characters.".into())
        );
        let r = reply(
            422,
            r#"{"error_code":"signup_disabled","msg":"Signups not allowed"}"#,
        );
        assert!(matches!(
            auth_error(AuthCall::SignUp, &r),
            RemoteError::Rejected(_)
        ));
        let r = reply(429, r#"{"error_code":"over_email_send_rate_limit"}"#);
        assert!(matches!(
            auth_error(AuthCall::SignUp, &r),
            RemoteError::RateLimited { .. }
        ));
    }

    #[test]
    fn rest_error_mapping() {
        let cases: Vec<(u16, &str, RemoteError)> = vec![
            (
                403,
                r#"{"code":"42501","details":null,"hint":null,"message":"not a member of this workspace"}"#,
                RemoteError::Forbidden("not a member of this workspace".into()),
            ),
            (
                403,
                r#"{"code":"28000","message":"sign in to sync time entries"}"#,
                RemoteError::Forbidden("sign in to sync time entries".into()),
            ),
            (
                404,
                r#"{"code":"P0002","message":"this invitation is invalid or has expired"}"#,
                RemoteError::NotFound("this invitation is invalid or has expired".into()),
            ),
            // What PostgREST actually sends for P0002: HTTP 500. Still not transient.
            (
                500,
                r#"{"code":"P0002","details":null,"hint":null,"message":"member not found"}"#,
                RemoteError::NotFound("member not found".into()),
            ),
            (
                401,
                r#"{"message":"Invalid API key","hint":"Double check the provided API key"}"#,
                RemoteError::Rejected("Supabase didn't accept this app's API key.".into()),
            ),
            (
                404,
                r#"{"code":"42883","message":"function public.sync_time_entries(uuid) does not exist"}"#,
                RemoteError::NotFound(
                    "This Supabase project is missing the Studio Pulse database functions.".into(),
                ),
            ),
            (
                500,
                r#"{"code":"XX000","message":"internal"}"#,
                RemoteError::Server(500),
            ),
            (
                503,
                r#"{"code":"57014","message":"canceling statement"}"#,
                RemoteError::Server(503),
            ),
            (
                400,
                r#"{"code":"22023","message":"entries must be a JSON array"}"#,
                RemoteError::Rejected("entries must be a JSON array".into()),
            ),
            (
                400,
                r#"{"code":"23514","message":"new row violates check constraint"}"#,
                RemoteError::Rejected("new row violates check constraint".into()),
            ),
            (
                409,
                r#"{"code":"23505","message":"duplicate key value","details":"Key (id)=(secret) exists"}"#,
                RemoteError::Rejected("duplicate key value".into()),
            ),
            (
                400,
                r#"{"code":"P0001","message":"custom raise"}"#,
                RemoteError::Rejected("custom raise".into()),
            ),
            (
                401,
                r#"{"code":"PGRST301","message":"JWSError"}"#,
                RemoteError::Unauthorized,
            ),
            (401, "", RemoteError::Unauthorized),
            (
                403,
                r#"{"code":"PGRST303","message":"JWT expired"}"#,
                RemoteError::Unauthorized,
            ),
            (
                500,
                r#"{"code":"54000","message":"at most 500"}"#,
                RemoteError::Server(500),
            ),
            (503, "upstream down", RemoteError::Server(503)),
            (
                404,
                r#"{"code":"PGRST202","message":"Could not find the function"}"#,
                RemoteError::NotFound(
                    "This Supabase project is missing the Studio Pulse database functions.".into(),
                ),
            ),
            (
                422,
                "not json",
                RemoteError::Rejected("Supabase rejected the request (HTTP 422).".into()),
            ),
        ];
        for (status, body, expected) in cases {
            assert_eq!(
                rest_error(&reply(status, body)),
                expected,
                "{status} {body}"
            );
        }
        let mut r = reply(429, "");
        r.retry_after_ms = Some(9_000);
        assert_eq!(
            rest_error(&r),
            RemoteError::RateLimited {
                retry_after_ms: Some(9_000)
            }
        );
    }

    #[test]
    fn rest_errors_never_include_details_or_hints() {
        let r = reply(
            409,
            r#"{"code":"23505","message":"duplicate","details":"Key (token)=(abcdef) already exists","hint":"hint-secret"}"#,
        );
        let text = rest_error(&r).to_string();
        assert!(!text.contains("abcdef"));
        assert!(!text.contains("hint-secret"));
    }

    #[test]
    fn session_expiry_prefers_expires_in_against_the_local_clock() {
        let v = json!({
            "access_token": "at", "refresh_token": "rt", "expires_in": 3600,
            "expires_at": 1, "user": { "id": "u1", "email": "a@b.co",
            "user_metadata": { "display_name": " Ada " } }
        });
        let s = parse_session(&v, 1_000_000).unwrap();
        assert_eq!(s.expires_at_ms, 1_000_000 + 3_600_000);
        assert_eq!(s.user.display_name.as_deref(), Some("Ada"));
        assert_eq!(s.user.email.as_deref(), Some("a@b.co"));

        let v = json!({ "access_token": "at", "refresh_token": "rt", "expires_at": 2_000,
            "user": { "id": "u1" } });
        assert_eq!(parse_session(&v, 5).unwrap().expires_at_ms, 2_000_000);

        let v = json!({ "access_token": "at", "refresh_token": "rt", "user": { "id": "u1" } });
        assert_eq!(parse_session(&v, 42).unwrap().expires_at_ms, 42);
    }

    #[test]
    fn session_without_tokens_or_user_is_unexpected() {
        for v in [
            json!({ "refresh_token": "rt", "user": { "id": "u" } }),
            json!({ "access_token": "at", "user": { "id": "u" } }),
            json!({ "access_token": "at", "refresh_token": "rt" }),
            json!({ "access_token": "at", "refresh_token": "rt", "user": { "id": "" } }),
        ] {
            assert!(matches!(parse_session(&v, 0), Err(RemoteError::Network(_))));
        }
    }

    #[test]
    fn sync_results_map_statuses() {
        let v = json!([
            { "entry_id": "a", "status": "synced", "detail": null },
            { "entry_id": "b", "status": "synced", "detail": "already present" },
            { "entry_id": "c", "status": "rejected", "detail": "23514: check violated" },
            { "entry_id": "d", "status": "weird", "detail": "x" },
            { "entry_id": null, "status": "rejected", "detail": "22P02: bad uuid" },
            { "entry_id": "e", "status": "rejected" },
        ]);
        let results = parse_sync_results(v).unwrap();
        assert_eq!(results.len(), 5);
        assert_eq!(results[0].outcome, EntryOutcome::Synced);
        assert_eq!(results[1].outcome, EntryOutcome::Synced);
        assert_eq!(
            results[2].outcome,
            EntryOutcome::Rejected("23514: check violated".into())
        );
        assert_eq!(
            results[3].outcome,
            EntryOutcome::Rejected("unexpected sync status 'weird': x".into())
        );
        assert_eq!(results[4].id, "e");
        assert!(matches!(results[4].outcome, EntryOutcome::Rejected(_)));
        assert!(parse_sync_results(json!({"not": "an array"})).is_err());
        assert!(parse_sync_results(Value::Null).unwrap().is_empty());
    }

    fn local_config(port: u16) -> SupabaseConfig {
        SupabaseConfig::validate(
            &format!("http://127.0.0.1:{port}"),
            "sb_publishable_test_key",
        )
        .unwrap()
    }

    #[test]
    fn a_silent_server_times_out_as_a_network_error() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            // Accept, read nothing back, answer nothing.
            let (_stream, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(1_500));
        });
        let http = SupabaseHttp::with_timeouts(
            local_config(port),
            Duration::from_millis(500),
            Duration::from_millis(300),
        )
        .unwrap();
        let err = http.my_workspaces("access-token").unwrap_err();
        assert_eq!(err, RemoteError::Network("the request timed out".into()));
        assert!(err.is_transient());
        server.join().unwrap();
    }

    #[test]
    fn a_refused_connection_is_a_network_error_without_the_url() {
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let http = SupabaseHttp::new(local_config(port)).unwrap();
        let err = http
            .sign_in_with_password("a@b.co", "hunter22")
            .unwrap_err();
        assert!(matches!(err, RemoteError::Network(_)), "{err:?}");
        let text = err.to_string();
        assert!(!text.contains("127.0.0.1"));
        assert!(!text.contains("hunter22"));
    }
}
