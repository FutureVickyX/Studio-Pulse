import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from '@studio-pulse/shared-types';
import type { Settings } from '@studio-pulse/shared-types';
import { validateSettings, validateSettingsPatch } from '@studio-pulse/validation';
import type { ValidationResult } from '@studio-pulse/validation';

function issuesOf<T>(result: ValidationResult<T>): string[] {
  return result.ok ? [] : result.issues;
}

/** A deep copy of the defaults with one tracking field replaced. */
function withTracking(field: keyof Settings['tracking'], value: unknown): unknown {
  return { ...DEFAULT_SETTINGS, tracking: { ...DEFAULT_SETTINGS.tracking, [field]: value } };
}

const NUMERIC_FIELDS = ['idleTimeoutMinutes', 'checkpointSeconds', 'minimumIntervalSeconds'] as const;

describe('validateSettings', () => {
  it('accepts DEFAULT_SETTINGS unchanged', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual({ ok: true, value: DEFAULT_SETTINGS });
  });

  it('accepts a completed onboarding with an ISO timestamp', () => {
    const settings = { ...DEFAULT_SETTINGS, onboarding: { completed: true, completedAt: '2026-10-13T09:15:00.000Z' } };
    expect(validateSettings(settings)).toEqual({ ok: true, value: settings });
    expect(
      validateSettings({ ...DEFAULT_SETTINGS, onboarding: { completed: true, completedAt: '2026-10-13T10:15:00+01:00' } }).ok,
    ).toBe(true);
  });

  it('rejects a completedAt that is not an ISO date-time', () => {
    for (const completedAt of ['yesterday', '2026-10-13', '', 1760346900000]) {
      const result = validateSettings({ ...DEFAULT_SETTINGS, onboarding: { completed: true, completedAt } });
      expect(result.ok, String(completedAt)).toBe(false);
      expect(issuesOf(result)[0]).toMatch(/^onboarding\.completedAt: /);
    }
  });

  it.each(NUMERIC_FIELDS)('enforces SETTINGS_LIMITS.%s inclusively', (field) => {
    const { min, max } = SETTINGS_LIMITS[field];
    expect(validateSettings(withTracking(field, min)).ok).toBe(true);
    expect(validateSettings(withTracking(field, max)).ok).toBe(true);
    const message = `tracking.${field}: must be a whole number between ${min} and ${max}`;
    expect(issuesOf(validateSettings(withTracking(field, min - 1)))).toEqual([message]);
    expect(issuesOf(validateSettings(withTracking(field, max + 1)))).toEqual([message]);
    expect(issuesOf(validateSettings(withTracking(field, min + 0.5)))).toEqual([message]);
  });

  it('rejects numbers sent as strings and non-finite numbers', () => {
    expect(validateSettings(withTracking('idleTimeoutMinutes', '5')).ok).toBe(false);
    expect(validateSettings(withTracking('idleTimeoutMinutes', Number.NaN)).ok).toBe(false);
    expect(validateSettings(withTracking('checkpointSeconds', Number.POSITIVE_INFINITY)).ok).toBe(false);
  });

  it('requires a known theme', () => {
    for (const theme of ['dark', 'light', 'system']) {
      expect(validateSettings({ ...DEFAULT_SETTINGS, general: { ...DEFAULT_SETTINGS.general, theme } }).ok).toBe(true);
    }
    expect(issuesOf(validateSettings({ ...DEFAULT_SETTINGS, general: { ...DEFAULT_SETTINGS.general, theme: 'blue' } }))).toEqual([
      'general.theme: must be one of: dark, light, system',
    ]);
  });

  it('requires the full document', () => {
    const { tracking: _tracking, ...withoutTracking } = DEFAULT_SETTINGS;
    expect(issuesOf(validateSettings(withoutTracking))).toEqual(['tracking: is required']);
    const { notifications: _notifications, ...trackingWithoutNotifications } = DEFAULT_SETTINGS.tracking;
    expect(issuesOf(validateSettings({ ...DEFAULT_SETTINGS, tracking: trackingWithoutNotifications }))).toEqual([
      'tracking.notifications: is required',
    ]);
    expect(issuesOf(validateSettings({ ...DEFAULT_SETTINGS, onboarding: { completed: false } }))).toEqual([
      'onboarding.completedAt: is required',
    ]);
    expect(validateSettings(null).ok).toBe(false);
  });

  it('drops unknown fields from the parsed value instead of failing (stored documents are read leniently)', () => {
    const result = validateSettings({ ...DEFAULT_SETTINGS, futureField: 1, general: { ...DEFAULT_SETTINGS.general, x: true } });
    expect(result).toEqual({ ok: true, value: DEFAULT_SETTINGS });
  });
});

