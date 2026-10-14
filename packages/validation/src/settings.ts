/**
 * Settings documents and `update_settings` patches. Rules mirror
 * `apps/desktop/src-tauri/src/settings.rs`:
 *
 * - A stored `Settings` document must be complete. Unknown fields are dropped from the parsed
 *   value (Rust ignores them when reading older or newer files) rather than failing the document.
 * - A `SettingsPatch` is strict at every level (Rust: `deny_unknown_fields`). `onboarding` is not
 *   patchable: it changes only through `complete_onboarding`.
 * - Numeric fields are whole numbers inside `SETTINGS_LIMITS`.
 */

import { z } from 'zod';
import { SETTINGS_LIMITS } from '@studio-pulse/shared-types';
import type { Settings, SettingsPatch, ThemePreference } from '@studio-pulse/shared-types';

import { integerInRange, runSchema } from './issues';
import type { ValidationResult } from './issues';

/** A Record so that adding a ThemePreference in shared-types without listing it here fails to compile. */
const THEMES: Readonly<Record<ThemePreference, ThemePreference>> = {
  dark: 'dark',
  light: 'light',
  system: 'system',
};

const themeSchema = z.enum(THEMES);
const idleTimeoutMinutesSchema = integerInRange(
  SETTINGS_LIMITS.idleTimeoutMinutes.min,
  SETTINGS_LIMITS.idleTimeoutMinutes.max,
);
const checkpointSecondsSchema = integerInRange(
  SETTINGS_LIMITS.checkpointSeconds.min,
  SETTINGS_LIMITS.checkpointSeconds.max,
);
const minimumIntervalSecondsSchema = integerInRange(
  SETTINGS_LIMITS.minimumIntervalSeconds.min,
  SETTINGS_LIMITS.minimumIntervalSeconds.max,
);

/** ISO-8601 date-time with `Z` or a numeric offset, e.g. `2026-10-13T09:15:00.000Z`. */
const isoDateTimeSchema = z.iso.datetime({ offset: true });

const generalShape = {
  theme: themeSchema,
  startMinimized: z.boolean(),
  minimizeToTray: z.boolean(),
  launchFullWindowOnStartup: z.boolean(),
};

const trackingShape = {
  enabled: z.boolean(),
  startAutomatically: z.boolean(),
  pauseWhenIdle: z.boolean(),
  idleTimeoutMinutes: idleTimeoutMinutesSchema,
  notifications: z.boolean(),
  checkpointSeconds: checkpointSecondsSchema,
  minimumIntervalSeconds: minimumIntervalSecondsSchema,
};

export const settingsSchema = z.object({
  general: z.object(generalShape),
  tracking: z.object(trackingShape),
  onboarding: z.object({
    completed: z.boolean(),
    completedAt: isoDateTimeSchema.nullable(),
  }),
});

export const settingsPatchSchema = z.strictObject({
  general: z.strictObject(generalShape).partial().optional(),
  tracking: z.strictObject(trackingShape).partial().optional(),
});

/** Full settings document (as stored), with SETTINGS_LIMITS enforced. */
export function validateSettings(input: unknown): ValidationResult<Settings> {
  return runSchema(settingsSchema, input);
}

/** Partial patch; unknown keys rejected; numeric ranges enforced; integers only. */
export function validateSettingsPatch(input: unknown): ValidationResult<SettingsPatch> {
  return runSchema(settingsPatchSchema, input);
}
