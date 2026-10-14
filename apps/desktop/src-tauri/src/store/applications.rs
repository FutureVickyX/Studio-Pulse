//! The `applications` table: seeding, listing, editing and resetting the registry.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};

use crate::registry::{AppCategory, ApplicationDefinition, ApplicationInput, DefaultApplication};
use crate::tracker::EpochMs;

use super::format::iso_from_ms;
use super::{invalid_column, to_i64, StoreError, StoreResult};

/// Gap between consecutive `sort_order` values (built-in `i` gets `i * SORT_STEP`).
const SORT_STEP: i64 = 10;

/// Prefix of generated custom application ids: `custom-` + 8 lowercase hex characters.
const CUSTOM_ID_PREFIX: &str = "custom-";

/// Attempts at drawing an unused custom id before giving up (a collision needs ~65k customs).
const CUSTOM_ID_ATTEMPTS: usize = 8;

const SELECT_APPLICATION: &str = "SELECT id, display_name, category, matchers_json, enabled,
        include_in_reports, built_in, sort_order, created_at_ms, updated_at_ms
    FROM applications";

/// Insert a built-in with its default definition (`?5` = `enabled_by_default`), followed by
/// one of the conflict clauses below.
const INSERT_BUILT_IN: &str = "INSERT INTO applications (
        id, display_name, category, matchers_json, enabled, include_in_reports, built_in,
        sort_order, created_at_ms, updated_at_ms)
    VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, ?6, ?7, ?7)";

/// Seeding: an existing row (and any user edit of it) wins.
const KEEP_EXISTING: &str = "ON CONFLICT(id) DO NOTHING";

/// Reset: the default definition overwrites the row (`created_at_ms` is kept).
const RESTORE_DEFAULT: &str = "ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        category = excluded.category,
        matchers_json = excluded.matchers_json,
        enabled = excluded.enabled,
        include_in_reports = 1,
        built_in = 1,
        sort_order = excluded.sort_order,
        updated_at_ms = excluded.updated_at_ms";

/// Insert built-ins missing by id; existing rows (and user edits) are left alone.
pub(super) fn seed(
    tx: &Transaction<'_>,
    defaults: &[DefaultApplication],
    now: EpochMs,
) -> StoreResult<usize> {
    write_built_ins(tx, defaults, KEEP_EXISTING, now)
}

/// Rewrite every built-in in `defaults` to its default definition (inserting missing ones) and
/// optionally delete custom rows, in the caller's transaction. Returns the resulting list.
pub(super) fn reset(
    tx: &Transaction<'_>,
    defaults: &[DefaultApplication],
    remove_custom: bool,
    now: EpochMs,
) -> StoreResult<Vec<ApplicationDefinition>> {
    write_built_ins(tx, defaults, RESTORE_DEFAULT, now)?;
    if remove_custom {
        tx.execute("DELETE FROM applications WHERE built_in = 0", [])?;
    }
    list(tx)
}

/// Write each default with [`INSERT_BUILT_IN`] + `on_conflict`. Returns the rows changed.
fn write_built_ins(
    tx: &Transaction<'_>,
    defaults: &[DefaultApplication],
    on_conflict: &str,
    now: EpochMs,
) -> StoreResult<usize> {
    let mut stmt = tx.prepare_cached(&format!("{INSERT_BUILT_IN} {on_conflict}"))?;
    let mut changed = 0;
    for (index, app) in defaults.iter().enumerate() {
        changed += stmt.execute(params![
            app.id,
            app.display_name,
            app.category.as_str(),
            serde_json::to_string(&app.matchers)?,
            app.enabled_by_default,
            built_in_sort_order(index),
            now,
        ])?;
    }
    Ok(changed)
}

/// `sort_order` of the built-in at `index` in the defaults file.
fn built_in_sort_order(index: usize) -> i64 {
    to_i64(index).saturating_mul(SORT_STEP)
}

