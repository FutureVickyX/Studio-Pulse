import { describe, expect, it } from 'vitest';

import {
  digitOf,
  matchShortcut,
  phaseTwoShortcutNote,
  SHORTCUTS,
} from '../../../apps/desktop/src/lib/keyboard';
import type { KeyContext, KeyInput } from '../../../apps/desktop/src/lib/keyboard';
import { NAV_ITEMS } from '../../../apps/desktop/src/lib/routes';

const NORMAL: KeyContext = { typing: false, modalOpen: false };

function press(partial: Partial<KeyInput> & { key: string }): KeyInput {
  return { code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...partial };
}

/** Ctrl + a top-row digit, as a US keyboard reports it. */
function ctrlDigit(digit: number): KeyInput {
  return press({ key: String(digit), code: `Digit${digit}`, ctrlKey: true });
}

const ctrlShiftP = press({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true });
const ctrlComma = press({ key: ',', code: 'Comma', ctrlKey: true });
const questionMark = press({ key: '?', code: 'Slash', shiftKey: true });

describe('matchShortcut: Ctrl+1…7 sections', () => {
  it('maps the available sections to their routes', () => {
    expect(matchShortcut(ctrlDigit(1), NORMAL)).toEqual({ type: 'navigate', route: 'home' });
    expect(matchShortcut(ctrlDigit(5), NORMAL)).toEqual({ type: 'navigate', route: 'time' });
    expect(matchShortcut(ctrlDigit(7), NORMAL)).toEqual({ type: 'navigate', route: 'settings' });
  });

  it.each([2, 3, 4, 6])('ignores Ctrl+%i (a Phase-2 section)', (digit) => {
    expect(matchShortcut(ctrlDigit(digit), NORMAL)).toBeNull();
  });

  it.each([0, 8, 9])('ignores Ctrl+%i (no section)', (digit) => {
    expect(matchShortcut(ctrlDigit(digit), NORMAL)).toBeNull();
  });

  it('agrees with NAV_ITEMS for every digit', () => {
    for (const item of NAV_ITEMS) {
      const expected = item.available ? { type: 'navigate', route: item.section } : null;
      expect(matchShortcut(ctrlDigit(item.digit), NORMAL)).toEqual(expected);
    }
  });

  it('uses the physical top-row key, so AZERTY Ctrl+1 (key "&") still works', () => {
    expect(matchShortcut(press({ key: '&', code: 'Digit1', ctrlKey: true }), NORMAL)).toEqual({
      type: 'navigate',
      route: 'home',
    });
  });

  it('accepts numpad digits when NumLock is on', () => {
    expect(matchShortcut(press({ key: '5', code: 'Numpad5', ctrlKey: true }), NORMAL)).toEqual({
      type: 'navigate',
      route: 'time',
    });
  });

  it('leaves Ctrl+End / Ctrl+Home alone when NumLock is off (numpad keys that type no digit)', () => {
    expect(matchShortcut(press({ key: 'End', code: 'Numpad1', ctrlKey: true }), NORMAL)).toBeNull();
    expect(matchShortcut(press({ key: 'Home', code: 'Numpad7', ctrlKey: true }), NORMAL)).toBeNull();
  });

  it('works while typing in a field (modifier shortcuts are not text)', () => {
    expect(matchShortcut(ctrlDigit(5), { typing: true, modalOpen: false })).toEqual({ type: 'navigate', route: 'time' });
  });

  it('does not treat Ctrl+Shift+digit as navigation', () => {
    expect(matchShortcut(press({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }), NORMAL)).toBeNull();
  });
});

describe('matchShortcut: Ctrl+, Settings', () => {
  it('opens Settings', () => {
    expect(matchShortcut(ctrlComma, NORMAL)).toEqual({ type: 'navigate', route: 'settings' });
  });

  it('matches by the typed character when the code differs', () => {
    expect(matchShortcut(press({ key: ',', code: 'KeyM', ctrlKey: true }), NORMAL)).toEqual({
      type: 'navigate',
      route: 'settings',
    });
  });

  it('needs Ctrl', () => {
    expect(matchShortcut(press({ key: ',', code: 'Comma' }), NORMAL)).toBeNull();
  });
});

describe('matchShortcut: Ctrl+Shift+P pause / resume', () => {
  it('toggles pause', () => {
    expect(matchShortcut(ctrlShiftP, NORMAL)).toEqual({ type: 'togglePause' });
  });

  it('matches with Caps Lock on (lower-case key)', () => {
    expect(matchShortcut(press({ key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true }), NORMAL)).toEqual({
      type: 'togglePause',
    });
  });

  it('ignores auto-repeat so holding the keys does not flip pause back and forth', () => {
    expect(matchShortcut({ ...ctrlShiftP, repeat: true }, NORMAL)).toBeNull();
  });

  it('ignores Ctrl+P without Shift and other Ctrl+Shift letters', () => {
    expect(matchShortcut(press({ key: 'p', code: 'KeyP', ctrlKey: true }), NORMAL)).toBeNull();
    expect(matchShortcut(press({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true }), NORMAL)).toBeNull();
  });

  it('works while typing in a field', () => {
    expect(matchShortcut(ctrlShiftP, { typing: true, modalOpen: false })).toEqual({ type: 'togglePause' });
  });
});

