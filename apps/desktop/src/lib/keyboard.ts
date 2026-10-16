/**
 * Workspace keyboard map. Pure: takes the relevant key-event fields, returns an action.
 * Ctrl+1…7 sections (Phase-2 sections ignored), Ctrl+, Settings, Ctrl+Shift+P pause/resume,
 * `?` shortcuts sheet. Unit-tested in tests/unit/desktop.
 */

import type { Route } from '@studio-pulse/shared-types';
import { NAV_ITEMS, navItemForDigit } from './routes';

export type ShortcutAction =
  | { type: 'navigate'; route: Route }
  | { type: 'togglePause' }
  | { type: 'showShortcuts' };

export interface KeyInput {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
}

export interface KeyContext {
  /** Focus is in a text field: plain-character shortcuts (`?`) are not triggered. */
  typing: boolean;
  /** A modal dialog is open: workspace shortcuts are suspended. */
  modalOpen: boolean;
}

/**
 * The digit a key press stands for, or null.
 * - Top-row keys by physical position (`Digit1`), so Ctrl+1 works on AZERTY too, where the key
 *   itself produces `&`.
 * - Numpad keys only when they actually type a digit: with NumLock off, `Numpad1` is End,
 *   `Numpad7` Home, and so on, and Ctrl+End in a text field must keep moving the caret.
 * - Otherwise any key that types a digit.
 */
export function digitOf(input: Pick<KeyInput, 'key' | 'code'>): number | null {
  const top = /^Digit([0-9])$/.exec(input.code);
  if (top?.[1]) return Number(top[1]);
  if (/^Numpad[0-9]$/.test(input.code) && !/^[0-9]$/.test(input.key)) return null;
  if (/^[0-9]$/.test(input.key)) return Number(input.key);
  return null;
}

export function matchShortcut(input: KeyInput, context: KeyContext): ShortcutAction | null {
  if (context.modalOpen || input.metaKey || input.altKey) return null;

  if (input.ctrlKey && !input.shiftKey) {
    if (input.key === ',' || input.code === 'Comma') return { type: 'navigate', route: 'settings' };
    const digit = digitOf(input);
    if (digit !== null) {
      const item = navItemForDigit(digit);
      if (!item || !item.available) return null;
      return { type: 'navigate', route: item.section };
    }
    return null;
  }

  if (input.ctrlKey && input.shiftKey) {
    if (input.repeat) return null;
    if (input.code === 'KeyP' || input.key === 'P' || input.key === 'p') return { type: 'togglePause' };
    return null;
  }

  if (!input.ctrlKey && input.key === '?' && !context.typing) return { type: 'showShortcuts' };
  return null;
}

export interface ShortcutDescription {
  keys: string[];
  description: string;
}

/** The shortcuts sheet: one Ctrl+digit row per section that is available in this phase. */
export const SHORTCUTS: readonly ShortcutDescription[] = [
  ...NAV_ITEMS.filter((item) => item.available).map((item) => ({
    keys: ['Ctrl', String(item.digit)],
    description: item.label,
  })),
  { keys: ['Ctrl', ','], description: 'Settings' },
  { keys: ['Ctrl', 'Shift', 'P'], description: 'Pause or resume tracking' },
  { keys: ['?'], description: 'Show keyboard shortcuts' },
  { keys: ['Esc'], description: 'Close a dialog or menu' },
];

/** Sentence for the sheet's footnote, e.g. "Tasks, Notes, Projects and Team (Ctrl+2, 3, 4, 6) arrive in Phase 2." */
export function phaseTwoShortcutNote(): string | null {
  const later = NAV_ITEMS.filter((item) => !item.available);
  if (later.length === 0) return null;
  const labels = later.map((item) => item.label);
  const names = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  const digits = later.map((item) => item.digit).join(', ');
  return `${names} (Ctrl+${digits}) arrive${later.length === 1 ? 's' : ''} in Phase 2.`;
}
