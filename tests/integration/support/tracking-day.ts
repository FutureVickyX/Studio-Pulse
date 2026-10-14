/**
 * Builds realistic `TrackingEvent` records the way the Rust tracker writes them: contiguous
 * intervals on one device, each wholly active or wholly idle, closed with the end reason the engine
 * would record, plus the duplicate rows `list_tracking_events` can return (a persisted checkpoint
 * of an interval next to a newer revision of the same id).
 *
 * The script is written in local wall-clock time for one IANA zone; durations are real elapsed
 * minutes, so a session that crosses midnight simply keeps going.
 */

import { TZDate } from '@date-fns/tz';
import type { EndReason, IntervalKind, TrackingEvent } from '@studio-pulse/shared-types';

export interface AppRef {
  id: string;
  name: string;
}

export interface IntervalOptions {
  projectId?: string | null;
  taskId?: string | null;
}

const MINUTE = 60_000;

export class TrackingDayBuilder {
  private readonly deviceId: string;
  private readonly timeZone: string;
  private cursor: number | null = null;
  private sequence = 0;
  private readonly records: TrackingEvent[] = [];
  private readonly extras: TrackingEvent[] = [];

  constructor(options: { deviceId: string; timeZone: string }) {
    this.deviceId = options.deviceId;
    this.timeZone = options.timeZone;
  }

  /** Move the cursor to a local wall-clock time, e.g. `at('2026-10-12', '09:00')`. */
  at(day: string, time: string): this {
    const [year, month, date] = day.split('-').map(Number);
    const [hours, minutes] = time.split(':').map(Number);
    if ([year, month, date, hours, minutes].some((part) => part === undefined || Number.isNaN(part))) {
      throw new Error(`bad local time ${day} ${time}`);
    }
    this.cursor = new TZDate(year!, month! - 1, date!, hours!, minutes!, this.timeZone).getTime();
    return this;
  }

  /** `minutes` of active foreground time in `app`, starting at the cursor. */
  work(app: AppRef, minutes: number, options: IntervalOptions = {}): this {
    return this.push(app, 'active', minutes, options, 'closed');
  }

  /** `minutes` of idle time with `app` still in the foreground. */
  idle(app: AppRef, minutes: number, options: IntervalOptions = {}): this {
    return this.push(app, 'idle', minutes, options, 'closed');
  }

  /** Untracked or away time: nothing is recorded. */
  gap(minutes: number): this {
    this.cursor = this.requireCursor() + minutes * MINUTE;
    return this;
  }

  /** The interval being recorded right now (state `open`). */
  live(app: AppRef, minutes: number, options: IntervalOptions = {}): this {
    return this.push(app, 'active', minutes, options, 'open');
  }

  /**
   * Also return an older checkpoint of the last interval: same id, lower revision, `open`, ending
   * `minutesEarlier` before the final row. Reports must count the interval once.
   */
  withStaleCheckpoint(minutesEarlier: number): this {
    const last = this.records.at(-1);
    if (!last) throw new Error('no interval to checkpoint');
    const endMs = Date.parse(last.endedAt) - minutesEarlier * MINUTE;
    const seconds = (endMs - Date.parse(last.startedAt)) / 1000;
    this.extras.push({
      ...last,
      endedAt: new Date(endMs).toISOString(),
      durationSeconds: seconds,
      activeSeconds: last.kind === 'active' ? seconds : 0,
      idleSeconds: last.kind === 'idle' ? seconds : 0,
      state: 'open',
      endReason: null,
      revision: last.revision - 1,
    });
    return this;
  }

  /** All rows, as `list_tracking_events` would return them (newest first, duplicates included). */
  build(): TrackingEvent[] {
    const closed = this.records.map((record, index) => {
      if (record.state === 'open') return record;
      return { ...record, endReason: endReasonFor(record, this.records[index + 1]) };
    });
    return [...closed, ...this.extras].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  /** The intervals as recorded (no duplicate rows), oldest first. */
  intervals(): readonly TrackingEvent[] {
    return this.records;
  }

  private requireCursor(): number {
    if (this.cursor === null) throw new Error('call at() first');
    return this.cursor;
  }

  private push(app: AppRef, kind: IntervalKind, minutes: number, options: IntervalOptions, state: 'open' | 'closed'): this {
    const startMs = this.requireCursor();
    const endMs = startMs + minutes * MINUTE;
    const seconds = minutes * 60;
    this.sequence += 1;
    this.records.push({
      id: `0192a6f0-0000-7000-8000-${String(this.sequence).padStart(12, '0')}`,
      userId: null,
      deviceId: this.deviceId,
      applicationId: app.id,
      applicationName: app.name,
      kind,
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      durationSeconds: seconds,
      activeSeconds: kind === 'active' ? seconds : 0,
      idleSeconds: kind === 'idle' ? seconds : 0,
      projectId: options.projectId ?? null,
      taskId: options.taskId ?? null,
      source: 'automatic',
      syncStatus: 'pending',
      state,
      endReason: null,
      // Each interval is written when it opens (1), then checkpointed and closed.
      revision: state === 'open' ? 6 : 3,
    });
    this.cursor = endMs;
    return this;
  }
}

/** The reason the engine closes `record`, judged from what follows it. */
function endReasonFor(record: TrackingEvent, next: TrackingEvent | undefined): EndReason {
  if (!next || next.startedAt !== record.endedAt) return 'sessionAway';
  if (next.applicationId !== record.applicationId) return 'appSwitch';
  if (record.kind === 'active' && next.kind === 'idle') return 'becameIdle';
  if (record.kind === 'idle' && next.kind === 'active') return 'inputResumed';
  return 'appSwitch';
}
