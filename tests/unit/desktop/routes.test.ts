import { describe, expect, it } from 'vitest';
import type { Route } from '@studio-pulse/shared-types';

import {
  isRoute,
  isSectionAvailable,
  NAV_ITEMS,
  navItemForDigit,
  resolveNavigation,
  sectionOf,
  SETTINGS_TABS,
  settingsRoute,
  settingsTabOf,
} from '../../../apps/desktop/src/lib/routes';

/** Every `Route` in shared-types (the `app://navigate` contract). */
const ALL_ROUTES: readonly Route[] = [
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
];

describe('NAV_ITEMS', () => {
  it('is Home, Tasks, Notes, Projects, Time, Team, Settings on Ctrl+1…7 (architecture §12)', () => {
    expect(NAV_ITEMS.map((item) => [item.section, item.digit])).toEqual([
      ['home', 1],
      ['tasks', 2],
      ['notes', 3],
      ['projects', 4],
      ['time', 5],
      ['team', 6],
      ['settings', 7],
    ]);
  });

  it('marks only Home, Time and Settings available in Phase 1', () => {
    expect(NAV_ITEMS.filter((item) => item.available).map((item) => item.section)).toEqual(['home', 'time', 'settings']);
  });
});

describe('isRoute', () => {
  it.each(ALL_ROUTES)('accepts %s', (route) => {
    expect(isRoute(route)).toBe(true);
  });

  it.each([['settings/unknown'], ['Home'], [''], ['/home'], ['settings/'], [null], [undefined], [7], [{ route: 'home' }]])(
    'rejects %o (untrusted navigate payloads)',
    (value) => {
      expect(isRoute(value)).toBe(false);
    },
  );
});

describe('sectionOf / settingsTabOf / settingsRoute', () => {
  it('takes the section from the first path segment', () => {
    expect(sectionOf('home')).toBe('home');
    expect(sectionOf('time')).toBe('time');
    expect(sectionOf('settings')).toBe('settings');
    expect(sectionOf('settings/privacy')).toBe('settings');
  });

  it('opens General for bare settings and null outside settings', () => {
    expect(settingsTabOf('settings')).toBe('general');
    expect(settingsTabOf('settings/about')).toBe('about');
    expect(settingsTabOf('settings/applications')).toBe('applications');
    expect(settingsTabOf('home')).toBeNull();
    expect(settingsTabOf('time')).toBeNull();
  });

  it('builds a valid route for every settings tab, and round-trips it', () => {
    for (const { tab } of SETTINGS_TABS) {
      const route = settingsRoute(tab);
      expect(isRoute(route)).toBe(true);
      expect(settingsTabOf(route)).toBe(tab);
    }
  });
});

describe('isSectionAvailable', () => {
  it.each([
    ['home', true],
    ['tasks', false],
    ['notes', false],
    ['projects', false],
    ['time', true],
    ['team', false],
    ['settings', true],
  ] as const)('%s → %s', (section, available) => {
    expect(isSectionAvailable(section)).toBe(available);
  });
});

describe('resolveNavigation', () => {
  it('goes to available sections', () => {
    expect(resolveNavigation('home', 'time')).toBe('time');
    expect(resolveNavigation('time', 'home')).toBe('home');
    expect(resolveNavigation('home', 'settings/privacy')).toBe('settings/privacy');
  });

  it('opens the General tab for bare settings', () => {
    expect(resolveNavigation('home', 'settings')).toBe('settings/general');
  });

  it.each(['tasks', 'notes', 'projects', 'team'] as const)('keeps the current route for Phase-2 %s', (requested) => {
    expect(resolveNavigation('time', requested)).toBe('time');
    expect(resolveNavigation('settings/about', requested)).toBe('settings/about');
  });

  it('allows the Phase-2 settings tabs, which explain what is coming', () => {
    expect(resolveNavigation('home', 'settings/workspace')).toBe('settings/workspace');
    expect(resolveNavigation('home', 'settings/sync')).toBe('settings/sync');
  });

  it('never resolves to an unavailable section, from any route', () => {
    for (const current of ALL_ROUTES.filter((route) => isSectionAvailable(sectionOf(route)))) {
      for (const requested of ALL_ROUTES) {
        expect(isSectionAvailable(sectionOf(resolveNavigation(current, requested)))).toBe(true);
      }
    }
  });
});

describe('navItemForDigit', () => {
  it('finds the item for 1…7', () => {
    for (let digit = 1; digit <= 7; digit += 1) {
      expect(navItemForDigit(digit)?.digit).toBe(digit);
    }
  });

  it('returns undefined for other digits', () => {
    expect(navItemForDigit(0)).toBeUndefined();
    expect(navItemForDigit(8)).toBeUndefined();
    expect(navItemForDigit(9)).toBeUndefined();
  });
});
