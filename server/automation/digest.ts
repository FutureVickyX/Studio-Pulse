import { addDays, localDayKey, startOfLocalDay, summarizeReport } from '@studio-pulse/time-engine';
import type { ReportInterval } from '@studio-pulse/time-engine';
import { createReportLabels, projectProgressRows, reportTotals, splitReport, summarizeTaskProgress, unattributedTime, upcomingDeadlines } from '../../apps/web/src/lib/analytics';
import type { Project, Task } from '../../apps/web/src/lib/model';

/** A personal digest: the Phase 3A reconciliation and task builders, with no alternate time maths. */
export function buildDigest(input: {
  kind: 'daily' | 'weekly'; userId: string; workspaceId: string; timeZone: string;
  localDate: string; now: number; intervals: readonly ReportInterval[];
  tasks: readonly Task[]; projects: readonly Project[];
}) {
  const fromDay = addDays(input.localDate, input.kind === 'daily' ? -1 : -7);
  const toDay = addDays(input.localDate, -1);
  const from = startOfLocalDay(fromDay, input.timeZone);
  const to = startOfLocalDay(input.localDate, input.timeZone);
  const rows = summarizeReport(input.intervals, {
    fromDay, toDay, timeZone: input.timeZone, userIds: [input.userId], bucket: 'day', teammatesVisible: false,
  });
  const parts = splitReport(rows);
  const selection = { projectFilter: { kind: 'all' as const }, assigneeId: input.userId };
  const today = localDayKey(input.now, input.timeZone);
  const tasks = input.tasks.filter(task => task.workspace_id === input.workspaceId && task.assignee_id === input.userId);
  const projects = input.projects.filter(project => project.workspace_id === input.workspaceId);
  return {
    formatVersion: 1, kind: input.kind, timeZone: input.timeZone, fromDay, toDay,
    generatedAt: new Date(input.now).toISOString(),
    measurement: 'Recorded active application time; not manual or billable time.',
    currentTasks: summarizeTaskProgress(tasks, { ...selection, today }),
    completedInPeriod: tasks.filter(task => task.status === 'done' && task.completed_at !== null && Date.parse(task.completed_at) >= from && Date.parse(task.completed_at) < to).length,
    upcoming: upcomingDeadlines(tasks, { ...selection, today }).slice(0, 20).map(task => ({ id: task.id, title: task.title, dueDate: task.due_date, overdue: task.due_date !== null && task.due_date < today })),
    time: reportTotals(parts.total),
    unassigned: unattributedTime(parts.projects),
    applications: parts.applications.map(row => ({ id: row.applicationId, name: row.applicationName, activeMs: row.activeMs, idleMs: row.idleMs })),
    days: parts.periods.map(row => ({ day: row.bucketStart, activeMs: row.activeMs, idleMs: row.idleMs })),
    projects: projectProgressRows({ projects, tasks, selection, projectRows: parts.projects,
      labels: createReportLabels({ projects, tasks, members: [] }), today }).slice(0, 100),
  };
}

export type AutomationDigest = ReturnType<typeof buildDigest>;
