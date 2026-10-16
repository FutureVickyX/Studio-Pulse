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

  it('counts length in UTF-16 units, like the Rust core', () => {
    // '图' is in the BMP (1 unit); '🎬' is not (2 units).
    expect(exePatternError(`${'图'.repeat(256)}.exe`)).toBeNull();
    expect(exePatternError(`${'🎬'.repeat(128)}.exe`)).toBeNull(); // 256 + 4 = 260 units
    expect(exePatternError(`${'🎬'.repeat(129)}.exe`)).toBe('must be at most 260 characters'); // 262 units
  });

  it('matches the .exe suffix case-insensitively for ASCII only (Rust eq_ignore_ascii_case)', () => {
    expect(exePatternError('Blender.eXe')).toBeNull();
    expect(exePatternError('Blender.\u0435xe')).toBe('must end with .exe'); // Cyrillic "е"
    expect(exePatternError('Blender.ＥＸＥ')).toBe('must end with .exe'); // full-width letters
  });

  it('trims with Rust str::trim semantics (Unicode White_Space)', () => {
    expect(exePatternError('\u0085\u3000Figma.exe\u00a0\t')).toBeNull();
    expect(exePatternError('\u0085')).toBe('must not be empty');
    // U+FEFF is not White_Space: it is kept, so the value is not empty and does not end with .exe.
    expect(exePatternError('\ufeff')).toBe('must end with .exe');
  });

  it('reports the first broken rule in the same order as the Rust validator', () => {
    // Too long wins over everything else.
    expect(exePatternError(`C:\\${'*'.repeat(300)}`)).toBe('must be at most 260 characters');
    // A path wins over a missing suffix.
    expect(exePatternError('C:\\Tools\\blender')).toBe('must be a file name only (no \\, / or :)');
    // A missing suffix wins over too many wildcards.
    expect(exePatternError('*a*b*c*d*e')).toBe('must end with .exe');
    // Too many wildcards wins over a stem of only wildcards.
    expect(exePatternError('*****.exe')).toBe('may contain at most 4 * wildcards');
  });

  it('returns a message (not a throw) for non-string input from untyped callers', () => {
    expect(exePatternError(42 as unknown as string)).toBe('must be text');
  });
});
