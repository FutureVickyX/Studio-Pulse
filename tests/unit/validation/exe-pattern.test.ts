import { describe, expect, it } from 'vitest';

import { exePatternError } from '@studio-pulse/validation';

describe('exePatternError: valid patterns', () => {
  it.each([
    'Photoshop.exe',
    'photoshop.EXE',
    'AfterFX.Exe',
    'Figma Beta.exe',
    'Code - Insiders.exe',
    'gimp-*.exe',
    'Adobe Premiere Pro*.exe',
    '*photo*.exe',
    'a*b*c*d*.exe', // exactly four wildcards
    '*a.exe',
    'x.exe',
    '  Figma.exe  ', // checked after trimming
    `${'a'.repeat(256)}.exe`, // exactly 260 characters
  ])('%j is valid', (pattern) => {
    expect(exePatternError(pattern)).toBeNull();
  });
});

describe('exePatternError: invalid patterns', () => {
  it.each([
    ['', 'must not be empty'],
    ['   ', 'must not be empty'],
    ['Photoshop', 'must end with .exe'],
    ['Photoshop.ex', 'must end with .exe'],
    ['Photoshop.exe.bak', 'must end with .exe'],
    ['Photoshop.com', 'must end with .exe'],
    ['C:\\Program Files\\Adobe\\Photoshop.exe', 'must be a file name only (no \\, / or :)'],
    ['bin\\blender.exe', 'must be a file name only (no \\, / or :)'],
    ['bin/blender.exe', 'must be a file name only (no \\, / or :)'],
    ['C:blender.exe', 'must be a file name only (no \\, / or :)'],
    ['*a*b*c*d*.exe', 'may contain at most 4 * wildcards'],
    ['*.exe', 'must name the program, not only * before .exe'],
    ['**.exe', 'must name the program, not only * before .exe'],
    ['****.EXE', 'must name the program, not only * before .exe'],
    ['.exe', 'must name the program, not only * before .exe'],
    [`${'a'.repeat(257)}.exe`, 'must be at most 260 characters'],
  ])('%j → %s', (pattern, message) => {
    expect(exePatternError(pattern)).toBe(message);
  });

  it('measures length after trimming', () => {
    expect(exePatternError(`   ${'a'.repeat(256)}.exe   `)).toBeNull();
  });

  it('returns a message (not a throw) for non-string input from untyped callers', () => {
    expect(exePatternError(42 as unknown as string)).toBe('must be text');
  });
});
