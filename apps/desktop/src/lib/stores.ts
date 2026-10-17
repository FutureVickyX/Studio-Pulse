/**
 * The shared native-state stores. Each window (main, indicator) has its own instances.
 * A store makes no call until something subscribes, so the indicator window (which is not
 * granted the account and sync commands) never touches the Phase 2A stores.
 */

import type {
  AccountStatus,
  AppInfo,
  ApplicationDefinition,
  Settings,
  SyncOverview,
  TrackerStatus,
} from '@studio-pulse/shared-types';
import { call, subscribe } from './api';
import { createLiveResource } from './resource';

export const trackerStatusStore = createLiveResource<TrackerStatus>({
  load: () => call('get_tracker_status'),
  listen: (set) => subscribe('tracker://status', set),
});

export const settingsStore = createLiveResource<Settings>({
  load: () => call('get_settings'),
  listen: (set) => subscribe('settings://changed', set),
});

export const applicationsStore = createLiveResource<ApplicationDefinition[]>({
  load: () => call('list_applications'),
  listen: (set) => subscribe('applications://changed', set),
});

export const appInfoStore = createLiveResource<AppInfo>({
  load: () => call('get_app_info'),
});

// Phase 2A — account and sync (main window only)

export const accountStore = createLiveResource<AccountStatus>({
  load: () => call('get_account_status'),
  listen: (set) => subscribe('account://changed', set),
});

export const syncStatusStore = createLiveResource<SyncOverview>({
  load: () => call('get_sync_status'),
  listen: (set, reload) => {
    const stopEvents = subscribe('sync://status', set);
    // Events cover changes made by the sync thread; refetching when the window regains focus
    // also refreshes counts after a long time in the tray (the overview is an in-memory read).
    const onFocus = () => reload();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') reload();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopEvents();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  },
});
