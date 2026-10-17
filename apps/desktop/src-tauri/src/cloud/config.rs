//! Supabase project configuration for the desktop app.
//!
//! Only two **public** values are needed: the project URL and the publishable (or legacy
//! "anon") key. They are compiled in from `STUDIO_PULSE_SUPABASE_URL` and
//! `STUDIO_PULSE_SUPABASE_PUBLISHABLE_KEY` (build.rs refuses to embed a secret key). Debug
//! builds may override both at runtime with the same environment variables.
//!
//! A secret / service-role key is rejected everywhere: it bypasses Row Level Security and must
//! never ship in a client.

use base64::Engine as _;

/// Environment variable holding the project URL (build time; debug builds also at runtime).
pub const URL_ENV: &str = "STUDIO_PULSE_SUPABASE_URL";
/// Environment variable holding the publishable key (build time; debug builds also at runtime).
pub const KEY_ENV: &str = "STUDIO_PULSE_SUPABASE_PUBLISHABLE_KEY";

/// `option_env!` needs string literals; these must equal [`URL_ENV`] / [`KEY_ENV`] (a unit test
/// pins it).
const COMPILED_URL: Option<&str> = option_env!("STUDIO_PULSE_SUPABASE_URL");
const COMPILED_KEY: Option<&str> = option_env!("STUDIO_PULSE_SUPABASE_PUBLISHABLE_KEY");

const PUBLISHABLE_PREFIX: &str = "sb_publishable_";
const SECRET_PREFIX: &str = "sb_secret_";
/// Project name used for a local Supabase stack (`http://127.0.0.1:54321`).
const LOCAL_PROJECT_REF: &str = "local";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupabaseConfig {
    /// `https://<ref>.supabase.co`, or `http://127.0.0.1:<port>` / `http://localhost:<port>` for a
    /// local stack. No trailing slash.
    pub url: String,
    /// Publishable (`sb_publishable_…`) or legacy anon JWT.
    pub publishable_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("Sync isn't configured in this build of Studio Pulse.")]
    Missing,
    #[error("The Supabase project URL in this build is invalid ({0}).")]
    InvalidUrl(String),
    #[error("The Supabase key in this build is missing or malformed.")]
    InvalidKey,
    #[error(
        "This build was given a secret (service-role) key. Desktop builds accept only the \
         publishable key."
    )]
    SecretKey,
}

/// What kind of key a string is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    /// `sb_publishable_…` or a JWT whose `role` claim is `anon`.
    Publishable,
    /// `sb_secret_…` or a JWT whose `role` claim is `service_role`.
    Secret,
    /// Anything else.
    Unknown,
}

/// Classify a Supabase API key without any network access (JWT payloads are decoded, not
/// verified: this is a guard against shipping the wrong key, not authentication).
pub fn classify_key(key: &str) -> KeyKind {
    let key = key.trim();
    // Case-insensitive on purpose: anything that even looks like a secret key is refused.
    let lower = key.to_ascii_lowercase();
    if lower.starts_with(SECRET_PREFIX) {
        return KeyKind::Secret;
    }
    if let Some(rest) = key.strip_prefix(PUBLISHABLE_PREFIX) {
        let well_formed = !rest.is_empty()
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        return if well_formed {
            KeyKind::Publishable
        } else {
            KeyKind::Unknown
        };
    }
    match jwt_role(key).as_deref() {
        Some("anon") => KeyKind::Publishable,
        Some("service_role") => KeyKind::Secret,
        _ => KeyKind::Unknown,
    }
}

/// The `role` claim of a JWT-shaped string (`header.payload.signature`), if it has one.
fn jwt_role(token: &str) -> Option<String> {
    let mut parts = token.split('.');
    let (header, payload, signature) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || header.is_empty() || payload.is_empty() || signature.is_empty() {
        return None;
    }
    // base64url without padding per RFC 7519; tolerate stray padding.
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    claims.get("role")?.as_str().map(str::to_owned)
}

