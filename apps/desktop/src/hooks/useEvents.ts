import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TimeRangeInput, TrackingEvent } from '@studio-pulse/shared-types';
import type { DateRange, RangePreset, UsageSummary } from '@studio-pulse/time-engine';
import { resolveRange, summarize } from '@studio-pulse/time-engine';
import { call, subscribe, toCommandError } from '../lib/api';
import type { ApiError } from '../lib/api';
import { trackerStatusStore } from '../lib/stores';
import { UI_LOCALE } from '../lib/format';
import { useApplications, useToday } from './useLive';

/** Poll while visible, so open intervals and day totals stay current between events. */
const POLL_MS = 15_000;
/** Coalesce bursts of change notifications. */
const DEBOUNCE_MS = 250;

export interface EventsState {
  events: TrackingEvent[] | undefined;
  /** The range `events` were fetched for (may lag the requested range while loading). */
  fetchedRange: TimeRangeInput | null;
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
}

function sameRange(a: TimeRangeInput | null, b: TimeRangeInput | null): boolean {
  return !!a && !!b && a.fromMs === b.fromMs && a.toMs === b.toMs;
}

function statusSignature(): string {
  const status = trackerStatusStore.getSnapshot().data;
  if (!status) return '';
  return `${status.state}|${status.current?.eventId ?? ''}|${status.current?.kind ?? ''}`;
}

/**
 * Tracking events overlapping `range`. Refetches when the range changes, on
 * `tracker://events-changed`, when the tracker status changes, and every 15 s while visible.
 * Previous data stays available while a refetch runs.
 */
export function useEvents(range: TimeRangeInput | null): EventsState {
  const [state, setState] = useState<Omit<EventsState, 'reload'>>({
    events: undefined,
    fetchedRange: null,
    loading: range !== null,
    error: null,
  });
  const requestSeq = useRef(0);
  const lastFetchAt = useRef(0);
  const debounceTimer = useRef<number | undefined>(undefined);
  const fromMs = range?.fromMs ?? null;
  const toMs = range?.toMs ?? null;

  const fetchNow = useCallback(async () => {
    if (fromMs === null || toMs === null) return;
    const target: TimeRangeInput = { fromMs, toMs };
    const seq = ++requestSeq.current;
    lastFetchAt.current = Date.now();
    setState((previous) => (previous.loading ? previous : { ...previous, loading: true }));
    try {
      const events = await call('list_tracking_events', { range: target });
      if (seq !== requestSeq.current) return;
      setState({ events, fetchedRange: target, loading: false, error: null });
    } catch (caught) {
      if (seq !== requestSeq.current) return;
      setState((previous) => ({ ...previous, loading: false, error: toCommandError(caught) }));
    }
  }, [fromMs, toMs]);

  const schedule = useCallback(() => {
    window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => void fetchNow(), DEBOUNCE_MS);
  }, [fetchNow]);

  // Range changes: fetch immediately.
  useEffect(() => {
    void fetchNow();
    return () => window.clearTimeout(debounceTimer.current);
  }, [fetchNow]);

  // Push notifications from the tracker.
  useEffect(() => {
    if (fromMs === null) return;
    const stopEvents = subscribe('tracker://events-changed', schedule);
    let signature = statusSignature();
    const stopStatus = trackerStatusStore.subscribe(() => {
      const next = statusSignature();
      if (next !== signature) {
        signature = next;
        schedule();
      }
    });
    return () => {
      stopEvents();
      stopStatus();
    };
  }, [fromMs, schedule]);

  // Visible-only polling; refresh on becoming visible again.
  useEffect(() => {
    if (fromMs === null) return;
    const poll = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastFetchAt.current < POLL_MS - 1_000) return;
      void fetchNow();
    };
    const id = window.setInterval(poll, POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') schedule();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fromMs, fetchNow, schedule]);

  return { ...state, reload: () => void fetchNow() };
}

// ---------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------

export interface ReportOptions {
  customStart?: string;
  customEnd?: string;
  includeExcluded?: boolean;
}

export interface ReportState {
  /** The requested range (null when it could not be resolved). */
  range: DateRange | null;
  /** Summary for the most recently fetched range; may belong to the previous range while `stale`. */
  summary: UsageSummary | null;
  events: TrackingEvent[] | undefined;
  /** First load, nothing to show yet. */
  loading: boolean;
  /** Showing previous data while a refetch or range change completes. */
  stale: boolean;
  error: ApiError | null;
  reload: () => void;
  timeZone: string;
  /** Anchor "now" used to resolve the range. */
  anchorMs: number;
}

/** resolveRange → list_tracking_events → summarize, in the user's local time zone. */
export function useReport(preset: RangePreset, options: ReportOptions = {}): ReportState {
  const today = useToday();
  const applications = useApplications();
  const { customStart, customEnd, includeExcluded = false } = options;

  const resolved = useMemo((): { range: DateRange | null; error: ApiError | null } => {
    if (preset === 'custom' && (!customStart || !customEnd)) return { range: null, error: null };
    try {
      return {
        range: resolveRange(preset, {
          now: today.anchorMs,
          timeZone: today.timeZone,
          customStart,
          customEnd,
          locale: UI_LOCALE,
        }),
        error: null,
      };
    } catch (caught) {
      return { range: null, error: toCommandError(caught) };
    }
    // `today.dayKey` (not the anchor) is the dependency: presets re-resolve at local midnight.
  }, [preset, customStart, customEnd, today.dayKey, today.timeZone]);

  const range = resolved.range;
  const timeRange = useMemo<TimeRangeInput | null>(
    () => (range ? { fromMs: range.startMs, toMs: range.endMs } : null),
    [range],
  );
  const events = useEvents(timeRange);

  // Keep the DateRange that matches the fetched events (the previous one while a new range loads).
  const rangesByKey = useRef(new Map<string, DateRange>());
  if (range) {
    const key = `${range.startMs}:${range.endMs}`;
    if (!rangesByKey.current.has(key)) {
      if (rangesByKey.current.size > 4) rangesByKey.current.clear();
      rangesByKey.current.set(key, range);
    }
  }
  const fetchedDateRange = events.fetchedRange
    ? rangesByKey.current.get(`${events.fetchedRange.fromMs}:${events.fetchedRange.toMs}`) ?? null
    : null;

  const computed = useMemo((): { summary: UsageSummary | null; error: ApiError | null } => {
    if (!events.events || !fetchedDateRange || !applications.data) return { summary: null, error: null };
    try {
      return {
        summary: summarize(events.events, {
          range: fetchedDateRange,
          applications: applications.data,
          includeExcluded,
        }),
        error: null,
      };
    } catch (caught) {
      return { summary: null, error: toCommandError(caught) };
    }
  }, [events.events, fetchedDateRange, applications.data, includeExcluded]);

  const current = sameRange(events.fetchedRange, timeRange);
  const error = resolved.error ?? events.error ?? applications.error ?? computed.error;

  return {
    range,
    summary: computed.summary,
    events: events.events,
    loading: computed.summary === null && error === null && range !== null,
    // Only a range change dims the frame; background refreshes swap data in silently.
    stale: computed.summary !== null && !current,
    error,
    reload: () => {
      events.reload();
      if (applications.error) void applications.reload();
    },
    timeZone: today.timeZone,
    anchorMs: today.anchorMs,
  };
}
