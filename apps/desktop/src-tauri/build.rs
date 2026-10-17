//! 1. Declares the app's native commands so Tauri generates an `allow-<command>` permission for
//!    each. Only commands granted in `capabilities/*.json` are callable from a window, which makes
//!    the command surface an explicit, per-window allowlist (docs/architecture.md §7).
//! 2. Guards the Supabase configuration compiled into the app (docs/supabase.md): the publishable
//!    key is public, but a secret / service-role key bypasses Row Level Security and must never
//!    ship. The build fails if one is supplied.

const COMMANDS: &[&str] = &[
    "get_tracker_status",
    "pause_tracking",
    "resume_tracking",
    "list_tracking_events",
    "get_settings",
    "update_settings",
    "complete_onboarding",
    "get_startup_status",
    "set_launch_at_login",
    "list_applications",
    "save_application",
    "delete_application",
    "reset_applications",
    "list_running_applications",
    "pick_executable",
    "get_data_summary",
    "export_tracking_events",
    "delete_tracking_events",
    "get_app_info",
    "show_main_window",
    "hide_indicator",
    "quit_app",
    // Phase 2A: account, workspaces and sync.
    "get_account_status",
    "sign_in",
    "sign_up",
    "sign_out",
    "refresh_workspaces",
    "create_workspace",
    "select_sync_workspace",
    "accept_invitation",
    "create_invitation",
    "get_sync_status",
    "sync_now",
    "claim_local_history",
];

const URL_ENV: &str = "STUDIO_PULSE_SUPABASE_URL";
const KEY_ENV: &str = "STUDIO_PULSE_SUPABASE_PUBLISHABLE_KEY";

/// Decode base64url (no padding required). Enough for reading a JWT payload; invalid input → None.
fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    let mut bits: u32 = 0;
    let mut count = 0;
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    for c in input.bytes() {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => continue,
            _ => return None,
        };
        bits = (bits << 6) | u32::from(value);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
        }
    }
    Some(out)
}

/// True for `sb_secret_…` keys and JWTs whose payload says `"role":"service_role"`.
fn is_secret_key(key: &str) -> bool {
    let key = key.trim();
    if key.to_ascii_lowercase().starts_with("sb_secret_") {
        return true;
    }
    let mut parts = key.split('.');
    if let (Some(_header), Some(payload), Some(_signature)) =
        (parts.next(), parts.next(), parts.next())
    {
        if let Some(bytes) = base64url_decode(payload) {
            let text: String = String::from_utf8_lossy(&bytes)
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            return text.contains("\"role\":\"service_role\"");
        }
    }
    false
}

fn main() {
    println!("cargo:rerun-if-env-changed={URL_ENV}");
    println!("cargo:rerun-if-env-changed={KEY_ENV}");
    if let Ok(key) = std::env::var(KEY_ENV) {
        if is_secret_key(&key) {
            // Do not print the key.
            panic!(
                "{KEY_ENV} holds a secret / service-role key. Desktop builds may only embed the \
                 publishable (anon) key — see docs/supabase.md."
            );
        }
    }

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
