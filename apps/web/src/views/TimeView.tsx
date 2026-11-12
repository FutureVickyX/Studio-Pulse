/**
 * Your tracked sessions (synced from the desktop tracker) and their attribution to projects and
 * tasks. Attribution is always an explicit choice: nothing is inferred from application names.
 */

import { useEffect, useMemo, useState } from 'react';
import { resolveRange } from '@studio-pulse/time-engine';
import type { RangePreset } from '@studio-pulse/time-engine';
import { Button, Card, Checkbox, EmptyState, IconClock, SegmentedControl, Select } from '@studio-pulse/ui';

import * as api from '../lib/api';
import { applicationsIn, filterEntries, totals, totalsBy } from '../lib/time';
import type { TimeEntry } from '../lib/time';
import { TIME_ZONE, formatClock, formatDay, formatDuration, todayKey } from '../lib/format';
import { localDayKey } from '@studio-pulse/time-engine';
import { LoadingRows, PageHeader, ProblemBanner, ProjectSelect, useAction } from '../components/common';
import { useMyTime, useProjects, useRefresh, useTasks, useWorkspace } from '../app/workspace';

type Preset = Exclude<RangePreset, 'custom'>;
const ANY = '*';
const UNATTRIBUTED = 'unattributed';

/**
 * Today's local day key, re-rendering when the day turns: a timer for local midnight, and a check
 * when the tab is shown again (background tabs and a sleeping computer delay timers).
 */
function useToday(): string {
  const [today, setToday] = useState(() => todayKey());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      const now = Date.now();
      setToday(todayKey(now));
      // The next local midnight (DST-safe), and a second more so the new day has surely begun.
      const midnight = resolveRange('today', { now, timeZone: TIME_ZONE }).endMs;
      timer = setTimeout(check, midnight - now + 1_000);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return today;
}

