import { describe, expect, it } from 'vitest';

import { APP_CATEGORIES, DEFAULT_APPLICATIONS } from '@studio-pulse/shared-types';
import type { DefaultApplicationsFile } from '@studio-pulse/shared-types';
import defaultApplicationsJson from '@studio-pulse/shared-types/default-applications.json';
import { APPLICATION_ID_PATTERN, exePatternError, validateDefaultApplications } from '@studio-pulse/validation';
import type { ValidationResult } from '@studio-pulse/validation';

function issuesOf<T>(result: ValidationResult<T>): string[] {
  return result.ok ? [] : result.issues;
}

/** A deep, mutable copy of the real registry file. */
function registry(): { version: number; applications: Array<Record<string, unknown> & { matchers: Array<Record<string, unknown>> }> } {
  return structuredClone(defaultApplicationsJson) as never;
}

describe('the shipped default-applications.json', () => {
  const result = validateDefaultApplications(defaultApplicationsJson);

  it('passes validateDefaultApplications', () => {
    expect(issuesOf(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('parses to the same applications that shared-types exposes (without the $comment)', () => {
    const value = (result as { ok: true; value: DefaultApplicationsFile }).value;
    expect(value.version).toBeGreaterThanOrEqual(1);
    expect(value.applications).toEqual(DEFAULT_APPLICATIONS);
    expect(Object.keys(value)).toEqual(['version', 'applications']);
  });

  it('has unique, well-formed ids, known categories and valid exe patterns', () => {
    const ids = DEFAULT_APPLICATIONS.map((app) => app.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const app of DEFAULT_APPLICATIONS) {
      expect(app.id).toMatch(APPLICATION_ID_PATTERN);
      expect(APP_CATEGORIES).toContain(app.category);
      expect(app.matchers.length).toBeGreaterThan(0);
      for (const matcher of app.matchers) expect(exePatternError(matcher.exe), `${app.id}: ${matcher.exe}`).toBeNull();
    }
  });

  it('covers the creative applications named in the product brief', () => {
    const ids = new Set(DEFAULT_APPLICATIONS.map((app) => app.id));
    for (const id of ['figma', 'adobe-photoshop', 'adobe-after-effects', 'blender', 'adobe-illustrator', 'adobe-premiere-pro']) {
      expect(ids.has(id), id).toBe(true);
    }
  });
});

describe('validateDefaultApplications: rejected files', () => {
  it('rejects duplicate ids', () => {
    const file = registry();
    file.applications[1]!.id = file.applications[0]!.id;
    expect(issuesOf(validateDefaultApplications(file))).toEqual([
      `applications[1].id: duplicate id "${file.applications[0]!.id}" (also used by applications[0])`,
    ]);
  });

  it('rejects two applications sharing an identical matcher, compared case-insensitively', () => {
    const file = registry();
    const photoshop = file.applications.findIndex((app) => app.id === 'adobe-photoshop');
    const krita = file.applications.findIndex((app) => app.id === 'krita');
    file.applications[krita]!.matchers.push({ exe: 'PHOTOSHOP.EXE' });
    const issues = issuesOf(validateDefaultApplications(file));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toBe(
      `applications[${krita}].matchers[1]: duplicates the matcher at applications[${photoshop}].matchers[0] ("adobe-photoshop")`,
    );
  });

  it('compares pathIncludes case-insensitively too, and treats a missing pathIncludes as null', () => {
    const file = registry();
    const affinity = file.applications.findIndex((app) => app.id === 'affinity-designer');
    const framer = file.applications.findIndex((app) => app.id === 'framer');
    file.applications[framer]!.matchers.push({ exe: 'designer.exe', pathIncludes: 'AFFINITY' });
    expect(issuesOf(validateDefaultApplications(file))).toEqual([
      `applications[${framer}].matchers[1]: duplicates the matcher at applications[${affinity}].matchers[0] ("affinity-designer")`,
    ]);

    const nullVsMissing = registry();
    nullVsMissing.applications[framer]!.matchers.push({ exe: 'Figma.exe', pathIncludes: null });
    expect(issuesOf(validateDefaultApplications(nullVsMissing))).toEqual([
      `applications[${framer}].matchers[1]: duplicates the matcher at applications[0].matchers[0] ("figma")`,
    ]);
  });

  it('allows the same exe with a different pathIncludes', () => {
    const file = registry();
    const framer = file.applications.findIndex((app) => app.id === 'framer');
    file.applications[framer]!.matchers.push({ exe: 'Designer.exe', pathIncludes: 'Framer' });
    expect(validateDefaultApplications(file).ok).toBe(true);
  });

  it('rejects a duplicate matcher inside one application', () => {
    const file = registry();
    file.applications[0]!.matchers.push({ exe: 'figma.exe' });
    expect(issuesOf(validateDefaultApplications(file))).toEqual([
      'applications[0].matchers[2]: duplicates the matcher at applications[0].matchers[0]',
    ]);
  });

  it('rejects a bad version', () => {
    for (const version of [0, -1, 1.5, '1', undefined, Number.NaN]) {
      const file = { ...registry(), version };
      expect(validateDefaultApplications(file).ok, String(version)).toBe(false);
    }
    expect(issuesOf(validateDefaultApplications({ ...registry(), version: 0 }))).toEqual(['version: must be at least 1']);
    expect(issuesOf(validateDefaultApplications({ ...registry(), version: 1.5 }))).toEqual(['version: must be a whole number']);
    expect(issuesOf(validateDefaultApplications({ ...registry(), version: '1' }))).toEqual(['version: must be a number']);
    expect(validateDefaultApplications({ ...registry(), version: 2 }).ok).toBe(true);
  });

  it('rejects invalid ids, categories, matchers and names', () => {
    const cases: Array<[(file: ReturnType<typeof registry>) => void, string]> = [
      [(file) => (file.applications[0]!.id = 'Figma'), 'applications[0].id: must be 2–64 lowercase letters, digits or hyphens, starting with a letter or digit'],
      [(file) => (file.applications[0]!.category = 'ui'), 'applications[0].category: must be one of: design, motion, video, 3d, photo, audio, publishing, code, other'],
      [(file) => (file.applications[0]!.matchers = []), 'applications[0].matchers: must have at least 1 item'],
      [(file) => (file.applications[0]!.matchers[0]!.exe = '*.exe'), 'applications[0].matchers[0].exe: must name the program, not only * before .exe'],
      [(file) => (file.applications[0]!.displayName = ' '), 'applications[0].displayName: must not be empty'],
      [(file) => (file.applications[0]!.enabledByDefault = 'yes'), 'applications[0].enabledByDefault: must be true or false'],
      [(file) => (file.applications[0]!.extra = 1), 'applications[0]: unknown field "extra"'],
    ];
    for (const [mutate, expected] of cases) {
      const file = registry();
      mutate(file);
      expect(issuesOf(validateDefaultApplications(file))).toEqual([expected]);
    }
  });

  it('rejects files that are not registry documents', () => {
    expect(validateDefaultApplications(null).ok).toBe(false);
    expect(validateDefaultApplications([]).ok).toBe(false);
    expect(issuesOf(validateDefaultApplications({ version: 1 }))).toEqual(['applications: is required']);
    expect(issuesOf(validateDefaultApplications({ version: 1, applications: [], apps: [] }))).toEqual(['unknown field "apps"']);
  });
});
