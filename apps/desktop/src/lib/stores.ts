/**
 * The shared native-state stores. Each window (main, indicator) has its own instances.
 */

import type { AppInfo, ApplicationDefinition, Settings, TrackerStatus } from '@studio-pulse/shared-types';
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
