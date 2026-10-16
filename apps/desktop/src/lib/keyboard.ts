/**
 * Workspace keyboard map. Pure: takes the relevant key-event fields, returns an action.
 * Ctrl+1…7 sections (Phase-2 sections ignored), Ctrl+, Settings, Ctrl+Shift+P pause/resume,
 * `?` shortcuts sheet.
 */

import type { Route } from '@studio-pulse/shared-types';
import { navItemForDigit } from './routes';

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

function digitOf(input: KeyInput): number | null {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(input.code);
  if (match?.[1]) return Number(match[1]);
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

export const SHORTCUTS: readonly ShortcutDescription[] = [
  { keys: ['Ctrl', '1'], description: 'Home' },
  { keys: ['Ctrl', '5'], description: 'Time' },
  { keys: ['Ctrl', '7'], description: 'Settings' },
  { keys: ['Ctrl', ','], description: 'Settings' },
  { keys: ['Ctrl', 'Shift', 'P'], description: 'Pause or resume tracking' },
  { keys: ['?'], description: 'Show keyboard shortcuts' },
  { keys: ['Esc'], description: 'Close a dialog or menu' },
];
