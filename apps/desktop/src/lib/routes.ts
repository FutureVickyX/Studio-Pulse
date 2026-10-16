/**
 * Workspace routing (no router library): a `Route` string from shared-types is the whole state.
 * Pure helpers, unit-tested in tests/unit/desktop.
 */

import type { Route } from '@studio-pulse/shared-types';

export type Section = 'home' | 'tasks' | 'notes' | 'projects' | 'time' | 'team' | 'settings';

export type SettingsTab = 'general' | 'tracking' | 'applications' | 'privacy' | 'workspace' | 'sync' | 'about';

export interface NavItem {
  section: Section;
  label: string;
  /** False = a Phase-2 seam: shown disabled, never navigable. */
  available: boolean;
  /** Ctrl+<digit> shortcut. */
  digit: number;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { section: 'home', label: 'Home', available: true, digit: 1 },
  { section: 'tasks', label: 'Tasks', available: false, digit: 2 },
  { section: 'notes', label: 'Notes', available: false, digit: 3 },
  { section: 'projects', label: 'Projects', available: false, digit: 4 },
  { section: 'time', label: 'Time', available: true, digit: 5 },
  { section: 'team', label: 'Team', available: false, digit: 6 },
  { section: 'settings', label: 'Settings', available: true, digit: 7 },
];

export const SETTINGS_TABS: ReadonlyArray<{ tab: SettingsTab; label: string }> = [
  { tab: 'general', label: 'General' },
  { tab: 'tracking', label: 'Tracking' },
  { tab: 'applications', label: 'Applications' },
  { tab: 'privacy', label: 'Privacy' },
  { tab: 'workspace', label: 'Workspace' },
  { tab: 'sync', label: 'Sync' },
  { tab: 'about', label: 'About' },
];

const ALL_ROUTES: ReadonlySet<string> = new Set<Route>([
  'home',
  'tasks',
  'notes',
  'projects',
  'time',
  'team',
  'settings',
  'settings/general',
  'settings/tracking',
  'settings/applications',
  'settings/privacy',
  'settings/workspace',
  'settings/sync',
  'settings/about',
]);

/** Validate an untrusted value (e.g. an `app://navigate` payload). */
export function isRoute(value: unknown): value is Route {
  return typeof value === 'string' && ALL_ROUTES.has(value);
}

export function sectionOf(route: Route): Section {
  const head = route.split('/')[0];
  return (head ?? 'home') as Section;
}

export function settingsTabOf(route: Route): SettingsTab | null {
  if (!route.startsWith('settings')) return null;
  const tab = route.split('/')[1];
  return (tab as SettingsTab | undefined) ?? 'general';
}

export function settingsRoute(tab: SettingsTab): Route {
  return `settings/${tab}`;
}

export function isSectionAvailable(section: Section): boolean {
  return NAV_ITEMS.some((item) => item.section === section && item.available);
}

/**
 * Resolve a navigation request against the current route. Phase-2 sections are ignored (the
 * current route is kept); bare `settings` opens the General tab.
 */
export function resolveNavigation(current: Route, requested: Route): Route {
  const section = sectionOf(requested);
  if (!isSectionAvailable(section)) return current;
  if (requested === 'settings') return 'settings/general';
  return requested;
}

export function navItemForDigit(digit: number): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.digit === digit);
}
