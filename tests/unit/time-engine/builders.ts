/**
 * Builders for time-engine unit tests. They produce well-formed `TrackingEvent` /
 * `ApplicationDefinition` records exactly as the Rust core serializes them; individual fields can
 * be overridden to model malformed or inconsistent input.
 */

import type {
  AppCategory,
  ApplicationDefinition,
  IntervalKind,
  TrackingEvent,
} from '@studio-pulse/shared-types';
import type { NormalizedInterval } from '@studio-pulse/time-engine';

export const SECOND = 1_000;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Epoch ms of an ISO instant (test inputs always carry an explicit offset). */
export function at(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`bad test timestamp ${iso}`);
  return ms;
}

/** `2026-10-13T09:15:00.000Z`, the format the Rust store emits. */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

let sequence = 0;

export interface EventSpec extends Partial<Omit<TrackingEvent, 'startedAt' | 'endedAt'>> {
  /** ISO string (used verbatim) or epoch ms. */
  start: string | number;
  /** ISO string (used verbatim) or epoch ms. */
  end: string | number;
}

/** A TrackingEvent with consistent seconds fields unless overridden. */
export function event(spec: EventSpec): TrackingEvent {
  const { start, end, ...overrides } = spec;
  const startedAt = typeof start === 'number' ? iso(start) : start;
  const endedAt = typeof end === 'number' ? iso(end) : end;
  const kind: IntervalKind = overrides.kind ?? 'active';
  const durationSeconds = Math.max(0, (Date.parse(endedAt) - Date.parse(startedAt)) / 1000) || 0;
  sequence += 1;
  return {
    id: `evt-${String(sequence).padStart(4, '0')}`,
    userId: null,
    deviceId: 'device-a',
    applicationId: 'figma',
    applicationName: 'Figma',
    kind,
    startedAt,
    endedAt,
    durationSeconds,
    activeSeconds: kind === 'active' ? durationSeconds : 0,
    idleSeconds: kind === 'idle' ? durationSeconds : 0,
    projectId: null,
    taskId: null,
    source: 'automatic',
    syncStatus: 'pending',
    state: 'closed',
    endReason: 'appSwitch',
    revision: 1,
    ...overrides,
  };
}

/** An ApplicationDefinition as `list_applications` returns it. */
export function application(
  id: string,
  displayName: string,
  category: AppCategory,
  overrides: Partial<ApplicationDefinition> = {},
): ApplicationDefinition {
  return {
    id,
    displayName,
    category,
    matchers: [{ exe: `${displayName.replace(/\s+/g, '')}.exe` }],
    enabled: true,
    includeInReports: true,
    builtIn: true,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A hand-built NormalizedInterval (for clip / split / overlap tests). */
export function interval(
  startMs: number,
  endMs: number,
  overrides: Partial<NormalizedInterval> = {},
): NormalizedInterval {
  const kind = overrides.kind ?? 'active';
  const duration = endMs - startMs;
  return {
    id: overrides.id ?? `int-${startMs}`,
    deviceId: 'device-a',
    applicationId: 'figma',
    applicationName: 'Figma',
    kind,
    startMs,
    endMs,
    activeMs: kind === 'active' ? duration : 0,
    idleMs: kind === 'idle' ? duration : 0,
    projectId: null,
    taskId: null,
    source: 'automatic',
    open: false,
    ...overrides,
  };
}

export interface TotalsLike {
  foregroundMs: number;
  activeMs: number;
  idleMs: number;
}

export function sumTotals(rows: readonly TotalsLike[]): TotalsLike {
  return rows.reduce<TotalsLike>(
    (sum, row) => ({
      foregroundMs: sum.foregroundMs + row.foregroundMs,
      activeMs: sum.activeMs + row.activeMs,
      idleMs: sum.idleMs + row.idleMs,
    }),
    { foregroundMs: 0, activeMs: 0, idleMs: 0 },
  );
}

/** Totals of interval-like pieces (foreground = end - start). */
export function sumPieces(pieces: ReadonlyArray<{ startMs: number; endMs: number; activeMs: number; idleMs: number }>): TotalsLike {
  return sumTotals(
    pieces.map((piece) => ({ foregroundMs: piece.endMs - piece.startMs, activeMs: piece.activeMs, idleMs: piece.idleMs })),
  );
}
