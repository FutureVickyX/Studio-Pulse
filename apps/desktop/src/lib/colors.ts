/**
 * Application colours for charts (dataviz rules):
 * - colour = identity, so it follows the application, never its rank;
 * - the eight validated categorical slots are used in fixed order and never cycled;
 * - past eight applications in one view, the smallest fold into a neutral "Other".
 *
 * Which applications get a slot depends on the set in view (the top seven by active time when
 * there are more than eight), but the slot each one gets follows the registry order, so a live
 * re-ranking during the day never repaints the survivors.
 */

export const SERIES_SLOT_COUNT = 8;

export const SERIES_COLORS: readonly string[] = Array.from(
  { length: SERIES_SLOT_COUNT },
  (_, index) => `var(--sp-series-${index + 1})`,
);

export const OTHER_COLOR = 'var(--sp-series-other)';

/** Neutral aggregate colours (all applications together). */
export const TOTAL_COLOR = 'var(--sp-viz-total)';

export interface ColorCandidate {
  applicationId: string;
  activeMs: number;
  foregroundMs: number;
}

/**
 * @param present applications in the current view (any order)
 * @param registryOrder applicationId → registry sort key; unknown ids sort last, by id
 */
export function assignApplicationColors(
  present: readonly ColorCandidate[],
  registryOrder: ReadonlyMap<string, number>,
): Map<string, string> {
  const unique = new Map<string, ColorCandidate>();
  for (const candidate of present) {
    const existing = unique.get(candidate.applicationId);
    if (!existing) unique.set(candidate.applicationId, candidate);
  }
  const all = [...unique.values()];

  let colored: ColorCandidate[];
  if (all.length <= SERIES_SLOT_COUNT) {
    colored = all;
  } else {
    colored = all
      .slice()
      .sort(
        (a, b) =>
          b.activeMs - a.activeMs || b.foregroundMs - a.foregroundMs || a.applicationId.localeCompare(b.applicationId),
      )
      .slice(0, SERIES_SLOT_COUNT - 1);
  }

  const orderOf = (id: string) => registryOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
  colored.sort((a, b) => orderOf(a.applicationId) - orderOf(b.applicationId) || a.applicationId.localeCompare(b.applicationId));

  const map = new Map<string, string>();
  colored.forEach((candidate, index) => {
    map.set(candidate.applicationId, SERIES_COLORS[index] ?? OTHER_COLOR);
  });
  for (const candidate of all) {
    if (!map.has(candidate.applicationId)) map.set(candidate.applicationId, OTHER_COLOR);
  }
  return map;
}

export function colorFor(map: ReadonlyMap<string, string>, applicationId: string): string {
  return map.get(applicationId) ?? OTHER_COLOR;
}
