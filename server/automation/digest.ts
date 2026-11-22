import { addDays, localDayKey, startOfLocalDay, summarizeReport } from '@studio-pulse/time-engine';
import type { ReportInterval } from '@studio-pulse/time-engine';
import { createReportLabels, projectProgressRows, reportTotals, splitReport, summarizeTaskProgress, unattributedTime, upcomingDeadlines } from '../../apps/web/src/lib/analytics';
import type { Project, Task } from '../../apps/web/src/lib/model';

/** finish_automation_job rejects a summary whose stored jsonb text exceeds 100,000 bytes; jsonb::text adds spacing. */
export const DIGEST_BYTE_BUDGET = 90_000;
const TEXT_LIMIT = 80;
const APPLICATION_ROWS = 20;
/** Cut to whole code points, so an emoji's surrogate pair is never split. */
function clip(text: string): string {
  const points = Array.from(text);
  return points.length <= TEXT_LIMIT ? text : `${points.slice(0, TEXT_LIMIT - 1).join('')}…`;
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

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
  // Bounded so any content the columns allow fits the delivery limit: most-active applications first
  // (the rest summed into one row, so totals still add up), names and titles clipped.
  const byActivity = [...parts.applications].sort((a, b) => b.activeMs - a.activeMs || (a.applicationId ?? '').localeCompare(b.applicationId ?? ''));
  const rest = byActivity.slice(APPLICATION_ROWS);
  const applications = byActivity.slice(0, APPLICATION_ROWS).map(row => ({ id: row.applicationId, name: row.applicationName === null ? null : clip(row.applicationName), activeMs: row.activeMs, idleMs: row.idleMs }));
  if (rest.length) applications.push({ id: '__other__', name: `Other applications (${rest.length})`,
    activeMs: rest.reduce((sum, row) => sum + row.activeMs, 0), idleMs: rest.reduce((sum, row) => sum + row.idleMs, 0) });
  const digest = {
    formatVersion: 1, kind: input.kind, timeZone: input.timeZone, fromDay, toDay,
    generatedAt: new Date(input.now).toISOString(),
    measurement: 'Recorded active application time; not manual or billable time.',
    currentTasks: summarizeTaskProgress(tasks, { ...selection, today }),
    completedInPeriod: tasks.filter(task => task.status === 'done' && task.completed_at !== null && Date.parse(task.completed_at) >= from && Date.parse(task.completed_at) < to).length,
    upcoming: upcomingDeadlines(tasks, { ...selection, today }).slice(0, 20).map(task => ({ id: task.id, title: clip(task.title), dueDate: task.due_date, overdue: task.due_date !== null && task.due_date < today })),
    time: reportTotals(parts.total),
    unassigned: unattributedTime(parts.projects),
    applications,
    days: parts.periods.map(row => ({ day: row.bucketStart, activeMs: row.activeMs, idleMs: row.idleMs })),
    projects: projectProgressRows({ projects, tasks, selection, projectRows: parts.projects,
      labels: createReportLabels({ projects, tasks, members: [] }), today }).slice(0, 100).map(row => ({ ...row, label: clip(row.label) })),
  };
  // Safety net: drop trailing project rows, then trailing upcoming rows, until the summary fits.
  while (bytes(digest) > DIGEST_BYTE_BUDGET && digest.projects.length) digest.projects.pop();
  while (bytes(digest) > DIGEST_BYTE_BUDGET && digest.upcoming.length) digest.upcoming.pop();
  return digest;
}

export type AutomationDigest = ReturnType<typeof buildDigest>;
