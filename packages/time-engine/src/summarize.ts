/**
 * Report aggregation: normalize → resolveOverlaps → clip to range → split by local day → aggregate.
 *
 * All arithmetic is on integer milliseconds, so every breakdown (per application, category, day,
 * week, project and the timeline) sums exactly to `totals`.
 */

import { APP_CATEGORY_LABELS } from '@studio-pulse/shared-types';
import type { AppCategory, ApplicationDefinition, TrackingEvent } from '@studio-pulse/shared-types';

import { isoWeekStart } from './days';
import { clipInterval, normalizeEvents, resolveOverlaps, splitByLocalDay } from './intervals';
import type {
  ApplicationUsage,
  CategoryUsage,
  DayUsage,
  NormalizedInterval,
  ProjectUsage,
  SummarizeOptions,
  TimelineSegment,
  UsageSummary,
  UsageTotals,
  WeekUsage,
} from './types';

/** Fixed locale so ordering never depends on the runtime's default locale. */
const nameCollator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function emptyTotals(): UsageTotals {
  return { foregroundMs: 0, activeMs: 0, idleMs: 0 };
}

function addTo(target: UsageTotals, interval: NormalizedInterval): void {
  target.foregroundMs += interval.endMs - interval.startMs;
  target.activeMs += interval.activeMs;
  target.idleMs += interval.idleMs;
}

function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/** Most active first; equal active time falls back to `tieBreak` (a name order). */
function byActiveThen<T extends UsageTotals>(tieBreak: (a: T, b: T) => number): (a: T, b: T) => number {
  return (a, b) => b.activeMs - a.activeMs || tieBreak(a, b);
}

interface ApplicationAccumulator {
  totals: UsageTotals;
  name: string;
  category: AppCategory;
}

