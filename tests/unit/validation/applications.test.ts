import { describe, expect, it } from 'vitest';

import {
  APPLICATION_ID_PATTERN,
  validateApplicationInput,
  validateProcessMatcher,
} from '@studio-pulse/validation';
import type { ValidationResult } from '@studio-pulse/validation';

function issuesOf<T>(result: ValidationResult<T>): string[] {
  return result.ok ? [] : result.issues;
}

describe('APPLICATION_ID_PATTERN', () => {
  it.each(['figma', 'adobe-photoshop', '3ds-max', 'custom-0192a8f4', 'ab', `a${'b'.repeat(63)}`])('accepts %j', (id) => {
    expect(APPLICATION_ID_PATTERN.test(id)).toBe(true);
  });

  it.each(['', 'a', 'Figma', '-figma', 'my_app', 'my app', 'café', `a${'b'.repeat(64)}`])('rejects %j', (id) => {
    expect(APPLICATION_ID_PATTERN.test(id)).toBe(false);
  });
});

describe('validateProcessMatcher', () => {
  it('accepts exe only, with pathIncludes, and with pathIncludes null', () => {
    expect(validateProcessMatcher({ exe: 'Photoshop.exe' })).toEqual({ ok: true, value: { exe: 'Photoshop.exe' } });
    expect(validateProcessMatcher({ exe: 'Designer.exe', pathIncludes: 'Affinity' })).toEqual({
      ok: true,
      value: { exe: 'Designer.exe', pathIncludes: 'Affinity' },
    });
    expect(validateProcessMatcher({ exe: 'Designer.exe', pathIncludes: null })).toEqual({
      ok: true,
      value: { exe: 'Designer.exe', pathIncludes: null },
    });
  });

  it('returns trimmed values', () => {
    expect(validateProcessMatcher({ exe: '  Figma.exe ', pathIncludes: '  Figma\\ ' })).toEqual({
      ok: true,
      value: { exe: 'Figma.exe', pathIncludes: 'Figma\\' },
    });
  });

  it('reports exe rule violations with the field path', () => {
    expect(issuesOf(validateProcessMatcher({ exe: 'Photoshop' }))).toEqual(['exe: must end with .exe']);
    expect(issuesOf(validateProcessMatcher({ exe: '*.exe' }))).toEqual(['exe: must name the program, not only * before .exe']);
    expect(issuesOf(validateProcessMatcher({}))).toEqual(['exe: is required']);
    expect(issuesOf(validateProcessMatcher({ exe: 7 }))).toEqual(['exe: must be text']);
  });

  it('requires pathIncludes, when present and not null, to be 1–260 characters after trimming', () => {
    expect(issuesOf(validateProcessMatcher({ exe: 'Designer.exe', pathIncludes: '' }))).toEqual(['pathIncludes: must not be empty']);
    expect(issuesOf(validateProcessMatcher({ exe: 'Designer.exe', pathIncludes: '   ' }))).toEqual([
      'pathIncludes: must not be empty',
    ]);
    expect(validateProcessMatcher({ exe: 'Designer.exe', pathIncludes: 'x'.repeat(260) }).ok).toBe(true);
    expect(issuesOf(validateProcessMatcher({ exe: 'Designer.exe', pathIncludes: 'x'.repeat(261) }))).toEqual([
      'pathIncludes: must be at most 260 characters',
    ]);
  });

  it('rejects unknown keys and non-objects', () => {
    expect(issuesOf(validateProcessMatcher({ exe: 'Designer.exe', path: 'C:\\x' }))).toEqual(['unknown field "path"']);
    expect(validateProcessMatcher('Photoshop.exe').ok).toBe(false);
    expect(validateProcessMatcher(null).ok).toBe(false);
  });
});