/// Every application, ordered by `sort_order`, then display name (case-insensitive), then id.
pub(super) fn list(conn: &Connection) -> StoreResult<Vec<ApplicationDefinition>> {
    let sql = format!("{SELECT_APPLICATION} ORDER BY sort_order, display_name COLLATE NOCASE, id");
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt.query_map([], map_application)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// One application by id.
fn get(conn: &Connection, id: &str) -> StoreResult<Option<ApplicationDefinition>> {
    let sql = format!("{SELECT_APPLICATION} WHERE id = ?1");
    Ok(conn
        .query_row(&sql, params![id], map_application)
        .optional()?)
}

/// Create (`id: None`) or update (`id: Some`) an application. The input is already validated.
pub(super) fn save(
    tx: &Transaction<'_>,
    input: &ApplicationInput,
    now: EpochMs,
) -> StoreResult<ApplicationDefinition> {
    let display_name = input.display_name.trim();
    let matchers_json = serde_json::to_string(&input.matchers)?;
    let id = match &input.id {
        None => {
            let id = unused_custom_id(tx)?;
            tx.execute(
                "INSERT INTO applications (
                    id, display_name, category, matchers_json, enabled, include_in_reports,
                    built_in, sort_order, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0,
                         (SELECT COALESCE(MAX(sort_order) + ?7, 0) FROM applications), ?8, ?8)",
                params![
                    id,
                    display_name,
                    input.category.as_str(),
                    matchers_json,
                    input.enabled,
                    input.include_in_reports,
                    SORT_STEP,
                    now,
                ],
            )?;
            id
        }
        Some(id) => {
            // `built_in`, `sort_order` and `created_at_ms` are deliberately left unchanged.
            let updated = tx.execute(
                "UPDATE applications
                 SET display_name = ?2, category = ?3, matchers_json = ?4, enabled = ?5,
                     include_in_reports = ?6, updated_at_ms = ?7
                 WHERE id = ?1",
                params![
                    id,
                    display_name,
                    input.category.as_str(),
                    matchers_json,
                    input.enabled,
                    input.include_in_reports,
                    now,
                ],
            )?;
            if updated == 0 {
                return Err(not_found(id));
            }
            id.clone()
        }
    };
    get(tx, &id)?.ok_or_else(|| not_found(&id))
}

/// A fresh `custom-xxxxxxxx` id that no row uses yet.
fn unused_custom_id(conn: &Connection) -> StoreResult<String> {
    for _ in 0..CUSTOM_ID_ATTEMPTS {
        // The top 32 bits of a UUIDv4 are random (the version bits sit lower down).
        let random = (uuid::Uuid::new_v4().as_u128() >> 96) as u32;
        let candidate = format!("{CUSTOM_ID_PREFIX}{random:08x}");
        let taken: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM applications WHERE id = ?1)",
            params![candidate],
            |row| row.get(0),
        )?;
        if !taken {
            return Ok(candidate);
        }
    }
    Err(StoreError::Invalid(
        "could not allocate an id for the new application; try again".to_owned(),
    ))
}

/// Delete a custom application. Built-ins can only be disabled.
pub(super) fn delete(tx: &Transaction<'_>, id: &str) -> StoreResult<()> {
    let built_in: Option<bool> = tx
        .query_row(
            "SELECT built_in FROM applications WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    match built_in {
        None => Err(not_found(id)),
        Some(true) => Err(StoreError::Invalid(
            "built-in applications can be disabled but not deleted".to_owned(),
        )),
        Some(false) => {
            tx.execute("DELETE FROM applications WHERE id = ?1", params![id])?;
            Ok(())
        }
    }
}

/// `enabled = (id ∈ ids)` for every row. Any unknown id rejects the whole call.
pub(super) fn set_enabled(tx: &Transaction<'_>, ids: &[String], now: EpochMs) -> StoreResult<()> {
    let known: HashSet<String> = {
        let mut stmt = tx.prepare_cached("SELECT id FROM applications")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<_, _>>()?
    };
    if let Some(unknown) = ids.iter().find(|id| !known.contains(id.as_str())) {
        return Err(StoreError::Invalid(format!(
            "unknown application id: {unknown}"
        )));
    }
    let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut stmt = tx.prepare_cached(
        "UPDATE applications SET enabled = ?2, updated_at_ms = ?3 WHERE id = ?1 AND enabled <> ?2",
    )?;
    for id in &known {
        stmt.execute(params![id, wanted.contains(id.as_str()), now])?;
    }
    Ok(())
}

fn not_found(id: &str) -> StoreError {
    StoreError::NotFound(format!("application {id} was not found"))
}

/// Map a [`SELECT_APPLICATION`] row. Values the schema forbids surface as conversion errors.
fn map_application(row: &Row<'_>) -> rusqlite::Result<ApplicationDefinition> {
    let category: String = row.get(2)?;
    let category = AppCategory::parse(&category)
        .ok_or_else(|| invalid_column(2, format!("unknown category {category:?}")))?;
    let matchers_json: String = row.get(3)?;
    let matchers = serde_json::from_str(&matchers_json)
        .map_err(|err| invalid_column(3, format!("invalid matchers: {err}")))?;
    Ok(ApplicationDefinition {
        id: row.get(0)?,
        display_name: row.get(1)?,
        category,
        matchers,
        enabled: row.get(4)?,
        include_in_reports: row.get(5)?,
        built_in: row.get(6)?,
        sort_order: row.get(7)?,
        created_at: iso_from_ms(row.get(8)?),
        updated_at: iso_from_ms(row.get(9)?),
    })
}
