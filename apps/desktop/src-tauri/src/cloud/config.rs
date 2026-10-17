//! Supabase project configuration for the desktop app.
//!
//! Only two **public** values are needed: the project URL and the publishable (or legacy
//! "anon") key. They are compiled in from `STUDIO_PULSE_SUPABASE_URL` and
//! `STUDIO_PULSE_SUPABASE_PUBLISHABLE_KEY` (build.rs refuses to embed a secret key). Debug
//! builds may override both at runtime with the same environment variables.
//!
//! A secret / service-role key is rejected everywhere: it bypasses Row Level Security and must
//! never ship in a client.

/// Environment variable holding the project URL (build time; debug builds also at runtime).
pub const URL_ENV: &str = "STUDIO_PULSE_SUPABASE_URL";
/// Environment variable holding the publishable key (build time; debug builds also at runtime).
pub const KEY_ENV: &str = "STUDIO_PULSE_SUPABASE_PUBLISHABLE_KEY";

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
pub fn classify_key(_key: &str) -> KeyKind {
    todo!("cloud::config::classify_key")
}

impl SupabaseConfig {
    /// Validate and normalise (trim, strip trailing `/`). Secret keys → [`ConfigError::SecretKey`].
    pub fn validate(_url: &str, _key: &str) -> Result<SupabaseConfig, ConfigError> {
        todo!("SupabaseConfig::validate")
    }

    /// Short stable name for this project (the first host label, e.g. the project ref), used to
    /// name the stored credential.
    pub fn project_ref(&self) -> String {
        todo!("SupabaseConfig::project_ref")
    }
}

/// The configuration compiled into this build (`option_env!`), overridden at runtime by the same
/// variables in debug builds only. Both empty/absent → [`ConfigError::Missing`].
pub fn load() -> Result<SupabaseConfig, ConfigError> {
    todo!("cloud::config::load")
}
