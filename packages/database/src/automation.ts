import type { Json } from './types';

export const NOTIFICATION_KINDS = ['assigned','review','completed','due_soon','due_today','overdue','awaiting_review','inactive','daily','weekly'] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];

export const AUTOMATION_DEFAULTS = {
  assignment: true, deadlines: true, review: true, completion: false, daily: false, weekly: false, inactive: false,
  timezone: 'UTC', dueSoonDays: 1, reminderHour: 9, overdueEveryDays: 1, reviewAfterDays: 2, inactiveAfterDays: 7,
  dailyHour: 17, weeklyHour: 9, weeklyDay: 1, quietStart: 22, quietEnd: 7,
};
export type AutomationPreferences = typeof AUTOMATION_DEFAULTS;

export function readAutomationPreferences(value: Json): AutomationPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid notification preferences');
  const output = { ...AUTOMATION_DEFAULTS };
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(AUTOMATION_DEFAULTS, key)) throw new Error('Unknown notification preference');
    const name = key as keyof AutomationPreferences;
    if (typeof item !== typeof AUTOMATION_DEFAULTS[name]) throw new Error('Invalid notification preference');
    if (typeof item === 'number') {
      const minimum = ['dueSoonDays','overdueEveryDays','reviewAfterDays','inactiveAfterDays','weeklyDay'].includes(name) ? 1 : 0;
      const maximum = name === 'dueSoonDays' ? 14 : ['overdueEveryDays','reviewAfterDays','inactiveAfterDays'].includes(name) ? 30 : name === 'weeklyDay' ? 7 : 23;
      if (!Number.isInteger(item) || item < minimum || item > maximum) throw new Error('Reminder timing is outside its allowed range');
    }
    if (name === 'timezone') {
      if (typeof item !== 'string' || !/^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+)+)$/.test(item)) throw new Error('Choose an IANA time zone');
      let canonical: string;
      try { canonical = new Intl.DateTimeFormat('en', { timeZone: item }).resolvedOptions().timeZone; } catch { throw new Error('Choose a valid time zone'); }
      // Intl matches names case-insensitively but the server stores the exact tz-database spelling.
      // Only a case-only difference is taken over, so an alias the server's tzdata may lack is never swapped in.
      if (canonical.toLowerCase() === item.toLowerCase()) {
        Object.assign(output, { timezone: canonical });
        continue;
      }
    }
    Object.assign(output, { [name]: item });
  }
  return output;
}
