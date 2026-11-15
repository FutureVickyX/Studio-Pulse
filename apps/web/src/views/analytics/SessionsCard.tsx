/**
 * Recent sessions: the viewer's own synced sessions in the range, newest first, under the page's
 * Project and Application filters. Own rows only; another person's sessions are never listed
 * here, whatever the workspace's visibility.
 */

import { useLayoutEffect, useRef } from 'react';
import type { FocusEvent } from 'react';
import { Button, Card, Checkbox, IconClock } from '@studio-pulse/ui';

import type { Problem } from '../../lib/errors';
import { formatDuration } from '../../lib/format';
import { ProblemBanner } from '../../components/common';

import type { SessionRow, SourceState } from './models';
import { CardBody, DataTable } from './shared';
import type { TableColumn } from './shared';

const COLUMNS: ReadonlyArray<TableColumn<SessionRow>> = [
  { id: 'application', header: 'Application', rowHeader: true, cell: (row) => row.application },
  {
    id: 'kind',
    header: 'Kind',
    cell: (row) => <span className={`web-session__kind web-session__kind--${row.kind}`}>{row.kind === 'active' ? 'Active' : 'Idle'}</span>,
  },
  { id: 'day', header: 'Day', cell: (row) => row.dayLabel },
  {
    id: 'time',
    header: 'Start–end',
    align: 'end',
    cell: (row) => `${row.startText}–${row.endText}${row.endDayLabel ? ` (${row.endDayLabel})` : ''}`,
  },
  { id: 'duration', header: 'Duration', align: 'end', cell: (row) => formatDuration(row.durationMs) },
  {
    id: 'work',
    header: 'Project / task',
    cell: (row) => (row.unattributed ? <span className="web-muted">{row.work}</span> : row.work),
  },
];

export interface RecentSessionsCardProps extends SourceState {
  /** `sessionRows(...)`: every page loaded so far, newest first. */
  rows: ReadonlyArray<SessionRow>;
  /** The reporting zone the start and end times are shown in. */
  timeZone: string;
  /** Only sessions with no project and no task: the card's toggle or the page's Unattributed filter. */
  onlyUnattributed: boolean;
  onOnlyUnattributedChange: (next: boolean) => void;
  /**
   * Offer "Only unattributed": only while the page has no project filter (with a project it could
   * only empty the list; under Unattributed it is already so).
   */
  showUnattributedToggle?: boolean;
  /** The page's project filter the list follows, by name, or null for all projects (or Unattributed). */
  projectName?: string | null;
  /** The page's application filter the list follows, by name, or null for every application. */
  applicationName?: string | null;
  /** The last page was full: there may be more. */
  hasMore: boolean;
  /** "Show more" was used and the last page came back short: every session is listed. */
  allShown?: boolean;
  loadingMore: boolean;
  onShowMore: () => void;
  /** "Show more" failed; the rows loaded so far stay, and the button tries again. */
  moreProblem?: Problem | null;
  stale?: boolean;
}

/** The card's description: whose sessions, under which filters, in which zone. */
export function sessionsDescription(input: {
  readonly timeZone: string;
  readonly onlyUnattributed: boolean;
  readonly projectName: string | null;
  readonly applicationName: string | null;
}): string {
  const which = input.onlyUnattributed ? 'unattributed sessions' : 'sessions';
  const project = input.projectName === null ? '' : ` on ${input.projectName}`;
  const application = input.applicationName === null ? '' : ` in ${input.applicationName}`;
  return `Your own ${which} in this range${project}${application}, newest first. Times are in ${input.timeZone}.`;
}

export function RecentSessionsCard({
  rows,
  timeZone,
  onlyUnattributed,
  onOnlyUnattributedChange,
  showUnattributedToggle = true,
  projectName = null,
  applicationName = null,
  hasMore,
  allShown = false,
  loadingMore,
  onShowMore,
  moreProblem = null,
  loading,
  problem,
  onRetry,
  stale = false,
}: RecentSessionsCardProps) {
  // "Show more" stays mounted while it fails (it is the retry), so focus stays on it. When the
  // last page comes back short it goes; if it had focus (focus was last in this slot and is now
  // nowhere), focus moves to the line that replaces it instead of falling to the page body.
  // A pointer press that never focused the button (Safari) moves nothing.
  const endRef = useRef<HTMLParagraphElement>(null);
  const focusInMore = useRef(false);
  const onMoreFocus = () => {
    focusInMore.current = true;
  };
  const onMoreBlur = (event: FocusEvent<HTMLDivElement>) => {
    // Focus went to another element: it left. A null target is removal (or the window losing focus).
    if (event.relatedTarget !== null) focusInMore.current = false;
  };
  useLayoutEffect(() => {
    if (!allShown || !focusInMore.current) return;
    focusInMore.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) endRef.current?.focus();
  }, [allShown]);

  return (
    <Card
      title="Recent sessions"
      description={sessionsDescription({ timeZone, onlyUnattributed, projectName, applicationName })}
      headingLevel={2}
      actions={
        showUnattributedToggle ? <Checkbox checked={onlyUnattributed} onChange={onOnlyUnattributedChange} label="Only unattributed" /> : undefined
      }
    >
      <CardBody
        loading={loading}
        loadingLabel="Loading sessions"
        skeletonLines={6}
        problem={problem}
        onRetry={onRetry}
        problemTitle="Couldn’t load your sessions"
        empty={rows.length === 0}
        emptyTitle={onlyUnattributed ? 'No unattributed sessions in this range' : 'No sessions in this range'}
        emptyText={
          onlyUnattributed
            ? 'Every session of yours in this range has a project or a task.'
            : 'Sessions appear here after they end and sync from the desktop app.'
        }
        emptyIcon={<IconClock size={20} />}
      >
        <DataTable
          caption={`Your sessions, newest first${onlyUnattributed ? ', unattributed only' : ''}`}
          captionHidden
          columns={COLUMNS}
          rows={rows}
          rowKey={(row) => row.id}
          stale={stale}
        />
        {moreProblem ? <ProblemBanner problem={moreProblem} title="Couldn’t load more sessions" /> : null}
        {hasMore ? (
          <div className="web-analytics-more" onFocus={onMoreFocus} onBlur={onMoreBlur}>
            <Button size="sm" pending={loadingMore} onClick={onShowMore}>
              {moreProblem ? 'Try again' : 'Show more'}
            </Button>
          </div>
        ) : allShown ? (
          <div className="web-analytics-more" onFocus={onMoreFocus} onBlur={onMoreBlur}>
            <p ref={endRef} className="web-muted" tabIndex={-1}>
              All sessions shown.
            </p>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
