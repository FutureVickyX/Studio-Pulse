//! Pure formatting: ISO-8601 timestamps and the CSV / JSON exports. No I/O, no database.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;

use crate::tracker::EpochMs;

use super::TrackingEventRecord;

/// `format` field of the JSON export. Bump it when the exported shape changes.
pub const EXPORT_FORMAT: &str = "studio-pulse.tracking.v1";

/// `0000-01-01T00:00:00.000Z`, the earliest instant [`iso_from_ms`] renders.
const MIN_ISO_MS: EpochMs = -62_167_219_200_000;
/// `9999-12-31T23:59:59.999Z`, the latest instant [`iso_from_ms`] renders.
const MAX_ISO_MS: EpochMs = 253_402_300_799_999;

/// Columns of [`export_csv`], in order.
const CSV_HEADER: [&str; 16] = [
    "id",
    "device_id",
    "application_id",
    "application_name",
    "kind",
    "started_at",
    "ended_at",
    "duration_seconds",
    "active_seconds",
    "idle_seconds",
    "state",
    "end_reason",
    "project_id",
    "task_id",
    "source",
    "sync_status",
];

/// RFC 4180 line terminator.
const CRLF: &str = "\r\n";

/// UTC epoch milliseconds as ISO-8601 / RFC 3339 with milliseconds and a `Z` suffix:
/// `2026-10-13T09:15:00.000Z`.
///
/// Pre-1970 instants (negative `ms`) are formatted exactly (`-1` →
/// `1969-12-31T23:59:59.999Z`). The output is always a 24-character string with a four-digit
/// year, which every ISO-8601 parser (including JavaScript's `Date`) accepts: instants before
/// year 0000 or after year 9999, which no real clock produces, are clamped to
/// `0000-01-01T00:00:00.000Z` / `9999-12-31T23:59:59.999Z` instead of panicking.
pub fn iso_from_ms(ms: EpochMs) -> String {
    let clamped = ms.clamp(MIN_ISO_MS, MAX_ISO_MS);
    DateTime::<Utc>::from_timestamp_millis(clamped).map_or_else(
        // Unreachable: the clamped range is well inside chrono's representable range.
        || "1970-01-01T00:00:00.000Z".to_owned(),
        |instant| instant.to_rfc3339_opts(SecondsFormat::Millis, true),
    )
}

/// Milliseconds as seconds with millisecond precision (`1500` → `1.5`).
pub(super) fn seconds_from_ms(ms: i64) -> f64 {
    // Exact for any duration below 2^53 ms (≈ 285,000 years).
    ms as f64 / 1_000.0
}

/// RFC-4180 CSV with a header row; one CRLF-terminated line per record; times in ISO-8601 UTC.
///
/// Columns: `id, device_id, application_id, application_name, kind, started_at, ended_at,
/// duration_seconds, active_seconds, idle_seconds, state, end_reason, project_id, task_id,
/// source, sync_status`. Durations have exactly three decimals; absent values are empty.
/// A field containing a comma, a double quote, CR or LF is quoted and its quotes doubled.
pub fn export_csv(records: &[TrackingEventRecord]) -> String {
    let mut out = String::with_capacity(160 * (records.len() + 1));
    push_csv_line(&mut out, CSV_HEADER);
    for record in records {
        let duration = format!("{:.3}", record.duration_seconds);
        let active = format!("{:.3}", record.active_seconds);
        let idle = format!("{:.3}", record.idle_seconds);
        let fields = [
            record.id.as_str(),
            record.device_id.as_str(),
            record.application_id.as_str(),
            record.application_name.as_str(),
            record.kind.as_str(),
            record.started_at.as_str(),
            record.ended_at.as_str(),
            duration.as_str(),
            active.as_str(),
            idle.as_str(),
            record.state.as_str(),
            record.end_reason.map_or("", |reason| reason.as_str()),
            record.project_id.as_deref().unwrap_or(""),
            record.task_id.as_deref().unwrap_or(""),
            record.source.as_str(),
            record.sync_status.as_str(),
        ];
        push_csv_line(&mut out, fields);
    }
    out
}

/// Append one CRLF-terminated CSV line.
fn push_csv_line<'a>(out: &mut String, fields: impl IntoIterator<Item = &'a str>) {
    for (index, field) in fields.into_iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        push_csv_field(out, field);
    }
    out.push_str(CRLF);
}

/// Append one field, quoted only when RFC 4180 requires it.
fn push_csv_field(out: &mut String, field: &str) {
    if field.contains([',', '"', '\r', '\n']) {
        out.push('"');
        out.push_str(&field.replace('"', "\"\""));
        out.push('"');
    } else {
        out.push_str(field);
    }
}

/// The JSON export document. Field order is the order written.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportDocument<'a> {
    exported_at: String,
    device_id: &'a str,
    format: &'static str,
    events: &'a [TrackingEventRecord],
}

/// Pretty JSON:
/// `{ "exportedAt", "deviceId", "format": "studio-pulse.tracking.v1", "events": [...] }`.
///
/// Each event has the `TrackingEvent` shape of shared-types (camelCase keys, ISO times, seconds).
pub fn export_json(
    records: &[TrackingEventRecord],
    device_id: &str,
    exported_at_ms: EpochMs,
) -> String {
    let document = ExportDocument {
        exported_at: iso_from_ms(exported_at_ms),
        device_id,
        format: EXPORT_FORMAT,
        events: records,
    };
    match serde_json::to_string_pretty(&document) {
        Ok(json) => json,
        Err(err) => {
            // Unreachable in practice: every field is a string, number, bool or null, and
            // serde_json writes non-finite floats as null instead of failing.
            log::error!("tracking export could not be serialized: {err}");
            format!(
                "{{\"exportedAt\":\"{}\",\"format\":\"{EXPORT_FORMAT}\",\"events\":[]}}",
                iso_from_ms(exported_at_ms)
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_has_millisecond_precision_and_z_suffix() {
        assert_eq!(iso_from_ms(1_791_882_900_000), "2026-10-13T09:15:00.000Z");
        assert_eq!(iso_from_ms(1_791_882_900_007), "2026-10-13T09:15:00.007Z");
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn iso_handles_pre_1970_and_clamps_the_extremes() {
        assert_eq!(iso_from_ms(-1), "1969-12-31T23:59:59.999Z");
        assert_eq!(iso_from_ms(i64::MIN), "0000-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(MIN_ISO_MS), "0000-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(i64::MAX), "9999-12-31T23:59:59.999Z");
        assert_eq!(iso_from_ms(MAX_ISO_MS), "9999-12-31T23:59:59.999Z");
    }

    #[test]
    fn csv_fields_are_quoted_only_when_needed() {
        let mut out = String::new();
        for field in ["plain", "a,b", "say \"hi\"", "line\nbreak", "cr\rhere", ""] {
            push_csv_field(&mut out, field);
            out.push('|');
        }
        assert_eq!(
            out,
            "plain|\"a,b\"|\"say \"\"hi\"\"\"|\"line\nbreak\"|\"cr\rhere\"||"
        );
    }

    #[test]
    fn csv_without_records_is_just_the_header() {
        assert_eq!(
            export_csv(&[]),
            "id,device_id,application_id,application_name,kind,started_at,ended_at,\
             duration_seconds,active_seconds,idle_seconds,state,end_reason,project_id,task_id,\
             source,sync_status\r\n"
        );
    }

    #[test]
    fn seconds_keep_milliseconds() {
        assert_eq!(seconds_from_ms(1_500), 1.5);
        assert_eq!(seconds_from_ms(1), 0.001);
        assert_eq!(seconds_from_ms(0), 0.0);
    }
}
