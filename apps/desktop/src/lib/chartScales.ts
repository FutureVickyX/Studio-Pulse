/**
 * Axis helpers for the time charts. Pure, unit-tested.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** Visible window for a single-day timeline: fitted to the recorded hours, at least 4 h. */
export function timelineWindow(
  dayStartMs: number,
  dayEndMs: number,
  segments: ReadonlyArray<{ startMs: number; endMs: number }>,
  nowMs: number | null,
  minimumSpanMs = 4 * HOUR,
): { startMs: number; endMs: number } {
  const nowInDay = nowMs !== null && nowMs >= dayStartMs && nowMs < dayEndMs ? nowMs : null;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const segment of segments) {
    first = Math.min(first, Math.max(segment.startMs, dayStartMs));
    last = Math.max(last, Math.min(segment.endMs, dayEndMs));
  }
  if (nowInDay !== null) {
    last = Math.max(last, nowInDay);
    if (!Number.isFinite(first)) first = nowInDay - 3 * HOUR;
  }
  if (!Number.isFinite(first) || !Number.isFinite(last)) return { startMs: dayStartMs, endMs: dayEndMs };

  const floorHour = (ms: number) => dayStartMs + Math.floor((ms - dayStartMs) / HOUR) * HOUR;
  const ceilHour = (ms: number) => dayStartMs + Math.ceil((ms - dayStartMs) / HOUR) * HOUR;

  let startMs = Math.max(dayStartMs, floorHour(first));
  let endMs = Math.min(dayEndMs, Math.max(ceilHour(last), startMs + HOUR));
  if (endMs - startMs < minimumSpanMs) {
    endMs = Math.min(dayEndMs, startMs + minimumSpanMs);
    if (endMs - startMs < minimumSpanMs) startMs = Math.max(dayStartMs, endMs - minimumSpanMs);
  }
  return { startMs, endMs };
}

/** Hour-aligned tick positions (relative to local midnight) inside [startMs, endMs]. */
export function timelineTicks(startMs: number, endMs: number, dayStartMs: number, maxTicks = 7): number[] {
  const span = Math.max(0, endMs - startMs);
  const steps = [1, 2, 3, 4, 6, 12].map((hours) => hours * HOUR);
  const step = steps.find((candidate) => Math.floor(span / candidate) + 1 <= maxTicks) ?? 12 * HOUR;
  const first = dayStartMs + Math.ceil((startMs - dayStartMs) / step) * step;
  const ticks: number[] = [];
  for (let ms = first; ms <= endMs; ms += step) ticks.push(ms);
  return ticks;
}

/** Clean y-axis ticks for durations: 0 … max in 2–5 even steps. */
export function durationTicks(maxMs: number): number[] {
  const steps = [5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440].map((minutes) => minutes * MINUTE);
  const max = Math.max(0, maxMs);
  if (max === 0) return [0, HOUR];
  const step = steps.find((candidate) => Math.ceil(max / candidate) <= 4) ?? Math.ceil(max / 4 / HOUR) * HOUR;
  const count = Math.max(1, Math.ceil(max / step));
  return Array.from({ length: count + 1 }, (_, index) => index * step);
}

/** Axis label for a duration: `0`, `30m`, `2h`, `1h 30m`. */
export function formatAxisDuration(ms: number): string {
  if (ms <= 0) return '0';
  const totalMinutes = Math.round(ms / MINUTE);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}
