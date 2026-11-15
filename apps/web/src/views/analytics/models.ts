/**
 * View models the Analytics components take that `lib/analytics.ts` does not already build: session
 * rows, the single-day timeline and task list items. Pure: no I/O, no clock, no ambient time zone
 * (callers pass `today`, `nowMs` and the reporting zone). No JSX and no `@studio-pulse/ui` entry
 * import, so unit tests can import this file.
 */

import { formatDuration, localDayKey } from '@studio-pulse/time-engine';
import { timelineTicks, timelineWindow } from '@studio-pulse/ui/scales';
import { OTHER_COLOR } from '@studio-pulse/ui/seriesColors';

import { UNATTRIBUTED_LABEL, formatDayRange } from '../../lib/analytics';
import type { ReportLabels } from '../../lib/analytics';
import type { MySession } from '../../lib/api';
import type { Problem } from '../../lib/errors';
import type { Project, Task, TaskStatus } from '../../lib/model';
import { formatLocation } from '../../lib/router';
import type { Route } from '../../lib/router';

// ---------------------------------------------------------------------------------------------
// States shared by the cards
// ---------------------------------------------------------------------------------------------

/** One independent data source of a card: its first load, its failure and how to retry it. */
export interface SourceState {
  /** No data yet (first load): the card shows `SkeletonLines`. */
  readonly loading: boolean;
  /** The last read failed: the card shows a `ProblemBanner` (above the data it still has). */
  readonly problem?: Problem | null | undefined;
  readonly onRetry?: (() => void) | undefined;
}

// ---------------------------------------------------------------------------------------------
// Clock text in the reporting zone
// ---------------------------------------------------------------------------------------------

const LOCALE = 'en-GB';
const clockFormats = new Map<string, Intl.DateTimeFormat>();

function clockFormat(timeZone: string): Intl.DateTimeFormat {
  let format = clockFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat(LOCALE, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    clockFormats.set(timeZone, format);
  }
  return format;
}

/** "09:05" in the zone (24-hour). */
export function clockText(ms: number, timeZone: string): string {
  return clockFormat(timeZone).format(ms);
}

// ---------------------------------------------------------------------------------------------
// Recent sessions (the viewer's own rows only)
// ---------------------------------------------------------------------------------------------

export interface SessionRow {
  readonly id: string;
  readonly application: string;
  readonly kind: 'active' | 'idle';
  /** The local day the session started (`YYYY-MM-DD`) and its label ("12 Nov"). */
  readonly day: string;
  readonly dayLabel: string;
  /** Local start and end ("09:05"), in the reporting zone. */
  readonly startText: string;
  readonly endText: string;
  /** The end's day label when the session ends on another local day, else null. */
  readonly endDayLabel: string | null;
  /** The whole session (active + idle), not clipped to the range. */
  readonly durationMs: number;
  /** "Project › Task", or "Unattributed". */
  readonly work: string;
  readonly unattributed: boolean;
}

