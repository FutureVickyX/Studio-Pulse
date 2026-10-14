//! The `meta` table (device id) and the `preferences` table (settings document).

use rusqlite::{params, Connection, OptionalExtension};

use crate::settings::Settings;
use crate::tracker::EpochMs;

use super::{StoreError, StoreResult};

const DEVICE_ID_KEY: &str = "device_id";
const SETTINGS_KEY: &str = "settings";

/// The device id, generated (UUIDv4) and stored on first use.
///
/// Race-safe: the insert is a no-op when another writer got there first, and the value read
/// back is whichever id won.
pub(super) fn device_id(conn: &Connection) -> StoreResult<String> {
    if let Some(id) = read_meta(conn, DEVICE_ID_KEY)? {
        return Ok(id);
    }
    let candidate = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
        params![DEVICE_ID_KEY, candidate],
    )?;
    read_meta(conn, DEVICE_ID_KEY)?
        .ok_or_else(|| StoreError::Invalid("the device id could not be stored".to_owned()))
}

fn read_meta(conn: &Connection, key: &str) -> StoreResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?)
}

/// Stored settings, or defaults when absent or invalid (logged; the stored document is kept
/// until the next save).
pub(super) fn load_settings(conn: &Connection) -> StoreResult<Settings> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value_json FROM preferences WHERE key = ?1",
            params![SETTINGS_KEY],
            |row| row.get(0),
        )
        .optional()?;
    let Some(json) = stored else {
        return Ok(Settings::default());
    };
    match parse_settings(&json) {
        Ok(settings) => Ok(settings),
        Err(why) => {
            log::warn!("stored settings are invalid ({why}); using defaults until the next save");
            Ok(Settings::default())
        }
    }
}

/// Lenient parse (missing fields default, unknown fields ignored) followed by range checks.
/// The document must be a JSON object: serde would otherwise accept an array positionally.
fn parse_settings(json: &str) -> Result<Settings, String> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|err| err.to_string())?;
    if !value.is_object() {
        return Err("the settings document is not a JSON object".to_owned());
    }
    let settings: Settings = serde_json::from_value(value).map_err(|err| err.to_string())?;
    settings.validate()?;
    Ok(settings)
}

/// Validate, then upsert the settings document.
pub(super) fn save_settings(
    conn: &Connection,
    settings: &Settings,
    now: EpochMs,
) -> StoreResult<()> {
    settings.validate().map_err(StoreError::Invalid)?;
    let json = serde_json::to_string(settings)?;
    conn.execute(
        "INSERT INTO preferences (key, value_json, updated_at_ms) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
             value_json = excluded.value_json,
             updated_at_ms = excluded.updated_at_ms",
        params![SETTINGS_KEY, json, now],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_is_lenient_but_range_checked() {
        let s = parse_settings(r#"{"tracking":{"checkpointSeconds":30},"extra":true}"#).unwrap();
        assert_eq!(s.tracking.checkpoint_seconds, 30);
        assert_eq!(s.general, Settings::default().general);
        assert!(parse_settings(r#"{"tracking":{"checkpointSeconds":1}}"#).is_err());
        assert!(parse_settings(r#"{"tracking":{"checkpointSeconds":"x"}}"#).is_err());
        assert!(parse_settings("[]").is_err());
        assert!(parse_settings("{not json").is_err());
    }
}
