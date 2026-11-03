/** Sidebar navigation, the current page, the task panel and teammates' live changes. */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  BrandMark,
  Button,
  IconButton,
  IconClock,
  IconClose,
  IconHome,
  IconMore,
  IconNotes,
  IconProjects,
  IconSignOut,
  IconTasks,
  Menu,
  Select,
} from '@studio-pulse/ui';

import { ROLE_LABEL } from '../lib/model';
import type { Problem } from '../lib/errors';
import { watchWorkspace } from '../lib/realtime';
import { formatRoute, sectionOf } from '../lib/router';
import type { Route, Section } from '../lib/router';
import { Avatar, ProblemBanner } from '../components/common';
import { NotesView } from '../views/NotesView';
import { OverviewView } from '../views/OverviewView';
import { ProjectDetailView } from '../views/ProjectDetailView';
import { ProjectsView } from '../views/ProjectsView';
import { TaskPanel } from '../views/TaskPanel';
import { TasksView } from '../views/TasksView';
import { TimeView } from '../views/TimeView';
import { refreshTable, useWorkspace } from './workspace';

const NAV: ReadonlyArray<{ section: Section; label: string; icon: ReactNode; route: Route }> = [
  { section: 'overview', label: 'Overview', icon: <IconHome size={16} />, route: { name: 'overview' } },
  { section: 'projects', label: 'Projects', icon: <IconProjects size={16} />, route: { name: 'projects' } },
  { section: 'tasks', label: 'Tasks', icon: <IconTasks size={16} />, route: { name: 'tasks', view: 'mine' } },
  { section: 'notes', label: 'Notes', icon: <IconNotes size={16} />, route: { name: 'notes', id: null } },
  { section: 'time', label: 'Time', icon: <IconClock size={16} />, route: { name: 'time' } },
];

export function Shell({ membersProblem, onRetryMembers }: { membersProblem: Problem | null; onRetryMembers: () => void }) {
  const { client, workspace, nav } = useWorkspace();
  const { location } = nav;
  const { route, taskId } = location;
  const section = sectionOf(route);
  const mainRef = useRef<HTMLElement>(null);
  const shownPage = useRef<{ route: string; taskId: string | null } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Teammates' changes: refetch what is on screen.
  useEffect(() => watchWorkspace(client, workspace.id, (table) => refreshTable(workspace.id, table)), [client, workspace.id]);

  // The mobile menu closes on any navigation. A page (or the current one picked again) starts at
  // the top, but opening or closing the task panel, which only changes ?task=, keeps the scroll.
  // Compared as strings: every hashchange parses a new route object.
  useEffect(() => {
    setMenuOpen(false);
    const page = { route: formatRoute(location.route), taskId: location.taskId };
    const previous = shownPage.current;
    shownPage.current = page;
    if (previous && previous.route === page.route && previous.taskId !== page.taskId) return;
    mainRef.current?.scrollTo({ top: 0 });
  }, [location]);

  return (
    <div className="web-shell" data-menu={menuOpen ? 'open' : 'closed'}>
      <header className="web-topbar">
        <IconButton label={menuOpen ? 'Close menu' : 'Open menu'} icon={menuOpen ? <IconClose size={16} /> : <IconMore size={16} />} onClick={() => setMenuOpen((v) => !v)} />
        <span className="web-topbar__title">{workspace.name}</span>
      </header>
      <Sidebar section={section} />
      <main className="web-main" ref={mainRef} tabIndex={-1}>
        {membersProblem ? (
          <div className="web-page web-page--banner">
            <ProblemBanner problem={membersProblem} onRetry={onRetryMembers} title="Couldn’t load the team" />
          </div>
        ) : null}
        <Page route={route} />
      </main>
      {taskId ? <TaskPanel key={taskId} taskId={taskId} onClose={() => nav.openTask(null)} /> : null}
    </div>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'overview':
      return <OverviewView />;
    case 'projects':
      return <ProjectsView />;
    case 'project':
      return <ProjectDetailView key={route.id} projectId={route.id} />;
    case 'tasks':
      return <TasksView view={route.view} />;
    case 'notes':
      return <NotesView noteId={route.id} />;
    case 'time':
      return <TimeView />;
  }
}

function Sidebar({ section }: { section: Section }) {
  const { workspace, workspaces, user, selectWorkspace, signOut, nav } = useWorkspace();
  return (
    <aside className="web-sidebar" aria-label="Workspace">
      <div className="web-brand">
        <BrandMark size={22} />
        <span className="web-brand__name">Studio Pulse</span>
      </div>

      {workspaces.length > 1 ? (
        <Select
          aria-label="Workspace"
          value={workspace.id}
          selectSize="sm"
          options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
          onChange={selectWorkspace}
        />
      ) : (
        <div className="web-sidebar__workspace" title={workspace.name}>
          {workspace.name}
        </div>
      )}

      <nav className="web-nav" aria-label="Sections">
        <ul>
          {NAV.map((item) => (
            <li key={item.section}>
              <a
                className="web-nav__item"
                href={`#${item.route.name === 'overview' ? '/' : `/${item.section}`}`}
                aria-current={item.section === section ? 'page' : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  nav.navigate(item.route);
                }}
              >
                <span className="web-nav__icon">{item.icon}</span>
                <span className="web-nav__label">{item.label}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="web-sidebar__footer">
        <div className="web-me">
          <Avatar name={user.displayName} size={26} />
          <div className="web-me__text">
            <span className="web-me__name">{user.displayName}</span>
            <span className="web-me__role">{ROLE_LABEL[workspace.role]}</span>
          </div>
          <Menu
            aria-label="Account"
            placement="top-start"
            items={[
              {
                id: 'sign-out',
                label: 'Sign out',
                icon: <IconSignOut size={14} />,
                onSelect: () => void signOut(),
              },
            ]}
            trigger={(props) => (
              <Button {...props} size="sm" variant="ghost" aria-label="Account menu" icon={<IconMore size={14} />}>
                <span className="sp-visually-hidden">Account</span>
              </Button>
            )}
          />
        </div>
      </div>
    </aside>
  );
}