/** Rows for the Recent sessions table, in the order given (newest first from the API). */
export function sessionRows(
  sessions: readonly MySession[],
  labels: Pick<ReportLabels, 'project' | 'task'>,
  options: { readonly timeZone: string; readonly today: string },
): SessionRow[] {
  const { timeZone, today } = options;
  return sessions.map((session) => {
    const startMs = Date.parse(session.started_at);
    const endMs = Date.parse(session.ended_at);
    const day = localDayKey(startMs, timeZone);
    const endDay = localDayKey(endMs, timeZone);
    const unattributed = session.project_id === null && session.task_id === null;
    const parts: string[] = [];
    if (!unattributed) {
      parts.push(labels.project(session.project_id, false).label);
      if (session.task_id !== null) parts.push(labels.task(session.task_id, session.project_id).label);
    }
    return {
      id: session.id,
      application: session.application_name,
      kind: session.kind === 'idle' ? 'idle' : 'active',
      day,
      dayLabel: formatDayRange(day, day, today),
      startText: clockText(startMs, timeZone),
      endText: clockText(endMs, timeZone),
      endDayLabel: endDay === day ? null : formatDayRange(endDay, endDay, today),
      durationMs: session.active_ms + session.idle_ms,
      work: unattributed ? UNATTRIBUTED_LABEL : parts.join(' › '),
      unattributed,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Single-day timeline (structurally the `TimelineStrip` props)
// ---------------------------------------------------------------------------------------------

export interface DayTimelineItem {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly color: string;
  readonly variant: 'solid' | 'hatched';
  readonly tooltip: {
    readonly title: string;
    readonly subtitle?: string;
    readonly rows: ReadonlyArray<{ readonly id: string; readonly label: string; readonly value: string }>;
  };
}

export interface DayTimeline {
  /** The visible window: fitted to the recorded hours, at least 4 h, inside the day. */
  readonly startMs: number;
  readonly endMs: number;
  readonly items: readonly DayTimelineItem[];
  readonly ticks: ReadonlyArray<{ readonly ms: number; readonly label: string }>;
  /** "Now", when it falls inside the day. */
  readonly nowMs: number | null;
  /** The applications drawn, in first-seen order, for the legend. */
  readonly applications: ReadonlyArray<{ readonly id: string; readonly label: string; readonly color: string }>;
}

/**
 * The viewer's day as a timeline: each session clipped to [dayStartMs, dayEndMs), coloured by its
 * application (`applicationColors`), idle hatched. Sessions are drawn as recorded; overlapping
 * time from several devices is reconciled in the totals, not here.
 */
export function dayTimeline(
  sessions: readonly MySession[],
  options: {
    readonly dayStartMs: number;
    readonly dayEndMs: number;
    readonly timeZone: string;
    readonly nowMs: number | null;
    readonly colors: ReadonlyMap<string, string>;
  },
): DayTimeline {
  const { dayStartMs, dayEndMs, timeZone, colors } = options;
  const nowMs = options.nowMs !== null && options.nowMs >= dayStartMs && options.nowMs < dayEndMs ? options.nowMs : null;
  const items: DayTimelineItem[] = [];
  const applications = new Map<string, { id: string; label: string; color: string }>();
  for (const session of sessions) {
    const startMs = Math.max(Date.parse(session.started_at), dayStartMs);
    const endMs = Math.min(Date.parse(session.ended_at), dayEndMs);
    if (!(endMs > startMs)) continue;
    const color = colors.get(session.application_id) ?? OTHER_COLOR;
    if (!applications.has(session.application_id)) {
      applications.set(session.application_id, { id: session.application_id, label: session.application_name, color });
    }
    const idle = session.kind === 'idle';
    items.push({
      id: session.id,
      startMs,
      endMs,
      color,
      variant: idle ? 'hatched' : 'solid',
      tooltip: {
        title: session.application_name,
        subtitle: `${clockText(startMs, timeZone)}–${clockText(endMs, timeZone)}`,
        rows: [{ id: 'kind', label: idle ? 'Idle' : 'Active', value: formatDuration(endMs - startMs) }],
      },
    });
  }
  items.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const window = timelineWindow(dayStartMs, dayEndMs, items, nowMs);
  const ticks = timelineTicks(window.startMs, window.endMs, dayStartMs).map((ms) => ({ ms, label: clockText(ms, timeZone) }));
  return { startMs: window.startMs, endMs: window.endMs, items, ticks, nowMs, applications: [...applications.values()] };
}

// ---------------------------------------------------------------------------------------------
// Task lists (upcoming deadlines, awaiting review, overdue)
// ---------------------------------------------------------------------------------------------

export interface TaskListItem {
  readonly id: string;
  readonly title: string;
  /** The task's project, or null for a task without one (or where the project is the page itself). */
  readonly projectLabel: string | null;
  /** `YYYY-MM-DD`, or null. */
  readonly due: string | null;
  readonly status: TaskStatus;
  /** Opens the task as a panel over `route`. */
  readonly href: string;
}

/** Items for a task list card, in the order given. `route` is the page the task panel opens over. */
export function taskListItems(
  tasks: readonly Pick<Task, 'id' | 'title' | 'due_date' | 'status' | 'project_id'>[],
  projects: readonly Pick<Project, 'id' | 'name'>[] | null,
  route: Route,
): TaskListItem[] {
  const names = new Map((projects ?? []).map((project) => [project.id, project.name]));
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    projectLabel: task.project_id !== null ? (names.get(task.project_id) ?? null) : null,
    due: task.due_date,
    status: task.status,
    href: formatLocation({ route, taskId: task.id }),
  }));
}
