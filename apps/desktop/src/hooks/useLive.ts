import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type {
  AppInfo,
  ApplicationDefinition,
  Settings,
  SettingsPatch,
  TrackerStatus,
} from '@studio-pulse/shared-types';
import { currentTimeZone, localDayKey } from '@studio-pulse/time-engine';
import { validateSettingsPatch } from '@studio-pulse/validation';
import { ApiError, call, toCommandError } from '../lib/api';
import type { LiveResource, ResourceState } from '../lib/resource';
import { appInfoStore, applicationsStore, settingsStore, trackerStatusStore } from '../lib/stores';

function useResource<T>(resource: LiveResource<T>): ResourceState<T> {
  return useSyncExternalStore(resource.subscribe, resource.getSnapshot);
}

// ---------------------------------------------------------------------------------------------
// Page visibility & clocks
// ---------------------------------------------------------------------------------------------

function subscribeVisibility(listener: () => void) {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === 'visible');
}

/**
 * Current time, re-rendering the calling component every `intervalMs` while the window is
 * visible (never while hidden). `phaseMs` aligns ticks, e.g. to a counter's start so a clock
 * display advances exactly once per second.
 */
export function useNow(intervalMs: number, phaseMs = 0): number {
  const visible = usePageVisible();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    let timer: number | undefined;
    const schedule = () => {
      const current = Date.now();
      const offset = (((current - phaseMs) % intervalMs) + intervalMs) % intervalMs;
      timer = window.setTimeout(tick, intervalMs - offset + 15);
    };
    const tick = () => {
      setNow(Date.now());
      schedule();
    };
    setNow(Date.now());
    schedule();
    return () => window.clearTimeout(timer);
  }, [intervalMs, phaseMs, visible]);
  return now;
}

export interface TodayInfo {
  /** Local `YYYY-MM-DD`. */
  dayKey: string;
  /** When `dayKey` was last computed (a stable anchor for range resolution). */
  anchorMs: number;
  timeZone: string;
}

function computeToday(): TodayInfo {
  const timeZone = currentTimeZone();
  const anchorMs = Date.now();
  return { dayKey: localDayKey(anchorMs, timeZone), anchorMs, timeZone };
}

/** The local day, updated only when the date (or the time zone) changes. */
export function useToday(): TodayInfo {
  const [today, setToday] = useState<TodayInfo>(computeToday);
  useEffect(() => {
    const check = () =>
      setToday((previous) => {
        const next = computeToday();
        return next.dayKey === previous.dayKey && next.timeZone === previous.timeZone ? previous : next;
      });
    const id = window.setInterval(check, 30_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  return today;
}

// ---------------------------------------------------------------------------------------------
// Tracker status
// ---------------------------------------------------------------------------------------------

export function useTrackerStatus(): ResourceState<TrackerStatus> & { reload: () => Promise<void> } {
  const state = useResource(trackerStatusStore);
  return { ...state, reload: trackerStatusStore.reload };
}

export interface TrackerActions {
  pause: (minutes: number | null) => Promise<void>;
  resume: () => Promise<void>;
  pending: boolean;
  error: ApiError | null;
  clearError: () => void;
}

/** Pause / resume. The confirmed `TrackerStatus` result replaces the shared status. */
export function useTrackerActions(): TrackerActions {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const run = useCallback(async (action: () => Promise<TrackerStatus>) => {
    setPending(true);
    setError(null);
    try {
      trackerStatusStore.set(await action());
    } catch (caught) {
      setError(toCommandError(caught));
    } finally {
      setPending(false);
    }
  }, []);

  return {
    pause: useCallback((minutes: number | null) => run(() => call('pause_tracking', { minutes })), [run]),
    resume: useCallback(() => run(() => call('resume_tracking')), [run]),
    pending,
    error,
    clearError: useCallback(() => setError(null), []),
  };
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export interface SettingsHook extends ResourceState<Settings> {
  reload: () => Promise<void>;
  /** Validate, apply and return the confirmed settings. Rejects with `ApiError`. */
  update: (patch: SettingsPatch) => Promise<Settings>;
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const checked = validateSettingsPatch(patch);
  if (!checked.ok) throw new ApiError('validation', checked.issues.join(' '));
  const next = await call('update_settings', { patch: checked.value });
  settingsStore.set(next);
  return next;
}

export function useSettings(): SettingsHook {
  const state = useResource(settingsStore);
  return { ...state, reload: settingsStore.reload, update: updateSettings };
}

/** Write a settings value obtained elsewhere (e.g. `complete_onboarding`'s result). */
export function storeSettings(settings: Settings): void {
  settingsStore.set(settings);
}

// ---------------------------------------------------------------------------------------------
// Applications & app info
// ---------------------------------------------------------------------------------------------

export function useApplications(): ResourceState<ApplicationDefinition[]> & {
  reload: () => Promise<void>;
  /** Merge one confirmed definition (a `save_application` result) into the list. */
  upsert: (application: ApplicationDefinition) => void;
  replaceAll: (applications: ApplicationDefinition[]) => void;
  remove: (id: string) => void;
} {
  const state = useResource(applicationsStore);
  return {
    ...state,
    reload: applicationsStore.reload,
    upsert: (application) => {
      const current = applicationsStore.getSnapshot().data ?? [];
      const exists = current.some((item) => item.id === application.id);
      applicationsStore.set(
        exists ? current.map((item) => (item.id === application.id ? application : item)) : [...current, application],
      );
    },
    replaceAll: (applications) => applicationsStore.set(applications),
    remove: (id) => {
      const current = applicationsStore.getSnapshot().data ?? [];
      applicationsStore.set(current.filter((item) => item.id !== id));
    },
  };
}

export function useAppInfo(): ResourceState<AppInfo> & { reload: () => Promise<void> } {
  const state = useResource(appInfoStore);
  return { ...state, reload: appInfoStore.reload };
}