/// Validate a project URL: `https://<host>[:port]` (any host) or
/// `http://127.0.0.1|localhost[:port]`; no credentials, path, query or fragment. Returns the
/// normalised origin (lower-case host, default port dropped, no trailing slash).
fn normalise_url(raw: &str) -> Result<String, ConfigError> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(ConfigError::InvalidUrl("it is empty".into()));
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(ConfigError::InvalidUrl("it contains spaces".into()));
    }
    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|_| ConfigError::InvalidUrl("it is not a valid URL".into()))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ConfigError::InvalidUrl(
            "it must not contain credentials".into(),
        ));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(ConfigError::InvalidUrl(
            "it must not contain a query or fragment".into(),
        ));
    }
    if parsed.path() != "/" {
        return Err(ConfigError::InvalidUrl(
            "it must be the project origin, without a path".into(),
        ));
    }
    // The URL parser lower-cases domains and renders IP literals canonically ("[::1]").
    let host = match parsed.host_str() {
        Some(host) if !host.is_empty() => host.to_owned(),
        _ => return Err(ConfigError::InvalidUrl("it has no host".into())),
    };
    match parsed.scheme() {
        "https" => {}
        "http" => {
            if host != "localhost" && host != "127.0.0.1" {
                return Err(ConfigError::InvalidUrl(
                    "plain http is allowed only for 127.0.0.1 or localhost".into(),
                ));
            }
        }
        _ => {
            return Err(ConfigError::InvalidUrl(
                "it must start with https://".into(),
            ))
        }
    }
    Ok(match parsed.port() {
        Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    })
}

impl SupabaseConfig {
    /// Validate and normalise (trim, strip trailing `/`). Secret keys → [`ConfigError::SecretKey`].
    pub fn validate(url: &str, key: &str) -> Result<SupabaseConfig, ConfigError> {
        let key = key.trim();
        // A secret key is the most serious mistake: report it whatever else is wrong.
        let kind = classify_key(key);
        if kind == KeyKind::Secret {
            return Err(ConfigError::SecretKey);
        }
        let url = normalise_url(url)?;
        if kind != KeyKind::Publishable {
            return Err(ConfigError::InvalidKey);
        }
        Ok(SupabaseConfig {
            url,
            publishable_key: key.to_owned(),
        })
    }

    /// Short stable name for this project (the first host label, e.g. the project ref), used to
    /// name the stored credential.
    pub fn project_ref(&self) -> String {
        let after_scheme = self
            .url
            .split_once("://")
            .map_or(self.url.as_str(), |(_, rest)| rest);
        let host = if let Some(bracketed) = after_scheme.strip_prefix('[') {
            // IPv6 literal: not a project ref.
            bracketed.split(']').next().unwrap_or_default()
        } else {
            after_scheme.split(':').next().unwrap_or_default()
        };
        let host = host.to_ascii_lowercase();
        if host == "localhost" || host == "127.0.0.1" || host.parse::<std::net::IpAddr>().is_ok() {
            return LOCAL_PROJECT_REF.to_owned();
        }
        match host.split('.').next() {
            Some(label) if !label.is_empty() => label.to_owned(),
            _ => LOCAL_PROJECT_REF.to_owned(),
        }
    }
}

/// Pick the effective values: compiled-in ones, overridden by non-empty runtime ones when
/// `allow_override` (debug builds). Both empty → [`ConfigError::Missing`].
fn resolve(
    compiled_url: Option<&str>,
    compiled_key: Option<&str>,
    runtime: impl Fn(&str) -> Option<String>,
    allow_override: bool,
) -> Result<SupabaseConfig, ConfigError> {
    let pick = |compiled: Option<&str>, name: &str| -> String {
        if allow_override {
            if let Some(value) = runtime(name).filter(|v| !v.trim().is_empty()) {
                return value;
            }
        }
        compiled.unwrap_or_default().to_owned()
    };
    let url = pick(compiled_url, URL_ENV);
    let key = pick(compiled_key, KEY_ENV);
    if url.trim().is_empty() && key.trim().is_empty() {
        return Err(ConfigError::Missing);
    }
    SupabaseConfig::validate(&url, &key)
}

