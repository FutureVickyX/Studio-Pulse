/** Browse projects: filter by status, search by name, open one. */

import { useState } from 'react';
import { Button, Card, EmptyState, IconPlus, IconProjects, SegmentedControl, Tooltip } from '@studio-pulse/ui';

import { canManageProjects, filterProjects, taskProgress } from '../lib/model';
import type { Project, ProjectScope, Task } from '../lib/model';
import { formatDay, formatRelative, todayKey } from '../lib/format';
import { DueTag, LoadingRows, PageHeader, ProblemBanner, ProjectStatusBadge, SearchField } from '../components/common';
import { ProjectDialog } from '../components/ProjectForm';
import { useProjects, useTasks, useWorkspace } from '../app/workspace';

const SCOPES: ReadonlyArray<{ value: ProjectScope; label: string }> = [
  { value: 'current', label: 'Current' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All' },
];

export function ProjectsView() {
  const { workspace, nav } = useWorkspace();
  const projects = useProjects();
  const tasks = useTasks();
  const [scope, setScope] = useState<ProjectScope>('current');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const manage = canManageProjects(workspace.role);
  const shown = filterProjects(projects.data ?? [], scope, search);

  const newButton = (
    <Button variant="primary" icon={<IconPlus size={14} />} disabled={!manage} onClick={() => setCreating(true)}>
      New project
    </Button>
  );

  return (
    <div className="web-page">
      <PageHeader
        title="Projects"
        subtitle={projects.data ? `${projects.data.filter((p) => p.status !== 'archived').length} not archived` : undefined}
        actions={manage ? newButton : <Tooltip content="Owners and admins create projects">{newButton}</Tooltip>}
      />
      <div className="web-toolbar">
        <SegmentedControl aria-label="Project status" value={scope} options={SCOPES} onChange={setScope} />
        <SearchField label="Search projects" value={search} onChange={setSearch} />
      </div>
      {projects.problem ? <ProblemBanner problem={projects.problem} onRetry={() => void projects.reload()} /> : null}
      <Card flush>
        {projects.data === undefined ? (
          <LoadingRows rows={5} label="Loading projects" />
        ) : shown.length === 0 ? (
          <EmptyState
            icon={<IconProjects size={22} />}
            title={projects.data.length === 0 ? 'No projects yet' : 'No projects match'}
            action={
              projects.data.length === 0 && manage ? (
                <Button variant="primary" icon={<IconPlus size={14} />} onClick={() => setCreating(true)}>
                  Create a project
                </Button>
              ) : undefined
            }
          >
            {projects.data.length === 0
              ? manage
                ? 'Projects group the tasks, notes and tracked time for a client or a piece of work.'
                : 'Owners and admins create projects. Once they do, they appear here.'
              : 'Try another status or search.'}
          </EmptyState>
        ) : (
          <ul className="web-project-list">
            {shown.map((project) => (
              <ProjectRow key={project.id} project={project} tasks={tasks.data ?? []} onOpen={() => nav.navigate({ name: 'project', id: project.id })} />
            ))}
          </ul>
        )}
      </Card>
      {creating ? <ProjectDialog open onClose={() => setCreating(false)} onSaved={(p) => nav.navigate({ name: 'project', id: p.id })} /> : null}
    </div>
  );
}

function ProjectRow({ project, tasks, onOpen }: { project: Project; tasks: readonly Task[]; onOpen: () => void }) {
  const { memberName } = useWorkspace();
  const progress = taskProgress(tasks.filter((t) => t.project_id === project.id));
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const finished = project.status === 'completed' || project.status === 'archived';
  return (
    <li>
      <button type="button" className="web-project" onClick={onOpen}>
        <span className="web-project__main">
          <span className="web-project__name">{project.name}</span>
          <span className="web-project__sub">
            {project.lead_id ? memberName(project.lead_id) : 'No lead'}
            {project.start_date ? ` · from ${formatDay(project.start_date)}` : ''}
            {` · updated ${formatRelative(project.updated_at)}`}
          </span>
        </span>
        <span className="web-project__progress" title={`${progress.done} of ${progress.total} tasks done`}>
          <span className="web-progress" aria-hidden="true">
            <span className="web-progress__bar" style={{ width: `${percent}%` }} />
          </span>
          <span className="web-project__count">{progress.total > 0 ? `${progress.done}/${progress.total}` : '—'}</span>
        </span>
        <span className="web-project__due">
          <DueTag due={project.due_date} today={todayKey()} finished={finished} />
        </span>
        <span className="web-project__status">
          <ProjectStatusBadge status={project.status} />
        </span>
      </button>
    </li>
  );
}
