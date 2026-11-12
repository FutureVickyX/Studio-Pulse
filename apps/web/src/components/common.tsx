/** Shared workspace components on top of @studio-pulse/ui. */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Banner, Button, Dialog, IconCalendar, IconSearch, Select, Skeleton, TextInput, cx } from '@studio-pulse/ui';

import { newId } from '../lib/api';
import { asProblem } from '../lib/errors';
import type { Problem } from '../lib/errors';
import {
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_TONE,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABEL,
  TASK_STATUSES,
  TASK_STATUS_LABEL,
  TASK_STATUS_TONE,
  describeDue,
  dueState,
  initials,
  isFormerMember,
  isPlausibleDay,
  withRow,
} from '../lib/model';
import type { Member, Project, ProjectStatus, Task, TaskPriority, TaskStatus } from '../lib/model';
import { formatDay } from '../lib/format';
import { readQueryData, setQueryData } from '../lib/store';
import { keys } from '../app/workspace';
import { notifyProblem, notifySuccess } from './notices';

// ---------------------------------------------------------------------------------------------
// Page scaffolding and states
// ---------------------------------------------------------------------------------------------

/**
 * The page's heading row. Titles are small uppercase labels; `titleCase="content"` keeps the case of
 * a title that is user content (a project's name, a greeting with the user's name).
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  titleCase = 'label',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  titleCase?: 'label' | 'content';
}) {
  return (
    <header className="web-page__header">
      <div className="web-page__titles">
        <h1 className={cx('web-page__title', titleCase === 'content' && 'web-page__title--content')}>{title}</h1>
        {subtitle ? <p className="web-page__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="web-page__actions">{actions}</div> : null}
    </header>
  );
}

export function ProblemBanner({ problem, onRetry, title }: { problem: Problem; onRetry?: () => void; title?: string }) {
  return (
    <Banner tone={problem.kind === 'network' ? 'warning' : 'danger'} title={title ?? 'Couldn’t load this'} {...(onRetry ? { onRetry } : {})}>
      {problem.message}
    </Banner>
  );
}

export function LoadingRows({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="web-loading" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div className="web-loading__row" key={i}>
          <Skeleton width={14} height={14} radius={7} />
          <Skeleton width={`${60 - (i % 3) * 12}%`} height={12} />
          <Skeleton width={64} height={12} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------------------------

export function Avatar({ name, size = 22, title }: { name: string; size?: number; title?: string }) {
  return (
    <span className="web-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} title={title ?? name} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={TASK_STATUS_TONE[status]}>{TASK_STATUS_LABEL[status]}</Badge>;
}

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return <Badge tone={PROJECT_STATUS_TONE[status]}>{PROJECT_STATUS_LABEL[status]}</Badge>;
}

export function PriorityTag({ priority }: { priority: TaskPriority }) {
  if (priority === 'normal') return null;
  return (
    <span className={cx('web-priority', `web-priority--${priority}`)}>
      <span className="web-priority__bars" aria-hidden="true" />
      {TASK_PRIORITY_LABEL[priority]}
    </span>
  );
}

export function DueTag({ due, today, finished = false }: { due: string | null; today: string; finished?: boolean }) {
  if (!due) return null;
  const state = finished ? 'later' : dueState(due, today);
  return (
    <span className={cx('web-due', `web-due--${state}`)} title={formatDay(due)}>
      <IconCalendar size={12} />
      {finished ? formatDay(due) : describeDue(due, today)}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------

export function SearchField({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
}) {
  return (
    <label className="web-search">
      <IconSearch size={14} className="web-search__icon" />
      <span className="sp-visually-hidden">{label}</span>
      <TextInput
        type="search"
        inputSize="sm"
        value={value}
        placeholder={placeholder ?? label}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

/**
 * A native date input bound to 'YYYY-MM-DD' | null. Typing a year passes through values such as
 * 0002-11-05, so a change is committed on blur or Enter, and only as a whole, plausible date (or an
 * empty field); anything else goes back to `value` with a notice. A whole, plausible date is also
 * committed when the field goes away without a blur. While a promise returned by `onChange` runs,
 * the field keeps showing the new date; then it shows `value` again.
 *
 * With `onConflict`, a draft started before `value` changed from elsewhere (a teammate's save) is
 * dropped and reported instead of committed, since the draft hid that date from the user.
 */