describe('validateApplicationInput', () => {
  const valid = {
    id: null,
    displayName: 'SketchUp',
    category: '3d',
    matchers: [{ exe: 'SketchUp.exe' }],
    enabled: true,
    includeInReports: true,
  };

  it('accepts a new custom application (id null) and an existing id', () => {
    expect(validateApplicationInput(valid)).toEqual({ ok: true, value: valid });
    expect(validateApplicationInput({ ...valid, id: 'custom-sketchup' }).ok).toBe(true);
    expect(validateApplicationInput({ ...valid, id: 'figma' }).ok).toBe(true);
  });

  it('reads a missing id as null (create), as the Rust command does', () => {
    const { id: _omitted, ...withoutId } = valid;
    expect(validateApplicationInput(withoutId)).toEqual({ ok: true, value: { ...valid, id: null } });
  });

  it.each(['Figma', 'x', '-figma', 'my_app', '', 'a'.repeat(65)])('rejects id %j', (id) => {
    expect(issuesOf(validateApplicationInput({ ...valid, id }))).toEqual([
      'id: must be 2–64 lowercase letters, digits or hyphens, starting with a letter or digit',
    ]);
  });

  it('trims displayName and enforces 1–80 characters', () => {
    const trimmed = validateApplicationInput({ ...valid, displayName: '  SketchUp Pro  ' });
    expect(trimmed.ok && trimmed.value.displayName).toBe('SketchUp Pro');
    expect(validateApplicationInput({ ...valid, displayName: 'x'.repeat(80) }).ok).toBe(true);
    expect(issuesOf(validateApplicationInput({ ...valid, displayName: 'x'.repeat(81) }))).toEqual([
      'displayName: must be at most 80 characters',
    ]);
    expect(issuesOf(validateApplicationInput({ ...valid, displayName: '   ' }))).toEqual(['displayName: must not be empty']);
    // Counted in characters, not UTF-16 units: 80 emoji are fine.
    expect(validateApplicationInput({ ...valid, displayName: '🎨'.repeat(80) }).ok).toBe(true);
  });

  it('requires a known category', () => {
    expect(issuesOf(validateApplicationInput({ ...valid, category: 'games' }))).toEqual([
      'category: must be one of: design, motion, video, 3d, photo, audio, publishing, code, other',
    ]);
  });

  it('requires 1–16 valid matchers and reports each bad matcher by index', () => {
    expect(issuesOf(validateApplicationInput({ ...valid, matchers: [] }))).toEqual(['matchers: must have at least 1 item']);
    const sixteen = Array.from({ length: 16 }, (_, index) => ({ exe: `tool${index}.exe` }));
    expect(validateApplicationInput({ ...valid, matchers: sixteen }).ok).toBe(true);
    expect(issuesOf(validateApplicationInput({ ...valid, matchers: [...sixteen, { exe: 'one-more.exe' }] }))).toEqual([
      'matchers: must have at most 16 items',
    ]);
    expect(
      issuesOf(validateApplicationInput({ ...valid, matchers: [{ exe: 'SketchUp' }, { exe: 'ok.exe' }, { exe: 'C:\\x.exe' }] })),
    ).toEqual(['matchers[0].exe: must end with .exe', 'matchers[2].exe: must be a file name only (no \\, / or :)']);
  });

  it('requires both booleans', () => {
    const { enabled: _enabled, ...withoutEnabled } = valid;
    expect(issuesOf(validateApplicationInput(withoutEnabled))).toEqual(['enabled: is required']);
    expect(issuesOf(validateApplicationInput({ ...valid, includeInReports: 'yes' }))).toEqual([
      'includeInReports: must be true or false',
    ]);
  });

  it('reports every problem at once', () => {
    const result = validateApplicationInput({ id: 'Bad Id', displayName: '', category: 'x', matchers: [], enabled: 1 });
    expect(issuesOf(result)).toHaveLength(6);
  });

  it('rejects non-object input', () => {
    expect(issuesOf(validateApplicationInput(undefined))).toEqual(['is required']);
    expect(issuesOf(validateApplicationInput([]))).toEqual(['must be an object']);
  });
});