export function TimeView() {
  const { client } = useWorkspace();
  const refresh = useRefresh();
  const projects = useProjects();
  const tasks = useTasks();
  const action = useAction();
  const [preset, setPreset] = useState<Preset>('last7');
  const [applicationId, setApplicationId] = useState<string>(ANY);
  const [attribution, setAttribution] = useState<string>(ANY);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [targetProject, setTargetProject] = useState<string | null>(null);
  const [targetTask, setTargetTask] = useState<string>('');

  // The range only moves at local midnight, so it is recomputed when the preset or the day changes.
  const today = useToday();
  const range = useMemo(() => resolveRange(preset, { now: Date.now(), timeZone: TIME_ZONE }), [preset, today]);
  const fromIso = new Date(range.startMs).toISOString();
  const toIso = new Date(range.endMs).toISOString();
  const time = useMyTime(fromIso, toIso);

  const entries = time.data ?? [];
  const shown = filterEntries(entries, {
    startMs: range.startMs,
    endMs: range.endMs,
    applicationId: applicationId === ANY ? null : applicationId,
    projectId: attribution === ANY ? null : attribution === UNATTRIBUTED ? 'unattributed' : attribution,
  });
  const sum = totals(shown);
  const byProject = totalsBy(shown, (e) => e.project_id);
  const projectName = (id: string | null) => (id ? ((projects.data ?? []).find((p) => p.id === id)?.name ?? 'Another project') : 'Unattributed');
  const taskTitle = (id: string | null) => (id ? (tasks.data ?? []).find((t) => t.id === id)?.title : undefined);
  const days = groupByDay(shown);
  const selectedShown = shown.filter((e) => selected.has(e.id));
  const projectTasks = (tasks.data ?? []).filter((t) => t.project_id === targetProject && t.status !== 'archived');

  function toggle(id: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function apply(target: { projectId: string | null; taskId: string | null }) {
    const ids = selectedShown.map((e) => e.id);
    if (ids.length === 0) return;
    const changed = await action.run(
      () => api.attributeTime(client, ids, target),
      undefined,
      'Couldn’t update the sessions:',
    );
    if (changed === undefined) return;
    setSelected(new Set());
    refresh('time');
  }

  return (
    <div className="web-page">
      <PageHeader
        title="Time"
        subtitle="Sessions the Studio Pulse desktop app tracked and synced. Attribute them to the work they belong to."
      />
      <div className="web-toolbar">
        <SegmentedControl<Preset>
          aria-label="Period"
          value={preset}
          onChange={(next) => {
            setPreset(next);
            setSelected(new Set());
          }}
          options={[
            { value: 'today', label: 'Today' },
            { value: 'yesterday', label: 'Yesterday' },
            { value: 'last7', label: '7 days' },
            { value: 'last30', label: '30 days' },
          ]}
        />
        <div className="web-filters">
          <Select
            aria-label="Application"
            selectSize="sm"
            className={applicationId !== ANY ? 'web-filter--active' : undefined}
            value={applicationId}
            onChange={setApplicationId}
            options={[{ value: ANY, label: 'All applications' }, ...applicationsIn(entries).map((a) => ({ value: a.id, label: a.name }))]}
          />
          <Select
            aria-label="Attribution"
            selectSize="sm"
            className={attribution !== ANY ? 'web-filter--active' : undefined}
            value={attribution}
            onChange={setAttribution}
            options={[
              { value: ANY, label: 'Any attribution' },
              { value: UNATTRIBUTED, label: 'Unattributed' },
              ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </div>
      </div>

      {time.problem ? <ProblemBanner problem={time.problem} onRetry={() => void time.reload()} /> : null}

      <section className="web-summary" aria-label="Totals for the shown sessions">
        <div className="web-tile">
          <span className="web-tile__value">{formatDuration(sum.activeMs)}</span>
          <span className="web-tile__label">Active</span>
        </div>
        <div className="web-tile">
          <span className="web-tile__value">{formatDuration(sum.idleMs)}</span>
          <span className="web-tile__label">Idle</span>
        </div>
        <div className="web-tile">
          <span className="web-tile__value">{formatDuration(sum.foregroundMs)}</span>
          <span className="web-tile__label">In foreground</span>
        </div>
        <div className="web-tile">
          <span className="web-tile__value">{sum.entries}</span>
          <span className="web-tile__label">Sessions</span>
        </div>
      </section>
      <p className="web-footnote">
        Foreground is the time an app was in front; active excludes idle periods. Both are measured automatically and are not billable
        time. Sessions recorded on the desktop appear here once they have synced.
      </p>

      {byProject.size > 1 || (byProject.size === 1 && !byProject.has(null)) ? (
        <Card title="By project" headingLevel={2}>
          <ul className="web-rows web-rows--compact">
            {[...byProject.entries()]
              .sort((a, b) => b[1].activeMs - a[1].activeMs)
              .map(([id, t]) => (
                <li key={id ?? 'none'} className="web-row web-row--static">
                  <span className="web-row__main">
                    <span className="web-row__title">{projectName(id)}</span>
                  </span>
                  <span className="web-row__aside">
                    {formatDuration(t.activeMs)} active · {formatDuration(t.foregroundMs)} foreground
                  </span>
                </li>
              ))}
          </ul>
        </Card>
      ) : null}

      {selectedShown.length > 0 ? (
        <div className="web-bulk" role="region" aria-label="Attribute selected sessions">
          <span className="web-bulk__count">{selectedShown.length} selected</span>
          <ProjectSelect
            size="sm"
            label="Project"
            projects={(projects.data ?? []).filter((p) => p.status !== 'archived')}
            value={targetProject}
            noneLabel="Choose a project…"
            onChange={(id) => {
              setTargetProject(id);
              setTargetTask('');
            }}
          />
          <Select
            aria-label="Task (optional)"
            selectSize="sm"
            value={targetTask}
            disabled={!targetProject}
            onChange={setTargetTask}
            options={[{ value: '', label: 'No specific task' }, ...projectTasks.map((t) => ({ value: t.id, label: t.title }))]}
          />
          <Button
            size="sm"
            variant="primary"
            pending={action.pending}
            disabled={!targetProject}
            onClick={() => void apply({ projectId: targetProject, taskId: targetTask || null })}
          >
            Attribute
          </Button>
          <Button size="sm" disabled={action.pending} onClick={() => void apply({ projectId: null, taskId: null })}>
            Clear attribution
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Cancel
          </Button>
        </div>
      ) : null}

      {time.data === undefined ? (
        <Card flush>
          <LoadingRows rows={6} label="Loading sessions" />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState icon={<IconClock size={22} />} title={entries.length === 0 ? 'No synced sessions in this period' : 'No sessions match'}>
            {entries.length === 0
              ? 'Sign in to Studio Pulse on your Windows computer and choose this workspace under Settings › Sync. Tracked sessions appear here after they upload.'
              : 'Try another application or attribution filter.'}
          </EmptyState>
        </Card>
      ) : (
        days.map(([day, list]) => {
          const daySum = totals(list);
          const allSelected = list.every((e) => selected.has(e.id));
          return (
            <Card
              key={day}
              flush
              title={formatDay(day)}
              description={`${formatDuration(daySum.activeMs)} active · ${formatDuration(daySum.foregroundMs)} foreground`}
              actions={
                <Checkbox
                  checked={allSelected}
                  label="Select day"
                  onChange={(on) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      for (const e of list) {
                        if (on) next.add(e.id);
                        else next.delete(e.id);
                      }
                      return next;
                    })
                  }
                />
              }
            >
              <ul className="web-sessions">
                {list.map((entry) => (
                  <li key={entry.id} className="web-session">
                    <Checkbox
                      checked={selected.has(entry.id)}
                      label={<span className="sp-visually-hidden">Select {entry.application_name} at {formatClock(entry.started_at)}</span>}
                      onChange={(on) => toggle(entry.id, on)}
                    />
                    <span className="web-session__app">{entry.application_name}</span>
                    <span className="web-session__time">
                      {formatClock(entry.started_at)}–{formatClock(entry.ended_at)}
                    </span>
                    <span className={`web-session__kind web-session__kind--${entry.kind}`}>{entry.kind === 'active' ? 'Active' : 'Idle'}</span>
                    <span className="web-session__duration">{formatDuration(entry.active_ms + entry.idle_ms)}</span>
                    <span className="web-session__work">
                      {entry.project_id ? (
                        <>
                          {projectName(entry.project_id)}
                          {taskTitle(entry.task_id) ? ` › ${taskTitle(entry.task_id)}` : ''}
                        </>
                      ) : (
                        <span className="web-muted">Unattributed</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })
      )}
    </div>
  );
}

/** Entries by local day, newest day first (entries are already newest first). */
function groupByDay(entries: readonly TimeEntry[]): [string, TimeEntry[]][] {
  const days = new Map<string, TimeEntry[]>();
  for (const entry of entries) {
    const day = localDayKey(Date.parse(entry.started_at), TIME_ZONE);
    const list = days.get(day) ?? [];
    list.push(entry);
    days.set(day, list);
  }
  return [...days.entries()];
}