export function DateInput({
  id,
  value,
  onChange,
  onConflict,
  label,
  disabled,
  size = 'md',
}: {
  id?: string;
  value: string | null;
  onChange: (value: string | null) => void | Promise<unknown>;
  onConflict?: () => void;
  label?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  // What the user typed or picked and hasn't committed (null: show `value`); `pending` holds the
  // same, for the commit when the field goes away.
  const [draft, setDraftState] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  // The value the draft was started from: the one shown, or the one this field last committed.
  const from = useRef<string | null>(null);
  // The draft being saved (Enter, then the blur that follows, must not send it twice).
  const saving = useRef<string | null>(null);

  function setDraft(next: string | null) {
    if (pending.current === null && next !== null) from.current = value;
    pending.current = next;
    setDraftState(next);
  }

  // `value` moved on under the draft (not through this field's own commit).
  function overtaken(): boolean {
    return onConflict !== undefined && value !== from.current;
  }

  function commit(input: HTMLInputElement) {
    if (draft === null || draft === saving.current) return;
    const committed = draft;
    const next = input.value || null;
    if (input.validity.badInput || (next !== null && !isPlausibleDay(next))) {
      notifyProblem({ kind: 'invalid', message: 'Enter a complete date with a four-digit year (1900 or later).' });
      setDraft(null);
      // A half-typed date reads as '' like an empty value, so React alone would leave it showing.
      input.value = value ?? '';
      return;
    }
    if (next === value) {
      setDraft(null);
      return;
    }
    if (overtaken()) {
      setDraft(null);
      onConflict?.();
      return;
    }
    const outcome = onChange(next);
    // A draft continued while this save runs builds on the date just committed.
    from.current = next;
    if (outcome instanceof Promise) {
      saving.current = committed;
      const settle = () => {
        if (saving.current === committed) saving.current = null;
        if (pending.current === committed) setDraft(null);
      };
      void outcome.then(settle, settle);
    } else {
      setDraft(null);
    }
  }

  // Escape or Back can remove the field while it has focus, and Firefox doesn't blur an element
  // that is removed: a whole, plausible date left in it is committed on the way out. (An emptied
  // field isn't: it reads the same as a half-typed date.) A field with no draft does nothing, so
  // StrictMode's simulated unmount is harmless.
  const leave = useRef<() => void>(() => undefined);
  useEffect(() => {
    leave.current = () => {
      const last = pending.current;
      if (disabled || last === null || last === value || last === saving.current || !isPlausibleDay(last)) return;
      if (overtaken()) onConflict?.();
      else void onChange(last);
    };
  });
  useEffect(() => () => leave.current(), []);

  return (
    <TextInput
      id={id}
      type="date"
      inputSize={size}
      value={draft ?? value ?? ''}
      aria-label={label}
      disabled={disabled}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={(event) => commit(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit(event.currentTarget);
      }}
    />
  );
}

const NONE = '';

export function MemberSelect({
  members,
  value,
  onChange,
  noneLabel = 'Unassigned',
  label,
  size = 'md',
  disabled,
  busy,
  id,
}: {
  members: readonly Member[];
  value: string | null;
  onChange: (value: string | null) => void;
  noneLabel?: string;
  label?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** A save is running: announced, while the select stays enabled so keyboard focus stays put. */
  busy?: boolean;
  id?: string;
}) {
  const hintId = useId();
  // A value that is not an active member any more (they left) stays visible until changed, and
  // says so: only picking a current member reassigns it.
  const former = isFormerMember(value, members);
  const options = [
    { value: NONE, label: noneLabel },
    ...members.map((m) => ({ value: m.userId, label: m.displayName })),
    ...(value && !members.some((m) => m.userId === value) ? [{ value, label: former ? 'Former member' : '…', disabled: true }] : []),
  ];
  return (
    <>
      <Select
        id={id}
        value={value ?? NONE}
        options={options}
        selectSize={size}
        aria-label={label}
        aria-describedby={former ? hintId : undefined}
        aria-busy={busy || undefined}
        disabled={disabled}
        onChange={(next) => onChange(next === NONE ? null : next)}
      />
      {former ? (
        <span className="sp-field__hint" id={hintId}>
          {disabled ? 'They’ve left this workspace.' : 'They’ve left this workspace. Pick a current member to reassign.'}
        </span>
      ) : null}
    </>
  );
}

export function ProjectSelect({
  projects,
  value,
  onChange,
  noneLabel = 'No project',
  label,
  size = 'md',
  disabled,
  busy,
  id,
  includeArchived = false,
}: {
  projects: readonly Project[];
  value: string | null;
  onChange: (value: string | null) => void;
  noneLabel?: string;
  label?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** A save is running: announced, while the select stays enabled so keyboard focus stays put. */
  busy?: boolean;
  id?: string;
  includeArchived?: boolean;
}) {
  const visible = projects.filter((p) => includeArchived || p.status !== 'archived' || p.id === value);
  const options = [
    { value: NONE, label: noneLabel },
    ...visible.map((p) => ({ value: p.id, label: p.status === 'archived' ? `${p.name} (archived)` : p.name })),
  ];
  return (
    <Select
      id={id}
      value={value ?? NONE}
      options={options}
      selectSize={size}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      onChange={(next) => onChange(next === NONE ? null : next)}
    />
  );
}

export function TaskStatusSelect({
  value,
  onChange,
  size = 'md',
  label = 'Status',
  disabled,
  busy,
  id,
}: {
  value: TaskStatus;
  onChange: (value: TaskStatus) => void;
  size?: 'sm' | 'md';
  label?: string;
  disabled?: boolean;
  /** A save is running: announced, while the select stays enabled so keyboard focus stays put. */
  busy?: boolean;
  id?: string;
}) {
  return (
    <Select
      id={id}
      value={value}
      options={TASK_STATUSES.map((s) => ({ value: s, label: TASK_STATUS_LABEL[s] }))}
      selectSize={size}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

export function PrioritySelect({
  value,
  onChange,
  size = 'md',
  disabled,
  busy,
  id,
}: {
  value: TaskPriority;
  onChange: (value: TaskPriority) => void;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** A save is running: announced, while the select stays enabled so keyboard focus stays put. */
  busy?: boolean;
  id?: string;
}) {
  return (
    <Select
      id={id}
      value={value}
      options={TASK_PRIORITIES.map((p) => ({ value: p, label: TASK_PRIORITY_LABEL[p] }))}
      selectSize={size}
      aria-label="Priority"
      aria-busy={busy || undefined}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------------------------

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  async function confirm() {
    setPending(true);
    try {
      if (await onConfirm()) onClose();
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      dismissible={!pending}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} pending={pending} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Actions with feedback
// ---------------------------------------------------------------------------------------------

/**
 * One id per draft. `id()` returns the same id until `done()` is called after the create
 * succeeds, so pressing Create again after a lost response finds the row that landed instead of
 * creating a second one (see `insertOnce`).
 */
export function useDraftId(): { readonly id: () => string; readonly done: () => void } {
  const current = useRef<string | null>(null);
  return useMemo(
    () => ({
      id: () => (current.current ??= newId()),
      done: () => {
        current.current = null;
      },
    }),
    [],
  );
}

/**
 * Run one mutation at a time with notices: `run(fn, 'Task created')` resolves to the result,
 * or to undefined after showing the problem. Never runs twice concurrently (no double submit).
 */
export function useAction(): {
  run: <T>(fn: () => Promise<T>, success?: string, failurePrefix?: string) => Promise<T | undefined>;
  pending: boolean;
} {
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  // Set again on every setup: StrictMode runs setup, cleanup, setup on mount with the same ref.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async <T,>(fn: () => Promise<T>, success?: string, failurePrefix?: string) => {
    if (busy.current) return undefined;
    busy.current = true;
    setPending(true);
    try {
      const result = await fn();
      if (success) notifySuccess(success);
      return result;
    } catch (error) {
      notifyProblem(asProblem(error), failurePrefix);
      return undefined;
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);
  return { run, pending };
}

/**
 * A task the server just returned (saved, created, or the newer copy behind a conflict) goes into
 * the cached list at once, so the next edit starts from its version and a panel opened on it finds
 * it. The refetch that follows still brings everything else.
 */
export function cacheTask(workspaceId: string, row: Task): void {
  const key = keys.tasks(workspaceId);
  // Not loaded yet: its first load brings the row (a one-row list would pass for the whole list).
  if (readQueryData<Task[]>(key) === undefined) return;
  setQueryData<Task[]>(key, (list) => withRow(list ?? [], row));
}

export function useFieldId(): string {
  return useId();
}