/// The configuration compiled into this build (`option_env!`), overridden at runtime by the same
/// variables in debug builds only. Both empty/absent → [`ConfigError::Missing`].
pub fn load() -> Result<SupabaseConfig, ConfigError> {
    resolve(
        COMPILED_URL,
        COMPILED_KEY,
        |name| std::env::var(name).ok(),
        cfg!(debug_assertions),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64url(bytes: &[u8]) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    }

    /// An unsigned-looking JWT with the given claims (the signature is never checked).
    fn jwt(claims: &str) -> String {
        format!(
            "{}.{}.{}",
            b64url(br#"{"alg":"HS256","typ":"JWT"}"#),
            b64url(claims.as_bytes()),
            b64url(b"not-a-real-signature")
        )
    }

    const PUBLISHABLE: &str = "sb_publishable_AbC123_def-456";

    #[test]
    fn env_literals_match_public_constants() {
        // option_env! cannot take a const; make sure the literals did not drift.
        assert_eq!(URL_ENV, "STUDIO_PULSE_SUPABASE_URL");
        assert_eq!(KEY_ENV, "STUDIO_PULSE_SUPABASE_PUBLISHABLE_KEY");
    }

    #[test]
    fn classify_publishable_prefix() {
        assert_eq!(classify_key(PUBLISHABLE), KeyKind::Publishable);
        assert_eq!(
            classify_key(&format!("  {PUBLISHABLE}\n")),
            KeyKind::Publishable
        );
    }

    #[test]
    fn classify_publishable_prefix_without_body_or_with_bad_chars_is_unknown() {
        assert_eq!(classify_key("sb_publishable_"), KeyKind::Unknown);
        assert_eq!(classify_key("sb_publishable_abc def"), KeyKind::Unknown);
        assert_eq!(classify_key("sb_publishable_abc/def"), KeyKind::Unknown);
    }

    #[test]
    fn classify_secret_prefix_in_any_case() {
        assert_eq!(classify_key("sb_secret_abc123"), KeyKind::Secret);
        assert_eq!(classify_key("SB_SECRET_abc123"), KeyKind::Secret);
        assert_eq!(classify_key("sb_secret_"), KeyKind::Secret);
    }

    #[test]
    fn classify_jwt_by_role_claim() {
        assert_eq!(
            classify_key(&jwt(r#"{"iss":"supabase","ref":"abcd","role":"anon"}"#)),
            KeyKind::Publishable
        );
        assert_eq!(
            classify_key(&jwt(r#"{"iss":"supabase","role":"service_role"}"#)),
            KeyKind::Secret
        );
        assert_eq!(
            classify_key(&jwt(r#"{"role":"authenticated"}"#)),
            KeyKind::Unknown
        );
        assert_eq!(
            classify_key(&jwt(r#"{"iss":"supabase"}"#)),
            KeyKind::Unknown
        );
        assert_eq!(classify_key(&jwt(r#"{"role":42}"#)), KeyKind::Unknown);
    }

    #[test]
    fn classify_jwt_with_padding_is_tolerated() {
        let payload = base64::engine::general_purpose::URL_SAFE.encode(br#"{"role":"anon"}"#);
        let token = format!("{}.{payload}.sig", b64url(b"{}"));
        assert_eq!(classify_key(&token), KeyKind::Publishable);
    }

    #[test]
    fn classify_malformed_jwts_and_junk_are_unknown() {
        assert_eq!(classify_key(""), KeyKind::Unknown);
        assert_eq!(classify_key("   "), KeyKind::Unknown);
        assert_eq!(classify_key("hello"), KeyKind::Unknown);
        assert_eq!(classify_key("a.b"), KeyKind::Unknown);
        assert_eq!(classify_key("a.b.c.d"), KeyKind::Unknown);
        assert_eq!(classify_key("x..y"), KeyKind::Unknown);
        assert_eq!(classify_key("x.!!!!.y"), KeyKind::Unknown);
        // Valid base64 but not JSON.
        assert_eq!(
            classify_key(&format!("x.{}.y", b64url(b"not json"))),
            KeyKind::Unknown
        );
    }

    #[test]
    fn validate_accepts_https_origin_and_normalises() {
        let cfg = SupabaseConfig::validate("  https://AbCd1234.supabase.co/  ", PUBLISHABLE)
            .expect("valid");
        assert_eq!(cfg.url, "https://abcd1234.supabase.co");
        assert_eq!(cfg.publishable_key, PUBLISHABLE);
        assert_eq!(cfg.project_ref(), "abcd1234");
    }

    #[test]
    fn validate_strips_every_trailing_slash_and_keeps_explicit_port() {
        let cfg = SupabaseConfig::validate("https://api.example.com:8443///", PUBLISHABLE).unwrap();
        assert_eq!(cfg.url, "https://api.example.com:8443");
        assert_eq!(cfg.project_ref(), "api");
        let cfg = SupabaseConfig::validate("https://api.example.com:443", PUBLISHABLE).unwrap();
        assert_eq!(cfg.url, "https://api.example.com");
    }

    #[test]
    fn validate_accepts_local_http_stack() {
        let cfg = SupabaseConfig::validate("http://127.0.0.1:54321/", PUBLISHABLE).unwrap();
        assert_eq!(cfg.url, "http://127.0.0.1:54321");
        assert_eq!(cfg.project_ref(), "local");
        let cfg = SupabaseConfig::validate("http://localhost:54321", PUBLISHABLE).unwrap();
        assert_eq!(cfg.url, "http://localhost:54321");
        assert_eq!(cfg.project_ref(), "local");
        let cfg = SupabaseConfig::validate("http://LOCALHOST", PUBLISHABLE).unwrap();
        assert_eq!(cfg.url, "http://localhost");
    }

    #[test]
    fn validate_accepts_legacy_anon_jwt() {
        let key = jwt(r#"{"role":"anon","ref":"abcd"}"#);
        let cfg = SupabaseConfig::validate("https://abcd.supabase.co", &key).unwrap();
        assert_eq!(cfg.publishable_key, key);
    }

    #[test]
    fn validate_rejects_plain_http_for_remote_hosts() {
        for url in [
            "http://abcd.supabase.co",
            "http://192.168.1.10:54321",
            "http://127.0.0.2:54321",
            "http://localhost.evil.example",
        ] {
            assert!(
                matches!(
                    SupabaseConfig::validate(url, PUBLISHABLE),
                    Err(ConfigError::InvalidUrl(_))
                ),
                "{url} should be rejected"
            );
        }
    }

    #[test]
    fn validate_rejects_paths_queries_credentials_and_other_schemes() {
        for url in [
            "",
            "   ",
            "abcd.supabase.co",
            "ftp://abcd.supabase.co",
            "wss://abcd.supabase.co",
            "https://abcd.supabase.co/rest/v1",
            "https://abcd.supabase.co/?x=1",
            "https://abcd.supabase.co/#frag",
            "https://user:pass@abcd.supabase.co",
            "https://abcd .supabase.co",
            "https://",
            "file:///C:/x",
        ] {
            assert!(
                matches!(
                    SupabaseConfig::validate(url, PUBLISHABLE),
                    Err(ConfigError::InvalidUrl(_))
                ),
                "{url:?} should be rejected"
            );
        }
    }

    #[test]
    fn invalid_url_reason_never_echoes_the_url() {
        let err = SupabaseConfig::validate("https://user:hunter2@abcd.supabase.co", PUBLISHABLE)
            .unwrap_err();
        assert!(!err.to_string().contains("hunter2"));
    }

    #[test]
    fn validate_refuses_secret_keys_even_with_a_bad_url() {
        assert_eq!(
            SupabaseConfig::validate("https://abcd.supabase.co", "sb_secret_abc"),
            Err(ConfigError::SecretKey)
        );
        assert_eq!(
            SupabaseConfig::validate("not a url", "sb_secret_abc"),
            Err(ConfigError::SecretKey)
        );
        assert_eq!(
            SupabaseConfig::validate(
                "https://abcd.supabase.co",
                &jwt(r#"{"role":"service_role"}"#)
            ),
            Err(ConfigError::SecretKey)
        );
    }

    #[test]
    fn validate_rejects_unknown_or_empty_keys() {
        assert_eq!(
            SupabaseConfig::validate("https://abcd.supabase.co", ""),
            Err(ConfigError::InvalidKey)
        );
        assert_eq!(
            SupabaseConfig::validate("https://abcd.supabase.co", "   "),
            Err(ConfigError::InvalidKey)
        );
        assert_eq!(
            SupabaseConfig::validate("https://abcd.supabase.co", "random-string"),
            Err(ConfigError::InvalidKey)
        );
        assert_eq!(
            SupabaseConfig::validate(
                "https://abcd.supabase.co",
                &jwt(r#"{"role":"authenticated"}"#)
            ),
            Err(ConfigError::InvalidKey)
        );
    }

    #[test]
    fn validate_trims_the_key() {
        let cfg =
            SupabaseConfig::validate("https://abcd.supabase.co", &format!(" {PUBLISHABLE} \t"))
                .unwrap();
        assert_eq!(cfg.publishable_key, PUBLISHABLE);
    }

    #[test]
    fn project_ref_for_ip_hosts_is_local() {
        let cfg = SupabaseConfig {
            url: "http://127.0.0.1:54321".into(),
            publishable_key: PUBLISHABLE.into(),
        };
        assert_eq!(cfg.project_ref(), "local");
        let cfg = SupabaseConfig {
            url: "https://[::1]:8443".into(),
            publishable_key: PUBLISHABLE.into(),
        };
        assert_eq!(cfg.project_ref(), "local");
    }

    fn no_runtime(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn resolve_both_missing_is_missing() {
        assert_eq!(
            resolve(None, None, no_runtime, true),
            Err(ConfigError::Missing)
        );
        assert_eq!(
            resolve(Some(""), Some("  "), no_runtime, false),
            Err(ConfigError::Missing)
        );
    }

    #[test]
    fn resolve_one_missing_is_invalid() {
        assert_eq!(
            resolve(Some("https://abcd.supabase.co"), None, no_runtime, false),
            Err(ConfigError::InvalidKey)
        );
        assert!(matches!(
            resolve(None, Some(PUBLISHABLE), no_runtime, false),
            Err(ConfigError::InvalidUrl(_))
        ));
    }

    #[test]
    fn resolve_uses_compiled_values() {
        let cfg = resolve(
            Some("https://abcd.supabase.co/"),
            Some(PUBLISHABLE),
            no_runtime,
            false,
        )
        .unwrap();
        assert_eq!(cfg.url, "https://abcd.supabase.co");
    }

    #[test]
    fn resolve_runtime_overrides_only_when_allowed_and_non_empty() {
        let runtime = |name: &str| match name {
            "STUDIO_PULSE_SUPABASE_URL" => Some("http://127.0.0.1:54321".to_owned()),
            "STUDIO_PULSE_SUPABASE_PUBLISHABLE_KEY" => Some("   ".to_owned()),
            _ => None,
        };
        let compiled_url = Some("https://abcd.supabase.co");
        // Debug: the non-empty URL override wins, the blank key override is ignored.
        let cfg = resolve(compiled_url, Some(PUBLISHABLE), runtime, true).unwrap();
        assert_eq!(cfg.url, "http://127.0.0.1:54321");
        assert_eq!(cfg.publishable_key, PUBLISHABLE);
        // Release: runtime values are ignored entirely.
        let cfg = resolve(compiled_url, Some(PUBLISHABLE), runtime, false).unwrap();
        assert_eq!(cfg.url, "https://abcd.supabase.co");
    }

    #[test]
    fn resolve_refuses_a_secret_key_from_the_environment() {
        let runtime = |name: &str| (name == KEY_ENV).then(|| "sb_secret_from_env".to_owned());
        assert_eq!(
            resolve(
                Some("https://abcd.supabase.co"),
                Some(PUBLISHABLE),
                runtime,
                true
            ),
            Err(ConfigError::SecretKey)
        );
    }

    #[test]
    fn load_agrees_with_resolve() {
        // Whatever this build/test environment provides, load() is resolve() over it.
        let expected = resolve(
            COMPILED_URL,
            COMPILED_KEY,
            |name| std::env::var(name).ok(),
            cfg!(debug_assertions),
        );
        assert_eq!(load(), expected);
    }

    #[test]
    fn config_errors_never_contain_the_key() {
        for err in [
            ConfigError::Missing,
            ConfigError::InvalidUrl("x".into()),
            ConfigError::InvalidKey,
            ConfigError::SecretKey,
        ] {
            assert!(!err.to_string().contains("sb_"));
        }
    }
}