/** normalize → resolveOverlaps → clip to range → split by local day → aggregate. */
export function summarize(events: readonly TrackingEvent[], options: SummarizeOptions): UsageSummary {
  const { range } = options;
  const includeExcluded = options.includeExcluded ?? false;
  const applications = new Map<string, ApplicationDefinition>();
  for (const app of options.applications) applications.set(app.id, app);

  const normalized = normalizeEvents(events);
  const { intervals } = resolveOverlaps(normalized);

  // Overlap removed inside the range. Overlap resolution only ever trims the start of an interval
  // (or drops it), so the in-range time it removed is exactly raw in-range time minus resolved
  // in-range time. Overlap outside the range does not concern this report.
  let rawInRangeMs = 0;
  for (const interval of normalized) {
    rawInRangeMs += Math.max(0, Math.min(interval.endMs, range.endMs) - Math.max(interval.startMs, range.startMs));
  }
  let resolvedInRangeMs = 0;

  // Clip to the range and apply report exclusion.
  const included: NormalizedInterval[] = [];
  const excluded = new Set<string>();
  for (const interval of intervals) {
    const clipped = clipInterval(interval, range.startMs, range.endMs);
    if (!clipped) continue;
    resolvedInRangeMs += clipped.endMs - clipped.startMs;
    const app = applications.get(clipped.applicationId);
    if (app && !app.includeInReports && !includeExcluded) {
      excluded.add(app.id);
      continue;
    }
    included.push(clipped);
  }

  // Totals, per application, per category, per project, timeline.
  const totals = emptyTotals();
  const perApplication = new Map<string, ApplicationAccumulator>();
  const perCategory = new Map<AppCategory, UsageTotals>();
  const perProject = new Map<string | null, UsageTotals>();
  for (const interval of included) {
    addTo(totals, interval);

    const app = applications.get(interval.applicationId);
    let appEntry = perApplication.get(interval.applicationId);
    if (!appEntry) {
      appEntry = {
        totals: emptyTotals(),
        name: app ? app.displayName : interval.applicationName,
        category: app ? app.category : 'other',
      };
      perApplication.set(interval.applicationId, appEntry);
    } else if (!app) {
      // Unknown (e.g. deleted) application: use the most recent name snapshot (input is chronological).
      appEntry.name = interval.applicationName;
    }
    addTo(appEntry.totals, interval);

    let categoryEntry = perCategory.get(appEntry.category);
    if (!categoryEntry) {
      categoryEntry = emptyTotals();
      perCategory.set(appEntry.category, categoryEntry);
    }
    addTo(categoryEntry, interval);

    let projectEntry = perProject.get(interval.projectId);
    if (!projectEntry) {
      projectEntry = emptyTotals();
      perProject.set(interval.projectId, projectEntry);
    }
    addTo(projectEntry, interval);
  }

  const byApplication: ApplicationUsage[] = [...perApplication.entries()]
    .map(([applicationId, entry]) => ({
      applicationId,
      name: entry.name,
      category: entry.category,
      ...entry.totals,
      activeShare: share(entry.totals.activeMs, totals.activeMs),
    }))
    .sort(
      byActiveThen<ApplicationUsage>(
        (a, b) => nameCollator.compare(a.name, b.name) || nameCollator.compare(a.applicationId, b.applicationId),
      ),
    );

  const byCategory: CategoryUsage[] = [...perCategory.entries()]
    .map(([category, entryTotals]) => ({
      category,
      ...entryTotals,
      activeShare: share(entryTotals.activeMs, totals.activeMs),
    }))
    .sort(
      byActiveThen<CategoryUsage>((a, b) =>
        nameCollator.compare(APP_CATEGORY_LABELS[a.category] ?? a.category, APP_CATEGORY_LABELS[b.category] ?? b.category),
      ),
    );

  const byProject: ProjectUsage[] = [...perProject.entries()]
    .map(([projectId, entryTotals]) => ({ projectId, ...entryTotals }))
    .sort(
      byActiveThen<ProjectUsage>((a, b) => {
        if (a.projectId === b.projectId) return 0;
        if (a.projectId === null) return 1;
        if (b.projectId === null) return -1;
        return nameCollator.compare(a.projectId, b.projectId);
      }),
    );

  const timeline: TimelineSegment[] = included
    .map((interval) => ({
      id: interval.id,
      applicationId: interval.applicationId,
      kind: interval.kind,
      startMs: interval.startMs,
      endMs: interval.endMs,
      open: interval.open,
    }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Per local day and per ISO week.
  const dayTotals = new Map<string, { totals: UsageTotals; active: Map<string, number> }>();
  const weekTotals = new Map<string, UsageTotals>();
  const ensureDay = (day: string) => {
    let entry = dayTotals.get(day);
    if (!entry) {
      entry = { totals: emptyTotals(), active: new Map() };
      dayTotals.set(day, entry);
    }
    return entry;
  };
  const ensureWeek = (weekStart: string) => {
    let entry = weekTotals.get(weekStart);
    if (!entry) {
      entry = emptyTotals();
      weekTotals.set(weekStart, entry);
    }
    return entry;
  };
  for (const day of range.days) {
    ensureDay(day);
    ensureWeek(isoWeekStart(day));
  }
  for (const { day, interval } of splitByLocalDay(included, range.timeZone)) {
    const entry = ensureDay(day);
    addTo(entry.totals, interval);
    if (interval.activeMs > 0) {
      entry.active.set(interval.applicationId, (entry.active.get(interval.applicationId) ?? 0) + interval.activeMs);
    }
    addTo(ensureWeek(isoWeekStart(day)), interval);
  }

  // `range.days` order first; any day outside it (only possible with a hand-built, inconsistent
  // range) is appended in calendar order so totals still reconcile.
  const dayOrder = [...range.days, ...[...dayTotals.keys()].filter((day) => !range.days.includes(day)).sort()];
  const byDay: DayUsage[] = dayOrder.map((day) => {
    const entry = ensureDay(day);
    return { day, ...entry.totals, activeByApplication: Object.fromEntries(entry.active) };
  });

  const byWeek: WeekUsage[] = [...weekTotals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekStart, entryTotals]) => ({ weekStart, ...entryTotals }));

  return {
    range,
    totals,
    byApplication,
    byCategory,
    byDay,
    byWeek,
    byProject,
    timeline,
    excludedApplicationIds: [...excluded].sort(),
    intervalCount: included.length,
    overlapClippedMs: rawInRangeMs - resolvedInRangeMs,
  };
}
