/**
 * Presentational Analytics components (plain view-model props, no workspace context, no data
 * fetching). `views/AnalyticsView.tsx` and `views/ProjectDetailView.tsx` compose them.
 */

// Header actions and filters
export { AnalyticsHeaderActions, AnalyticsToolbar } from './Toolbar';
export type { AnalyticsHeaderActionsProps, AnalyticsToolbarProps, ExportKind, TimeOfFilter } from './Toolbar';
export { ReportSettingsDialog, focusAfterDelete, savedViewSummary } from './ReportSettingsDialog';
export type { ReportSettingsDialogProps } from './ReportSettingsDialog';

// Frame: card states, table, live region, notes
export { AnalyticsFootnote, CardBody, DataTable, LiveRegion, PrivacyNote, TimeZoneNotice } from './shared';
export type {
  AnalyticsFootnoteProps,
  CardBodyProps,
  DataTableProps,
  LiveRegionProps,
  PrivacyNoteProps,
  TableColumn,
  TimeZoneNoticeProps,
} from './shared';

// Recorded time
export {
  ActivityCard,
  ApplicationsCard,
  MembersCard,
  ProjectProgressTable,
  ProjectsCard,
  SummaryTiles,
  TOP_TASKS,
  TimeByTaskCard,
} from './TimeCards';
export type {
  ActivityCardProps,
  ActivityTimelineState,
  ApplicationsCardProps,
  MembersCardProps,
  PreviousReference,
  ProjectProgressTableProps,
  ProjectsCardProps,
  SummaryTilesProps,
  TimeByTaskCardProps,
} from './TimeCards';
export { RecentSessionsCard, sessionsDescription } from './SessionsCard';
export type { RecentSessionsCardProps } from './SessionsCard';

// Tasks (current state)
export { AssignedProjectsCard, TaskList, TaskProgress, TaskProgressCard, UpcomingDeadlinesCard } from './TaskCards';
export type {
  AssignedProjectsCardProps,
  TaskListProps,
  TaskProgressCardProps,
  TaskProgressProps,
  UpcomingDeadlinesCardProps,
} from './TaskCards';

// Workspace view without visibility of teammates' time
export { WorkspacePrivatePanel } from './WorkspacePrivatePanel';
export type { WorkspacePrivatePanelProps } from './WorkspacePrivatePanel';

// Project Insights (project page)
export { INSIGHTS_RANGE_OPTIONS, ProjectInsights } from './ProjectInsights';
export type { ProjectInsightsProps } from './ProjectInsights';

// View models built here (pure; see ./models)
export { clockText, dayTimeline, sessionRows, taskListItems } from './models';
export type { DayTimeline, DayTimelineItem, SessionRow, SourceState, TaskListItem } from './models';
