/**
 * Axis helpers for the time charts. They live in @studio-pulse/ui (shared with web Analytics);
 * re-exported here so the desktop's imports keep working unchanged. Imported from the module
 * itself rather than the package entry, which also loads the React components, so this module
 * (and its unit tests) stays DOM- and JSX-free, like `status.ts`.
 */

export { durationTicks, formatAxisDuration, timelineTicks, timelineWindow } from '../../../../packages/ui/src/scales';
