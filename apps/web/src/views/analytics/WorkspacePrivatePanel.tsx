/**
 * Workspace view while teammates' time is not visible to the viewer: no time figures at all (and
 * no time request). Only the privacy note, task progress and the tasks-only project table.
 */

import { Card, IconProjects } from '@studio-pulse/ui';

import { MEASUREMENTS } from '../../lib/analytics';
import type { ProjectProgressRow, TaskProgressSummary } from '../../lib/analytics';

import type { SourceState } from './models';
import { CardBody, PrivacyNote } from './shared';
import { TaskProgressCard } from './TaskCards';
import { ProjectProgressTable } from './TimeCards';

export interface WorkspacePrivatePanelProps {
  /** `privacyNote(workspace)`. */
  note: string;
  /** The task list both cards read (one source). */
  tasks: SourceState;
  /** Every task in the workspace (or the project filter's): `summarizeTaskProgress`. */
  progress: TaskProgressSummary | null;
  /** `projectProgressRows({ ..., projectRows: null })`: tasks only, no time. */
  projectRows: ReadonlyArray<ProjectProgressRow>;
  /** Switch the page to My work. */
  onShowMyWork: () => void;
}

export function WorkspacePrivatePanel({ note, tasks, progress, projectRows, onShowMyWork }: WorkspacePrivatePanelProps) {
  return (
    <div className="web-stack">
      <PrivacyNote text={note} />
      <p className="web-analytics-card-link">
        <button type="button" className="web-link" onClick={onShowMyWork}>
          See your own time in My work
        </button>
      </p>
      <div className="web-grid-2">
        <TaskProgressCard title="Task progress" summary={progress} loading={tasks.loading} problem={tasks.problem} onRetry={tasks.onRetry} />
        <Card title="Projects: progress" description="Tasks per project. No time is shown in this view." headingLevel={2}>
          <CardBody
            loading={tasks.loading}
            loadingLabel="Loading project progress"
            problem={tasks.problem}
            onRetry={tasks.onRetry}
            problemTitle="Couldn’t load the tasks"
            empty={projectRows.length === 0}
            emptyTitle="No projects with tasks"
            emptyText="Projects appear here once they have tasks."
            emptyIcon={<IconProjects size={20} />}
          >
            <ProjectProgressTable rows={projectRows} showTime={false} caption="Projects: task progress" captionHidden />
            <p className="web-footnote">{MEASUREMENTS.taskProgress}</p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