describe('validateSettingsPatch', () => {
  it('accepts empty and partial patches unchanged', () => {
    for (const patch of [
      {},
      { general: {} },
      { general: { theme: 'light' } },
      { tracking: { idleTimeoutMinutes: 10, pauseWhenIdle: false } },
      { general: { startMinimized: false, minimizeToTray: false }, tracking: { minimumIntervalSeconds: 0 } },
    ]) {
      expect(validateSettingsPatch(patch)).toEqual({ ok: true, value: patch });
    }
  });

  it('rejects unknown keys at every level', () => {
    expect(issuesOf(validateSettingsPatch({ tracking: { bogus: true } }))).toEqual(['tracking: unknown field "bogus"']);
    expect(issuesOf(validateSettingsPatch({ general: { theme: 'dark', font: 'x' } }))).toEqual(['general: unknown field "font"']);
    expect(issuesOf(validateSettingsPatch({ privacy: {} }))).toEqual(['unknown field "privacy"']);
  });

  it('rejects onboarding (it changes only through complete_onboarding)', () => {
    expect(issuesOf(validateSettingsPatch({ onboarding: { completed: true } }))).toEqual(['unknown field "onboarding"']);
    expect(validateSettingsPatch({ onboarding: {} }).ok).toBe(false);
  });

  it.each(NUMERIC_FIELDS)('enforces whole numbers inside SETTINGS_LIMITS.%s', (field) => {
    const { min, max } = SETTINGS_LIMITS[field];
    const message = `tracking.${field}: must be a whole number between ${min} and ${max}`;
    expect(validateSettingsPatch({ tracking: { [field]: min } }).ok).toBe(true);
    expect(validateSettingsPatch({ tracking: { [field]: max } }).ok).toBe(true);
    expect(issuesOf(validateSettingsPatch({ tracking: { [field]: min - 1 } }))).toEqual([message]);
    expect(issuesOf(validateSettingsPatch({ tracking: { [field]: max + 1 } }))).toEqual([message]);
    expect(issuesOf(validateSettingsPatch({ tracking: { [field]: min + 0.5 } }))).toEqual([message]);
  });

  it('rejects wrong types and nulls', () => {
    expect(issuesOf(validateSettingsPatch({ general: { theme: 'blue' } }))).toEqual([
      'general.theme: must be one of: dark, light, system',
    ]);
    expect(issuesOf(validateSettingsPatch({ tracking: { enabled: 'false' } }))).toEqual(['tracking.enabled: must be true or false']);
    expect(validateSettingsPatch({ tracking: { idleTimeoutMinutes: null } }).ok).toBe(false);
    expect(validateSettingsPatch({ general: null }).ok).toBe(false);
    expect(validateSettingsPatch(null).ok).toBe(false);
    expect(validateSettingsPatch([]).ok).toBe(false);
  });

  it('collects every issue in one result', () => {
    const result = validateSettingsPatch({ general: { theme: 'x' }, tracking: { checkpointSeconds: 1, bogus: 1 } });
    expect(issuesOf(result)).toHaveLength(3);
  });
});