describe('matchShortcut: ? shortcuts sheet', () => {
  it('opens the sheet', () => {
    expect(matchShortcut(questionMark, NORMAL)).toEqual({ type: 'showShortcuts' });
  });

  it('types a ? instead while focus is in a text field', () => {
    expect(matchShortcut(questionMark, { typing: true, modalOpen: false })).toBeNull();
  });

  it('is not Ctrl+?', () => {
    expect(matchShortcut({ ...questionMark, ctrlKey: true }, NORMAL)).toBeNull();
  });
});

describe('matchShortcut: suspended contexts', () => {
  it.each([
    ['Ctrl+1', ctrlDigit(1)],
    ['Ctrl+,', ctrlComma],
    ['Ctrl+Shift+P', ctrlShiftP],
    ['?', questionMark],
  ])('%s does nothing while a modal dialog is open', (_label, input) => {
    expect(matchShortcut(input, { typing: false, modalOpen: true })).toBeNull();
  });

  it('ignores Alt (and AltGr, reported as Ctrl+Alt) and the Windows key', () => {
    expect(matchShortcut({ ...ctrlDigit(1), altKey: true }, NORMAL)).toBeNull();
    expect(matchShortcut({ ...ctrlShiftP, altKey: true }, NORMAL)).toBeNull();
    expect(matchShortcut({ ...ctrlDigit(1), metaKey: true }, NORMAL)).toBeNull();
  });

  it('ignores plain keys', () => {
    expect(matchShortcut(press({ key: '1', code: 'Digit1' }), NORMAL)).toBeNull();
    expect(matchShortcut(press({ key: 'p', code: 'KeyP' }), NORMAL)).toBeNull();
  });
});

describe('digitOf', () => {
  it.each([
    [{ key: '3', code: 'Digit3' }, 3],
    [{ key: '"', code: 'Digit3' }, 3],
    [{ key: '0', code: 'Numpad0' }, 0],
    [{ key: 'Insert', code: 'Numpad0' }, null],
    [{ key: 'ArrowDown', code: 'Numpad2' }, null],
    [{ key: '4', code: '' }, 4],
    [{ key: 'a', code: 'KeyA' }, null],
  ])('%o → %s', (input, expected) => {
    expect(digitOf(input)).toBe(expected);
  });
});

describe('SHORTCUTS sheet', () => {
  const keysOf = (description: string) => SHORTCUTS.filter((s) => s.description === description).map((s) => s.keys.join('+'));

  it('lists one Ctrl+digit row per available section and none for Phase-2 sections', () => {
    const digitRows = SHORTCUTS.filter((s) => s.keys.length === 2 && s.keys[0] === 'Ctrl' && /^[0-9]$/.test(s.keys[1] ?? ''));
    expect(digitRows.map((s) => s.keys[1])).toEqual(NAV_ITEMS.filter((i) => i.available).map((i) => String(i.digit)));
    for (const item of NAV_ITEMS.filter((i) => !i.available)) {
      expect(SHORTCUTS.some((s) => s.keys.includes(String(item.digit)))).toBe(false);
    }
  });

  it('documents Ctrl+, Ctrl+Shift+P and ?', () => {
    expect(keysOf('Settings')).toContain('Ctrl+,');
    expect(keysOf('Pause or resume tracking')).toEqual(['Ctrl+Shift+P']);
    expect(keysOf('Show keyboard shortcuts')).toEqual(['?']);
  });

  it('every documented key combination is one matchShortcut actually handles', () => {
    for (const row of SHORTCUTS) {
      const combo = row.keys.join('+');
      if (combo === 'Esc') continue; // handled by dialogs and menus themselves
      const last = row.keys[row.keys.length - 1] ?? '';
      const input = press({
        key: last,
        code: /^[0-9]$/.test(last) ? `Digit${last}` : last === ',' ? 'Comma' : last === 'P' ? 'KeyP' : '',
        ctrlKey: row.keys.includes('Ctrl'),
        shiftKey: row.keys.includes('Shift') || last === '?',
      });
      expect(matchShortcut(input, NORMAL), combo).not.toBeNull();
    }
  });

  it('names the Phase-2 sections and their digits in the footnote', () => {
    expect(phaseTwoShortcutNote()).toBe('Tasks, Notes, Projects and Team (Ctrl+2, 3, 4, 6) arrive in Phase 2.');
  });
});
