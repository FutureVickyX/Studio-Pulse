/**
 * Application colours for charts. They live in @studio-pulse/ui (shared with web Analytics);
 * re-exported here so the desktop's imports keep working unchanged. Imported from the module
 * itself rather than the package entry, which also loads the React components, so this module
 * (and its unit tests) stays DOM- and JSX-free, like `status.ts`.
 */

export {
  assignApplicationColors,
  colorFor,
  OTHER_COLOR,
  SERIES_COLORS,
  SERIES_SLOT_COUNT,
  TOTAL_COLOR,
} from '../../../../packages/ui/src/seriesColors';
export type { ColorCandidate } from '../../../../packages/ui/src/seriesColors';
