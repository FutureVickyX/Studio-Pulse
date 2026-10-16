import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { APP_CATEGORIES, APP_CATEGORY_LABELS } from '@studio-pulse/shared-types';
import type {
  AppCategory,
  ApplicationDefinition,
  ApplicationInput,
  ProcessMatcher,
  RunningApplication,
} from '@studio-pulse/shared-types';
import { exePatternError, validateApplicationInput } from '@studio-pulse/validation';
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  IconApps,
  IconButton,
  IconFolderOpen,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconTrash,
  Select,
  SkeletonLines,
  Switch,
  TextInput,
} from '@studio-pulse/ui';
import type { SelectOption } from '@studio-pulse/ui';
import { ErrorBanner, InlineError } from '../../components/common';
import { useApplications } from '../../hooks/useLive';
import { ApiError, call, toCommandError } from '../../lib/api';

const CATEGORY_OPTIONS: ReadonlyArray<SelectOption<AppCategory>> = APP_CATEGORIES.map((category) => ({
  value: category,
  label: APP_CATEGORY_LABELS[category],
}));

const MAX_MATCHERS = 16;

function toInput(app: ApplicationDefinition, changes: Partial<ApplicationInput> = {}): ApplicationInput {
  return {
    id: app.id,
    displayName: app.displayName,
    category: app.category,
    matchers: app.matchers.map((matcher) => ({ exe: matcher.exe, pathIncludes: matcher.pathIncludes ?? null })),
    enabled: app.enabled,
    includeInReports: app.includeInReports,
    ...changes,
  };
}

/** Validate, save, and return the confirmed definition. Rejects with `ApiError`. */
async function saveApplication(input: ApplicationInput): Promise<ApplicationDefinition> {
  const checked = validateApplicationInput(input);
  if (!checked.ok) throw new ApiError('validation', checked.issues.join(' '));
  return call('save_application', { input: checked.value });
}

function matcherSummary(matchers: readonly ProcessMatcher[]): string {
  const first = matchers[0];
  if (!first) return 'No matchers';
  const head = first.pathIncludes ? `${first.exe} in …${first.pathIncludes}…` : first.exe;
  return matchers.length > 1 ? `${head} +${matchers.length - 1}` : head;
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

type DialogState =
  | { kind: 'none' }
  | { kind: 'matchers'; app: ApplicationDefinition }
  | { kind: 'add' }
  | { kind: 'reset' }
  | { kind: 'delete'; app: ApplicationDefinition };

export function ApplicationsSettings() {
  const applications = useApplications();
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
  const [notice, setNotice] = useState<string | null>(null);
  const searchId = useId();

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = (applications.data ?? [])
      .filter(
        (app) =>
          !needle ||
          app.displayName.toLowerCase().includes(needle) ||
          app.matchers.some((matcher) => matcher.exe.toLowerCase().includes(needle)),
      )
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
    return APP_CATEGORIES.map((category) => ({
      category,
      apps: list.filter((app) => app.category === category),
    })).filter((group) => group.apps.length > 0);
  }, [applications.data, query]);

  const enabledCount = (applications.data ?? []).filter((app) => app.enabled).length;
  const close = () => setDialog({ kind: 'none' });

  return (
    <>
      <div className="app-toolbar">
        <div className="app-search">
          <IconSearch size={14} className="app-search__icon" />
          <label htmlFor={searchId} className="sp-visually-hidden">
            Search applications
          </label>
          <TextInput
            id={searchId}
            type="search"
            inputSize="sm"
            placeholder="Search applications or .exe names"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <div className="app-toolbar__actions">
          <Button size="sm" variant="ghost" icon={<IconRefresh size={14} />} onClick={() => setDialog({ kind: 'reset' })}>
            Reset to defaults
          </Button>
          <Button size="sm" variant="primary" icon={<IconPlus size={14} />} onClick={() => setDialog({ kind: 'add' })}>
            Add application
          </Button>
        </div>
      </div>

      {notice ? (
        <Banner tone="success" compact action={<Button size="sm" variant="ghost" onClick={() => setNotice(null)}>Dismiss</Button>}>
          {notice}
        </Banner>
      ) : null}

      {applications.error ? (
        <ErrorBanner
          title="Applications could not be loaded"
          error={applications.error}
          onRetry={() => void applications.reload()}
          retrying={applications.loading}
        />
      ) : null}

      {applications.data ? (
        <p className="app-count-note">
          {enabledCount} of {applications.data.length} applications tracked. Only the matched application name is stored
          with each interval, never the executable path.
        </p>
      ) : null}

      {!applications.data && !applications.error ? (
        <Card>
          <SkeletonLines lines={6} label="Loading applications" />
        </Card>
      ) : null}

      {applications.data && groups.length === 0 ? (
        <Card>
          <EmptyState icon={<IconApps size={18} />} title={query ? 'No matching applications' : 'No applications'}>
            {query ? 'Try another name, or add the application.' : 'Add an application or reset to the defaults.'}
          </EmptyState>
        </Card>
      ) : null}

      {groups.map((group) => (
        <Card key={group.category} title={APP_CATEGORY_LABELS[group.category]} flush headingLevel={3}>
          <div className="app-apps__head" aria-hidden="true">
            <span>Application</span>
            <span>Category</span>
            <span>Tracked</span>
            <span>In reports</span>
            <span />
          </div>
          <ul className="app-apps">
            {group.apps.map((app) => (
              <ApplicationRow
                key={app.id}
                app={app}
                onEditMatchers={() => setDialog({ kind: 'matchers', app })}
                onDelete={() => setDialog({ kind: 'delete', app })}
                onSaved={applications.upsert}
              />
            ))}
          </ul>
        </Card>
      ))}

      <MatchersDialog
        app={dialog.kind === 'matchers' ? dialog.app : null}
        onClose={close}
        onSaved={(saved) => {
          applications.upsert(saved);
          close();
        }}
      />
      <AddApplicationDialog
        open={dialog.kind === 'add'}
        applications={applications.data ?? []}
        onClose={close}
        onSaved={(saved) => {
          applications.upsert(saved);
          setNotice(`${saved.displayName} added${saved.enabled ? ' and tracked' : ''}.`);
          close();
        }}
      />
      <ResetDialog
        open={dialog.kind === 'reset'}
        hasCustom={(applications.data ?? []).some((app) => !app.builtIn)}
        onClose={close}
        onReset={(list) => {
          applications.replaceAll(list);
          setNotice('Built-in applications were restored to their defaults.');
          close();
        }}
      />
      <DeleteDialog
        app={dialog.kind === 'delete' ? dialog.app : null}
        onClose={close}
        onDeleted={(id, name) => {
          applications.remove(id);
          setNotice(`${name} was removed.`);
          close();
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------------------------

function ApplicationRow({
  app,
  onEditMatchers,
  onDelete,
  onSaved,
}: {
  app: ApplicationDefinition;
  onEditMatchers: () => void;
  onDelete: () => void;
  onSaved: (app: ApplicationDefinition) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [renaming, setRenaming] = useState(false);
  const enabledId = useId();
  const reportsId = useId();

  async function save(field: string, changes: Partial<ApplicationInput>): Promise<boolean> {
    setPending(field);
    setError(null);
    try {
      onSaved(await saveApplication(toInput(app, changes)));
      return true;
    } catch (caught) {
      setError(toCommandError(caught));
      return false;
    } finally {
      setPending(null);
    }
  }

  return (
    <li className="app-apps__row" data-off={!app.enabled || undefined}>
      <div className="app-apps__name">
        {renaming ? (
          <RenameInput
            value={app.displayName}
            pending={pending === 'name'}
            onCancel={() => setRenaming(false)}
            onSubmit={async (displayName) => {
              if (displayName === app.displayName) {
                setRenaming(false);
                return;
              }
              if (await save('name', { displayName })) setRenaming(false);
            }}
          />
        ) : (
          <>
            <span className="app-apps__title">
              <span className="sp-truncate" title={app.displayName}>
                {app.displayName}
              </span>
              {!app.builtIn ? <Badge tone="subtle">Custom</Badge> : null}
              <IconButton
                size="sm"
                label={`Rename ${app.displayName}`}
                icon={<IconPencil size={13} />}
                className="app-apps__rename"
                onClick={() => setRenaming(true)}
              />
            </span>
            <span className="app-apps__matchers sp-mono sp-truncate" title={app.matchers.map((m) => m.exe).join(', ')}>
              {matcherSummary(app.matchers)}
            </span>
          </>
        )}
      </div>
      <Select<AppCategory>
        selectSize="sm"
        aria-label={`Category for ${app.displayName}`}
        options={CATEGORY_OPTIONS}
        value={app.category}
        disabled={pending !== null}
        className="app-apps__category"
        onChange={(category) => void save('category', { category })}
      />
      <span className="app-apps__switch">
        <label htmlFor={enabledId} className="sp-visually-hidden">
          Track {app.displayName}
        </label>
        <Switch
          id={enabledId}
          checked={app.enabled}
          pending={pending === 'enabled'}
          disabled={pending !== null && pending !== 'enabled'}
          onChange={(enabled) => void save('enabled', { enabled })}
        />
      </span>
      <span className="app-apps__switch">
        <label htmlFor={reportsId} className="sp-visually-hidden">
          Show {app.displayName} in reports
        </label>
        <Switch
          id={reportsId}
          checked={app.includeInReports}
          pending={pending === 'reports'}
          disabled={pending !== null && pending !== 'reports'}
          onChange={(includeInReports) => void save('reports', { includeInReports })}
        />
      </span>
      <span className="app-apps__actions">
        <IconButton size="sm" label={`Edit matchers for ${app.displayName}`} icon={<IconSettings size={14} />} onClick={onEditMatchers} />
        {!app.builtIn ? (
          <IconButton size="sm" label={`Delete ${app.displayName}`} icon={<IconTrash size={14} />} onClick={onDelete} />
        ) : null}
      </span>
      {error ? (
        <div className="app-apps__error">
          <InlineError error={error} />
        </div>
      ) : null}
    </li>
  );
}

function RenameInput({
  value,
  pending,
  onSubmit,
  onCancel,
}: {
  value: string;
  pending: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      onSubmit(draft.trim());
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelled.current = true;
      onCancel();
    }
  }

  return (
    <TextInput
      ref={ref}
      inputSize="sm"
      aria-label="Application name"
      value={draft}
      maxLength={80}
      disabled={pending}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={onKeyDown}
      onBlur={() => {
        if (!cancelled.current && !pending) onSubmit(draft.trim());
      }}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Matcher editor (shared by the matchers and add dialogs)
// ---------------------------------------------------------------------------------------------

interface MatcherDraft {
  key: number;
  exe: string;
  pathIncludes: string;
}

let matcherKey = 0;

function toDrafts(matchers: readonly ProcessMatcher[]): MatcherDraft[] {
  return matchers.map((matcher) => ({ key: ++matcherKey, exe: matcher.exe, pathIncludes: matcher.pathIncludes ?? '' }));
}

function fromDrafts(drafts: readonly MatcherDraft[]): ProcessMatcher[] {
  return drafts.map((draft) => ({
    exe: draft.exe.trim(),
    pathIncludes: draft.pathIncludes.trim() ? draft.pathIncludes.trim() : null,
  }));
}

function draftErrors(drafts: readonly MatcherDraft[]): Array<string | null> {
  return drafts.map((draft) => exePatternError(draft.exe.trim()));
}

function MatcherEditor({
  drafts,
  onChange,
  showErrors,
}: {
  drafts: MatcherDraft[];
  onChange: (drafts: MatcherDraft[]) => void;
  showErrors: boolean;
}) {
  const errors = draftErrors(drafts);
  const update = (key: number, changes: Partial<MatcherDraft>) =>
    onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...changes } : draft)));

  return (
    <div className="app-matchers">
      <div className="app-matchers__head" aria-hidden="true">
        <span>Executable (.exe, * wildcard allowed)</span>
        <span>Path contains (optional)</span>
      </div>
      {drafts.map((draft, index) => {
        const error = showErrors || draft.exe ? errors[index] : null;
        return (
          <div key={draft.key} className="app-matchers__row">
            <TextInput
              inputSize="sm"
              mono
              aria-label={`Executable pattern ${index + 1}`}
              placeholder="Photoshop.exe"
              value={draft.exe}
              invalid={!!error}
              onChange={(event) => update(draft.key, { exe: event.currentTarget.value })}
            />
            <TextInput
              inputSize="sm"
              mono
              aria-label={`Path contains ${index + 1}`}
              placeholder="e.g. Affinity"
              value={draft.pathIncludes}
              onChange={(event) => update(draft.key, { pathIncludes: event.currentTarget.value })}
            />
            <IconButton
              size="sm"
              label={`Remove matcher ${index + 1}`}
              icon={<IconTrash size={13} />}
              disabled={drafts.length <= 1}
              onClick={() => onChange(drafts.filter((item) => item.key !== draft.key))}
            />
            {error ? (
              <p className="app-inline-error app-matchers__error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
      <Button
        size="sm"
        variant="ghost"
        icon={<IconPlus size={13} />}
        disabled={drafts.length >= MAX_MATCHERS}
        onClick={() => onChange([...drafts, { key: ++matcherKey, exe: '', pathIncludes: '' }])}
      >
        Add matcher
      </Button>
      <p className="app-field-hint">
        Matching is case-insensitive. A matcher with a path wins over one without, and an exact name wins over a wildcard.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------------

function MatchersDialog({
  app,
  onClose,
  onSaved,
}: {
  app: ApplicationDefinition | null;
  onClose: () => void;
  onSaved: (app: ApplicationDefinition) => void;
}) {
  const [drafts, setDrafts] = useState<MatcherDraft[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (app) {
      setDrafts(toDrafts(app.matchers));
      setError(null);
      setShowErrors(false);
    }
  }, [app]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!app) return;
    setShowErrors(true);
    if (draftErrors(drafts).some((item) => item !== null)) return;
    setPending(true);
    setError(null);
    try {
      onSaved(await saveApplication(toInput(app, { matchers: fromDrafts(drafts) })));
    } catch (caught) {
      setError(toCommandError(caught));
    } finally {
      setPending(false);
    }
  }

  const formId = useId();
  return (
    <Dialog
      open={app !== null}
      onClose={onClose}
      size="md"
      dismissible={!pending}
      title={app ? `Matchers for ${app.displayName}` : 'Matchers'}
      description="Studio Pulse recognises this application when the foreground process matches any row."
      footerStart={<InlineError error={error} />}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" pending={pending}>
            Save matchers
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        <MatcherEditor drafts={drafts} onChange={setDrafts} showErrors={showErrors} />
      </form>
    </Dialog>
  );
}

function defaultName(exeName: string): string {
  const base = exeName.replace(/\.exe$/i, '').replace(/[-_]+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : exeName;
}

function AddApplicationDialog({
  open,
  applications,
  onClose,
  onSaved,
}: {
  open: boolean;
  applications: readonly ApplicationDefinition[];
  onClose: () => void;
  onSaved: (app: ApplicationDefinition) => void;
}) {
  const [step, setStep] = useState<'source' | 'details'>('source');
  const [running, setRunning] = useState<RunningApplication[] | null>(null);
  const [runningError, setRunningError] = useState<ApiError | null>(null);
  const [loadingRunning, setLoadingRunning] = useState(false);
  const [browsePending, setBrowsePending] = useState(false);
  const [filter, setFilter] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<AppCategory>('other');
  const [drafts, setDrafts] = useState<MatcherDraft[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [includeInReports, setIncludeInReports] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const formId = useId();
  const nameId = useId();
  const categoryId = useId();

  const appNames = useMemo(() => new Map(applications.map((app) => [app.id, app])), [applications]);

  async function loadRunning() {
    setLoadingRunning(true);
    setRunningError(null);
    try {
      const list = await call('list_running_applications');
      list.sort((a, b) => Number(!!a.matchedApplicationId) - Number(!!b.matchedApplicationId) || a.exeName.localeCompare(b.exeName));
      setRunning(list);
    } catch (caught) {
      setRunningError(toCommandError(caught));
    } finally {
      setLoadingRunning(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setStep('source');
    setFilter('');
    setError(null);
    setRunning(null);
    setShowErrors(false);
    void loadRunning();
  }, [open]);

  function choose(source: RunningApplication) {
    setName(defaultName(source.exeName));
    setCategory('other');
    setDrafts(toDrafts([{ exe: source.exeName, pathIncludes: null }]));
    setEnabled(true);
    setIncludeInReports(true);
    setError(null);
    setShowErrors(false);
    setStep('details');
  }

  function startBlank() {
    setName('');
    setCategory('other');
    setDrafts(toDrafts([{ exe: '', pathIncludes: null }]));
    setEnabled(true);
    setIncludeInReports(true);
    setError(null);
    setShowErrors(false);
    setStep('details');
  }

  async function browse() {
    setBrowsePending(true);
    setRunningError(null);
    try {
      const picked = await call('pick_executable');
      if (picked) choose(picked);
    } catch (caught) {
      setRunningError(toCommandError(caught));
    } finally {
      setBrowsePending(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setShowErrors(true);
    if (draftErrors(drafts).some((item) => item !== null) || !name.trim()) return;
    setPending(true);
    setError(null);
    try {
      onSaved(
        await saveApplication({
          id: null,
          displayName: name.trim(),
          category,
          matchers: fromDrafts(drafts),
          enabled,
          includeInReports,
        }),
      );
    } catch (caught) {
      setError(toCommandError(caught));
    } finally {
      setPending(false);
    }
  }

  const visible = (running ?? []).filter((item) => {
    const needle = filter.trim().toLowerCase();
    return !needle || item.exeName.toLowerCase().includes(needle) || item.path.toLowerCase().includes(needle);
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      dismissible={!pending && !browsePending}
      title="Add application"
      description={
        step === 'source'
          ? 'Pick a running app or browse for its .exe. Paths are used for matching only and are not stored with your time.'
          : 'Name it and check how Studio Pulse recognises it.'
      }
      footerStart={step === 'details' ? <InlineError error={error} /> : null}
      footer={
        step === 'source' ? (
          <>
            <Button variant="ghost" onClick={startBlank}>
              Enter manually
            </Button>
            <Button icon={<IconFolderOpen size={14} />} pending={browsePending} onClick={() => void browse()}>
              Browse for .exe
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => setStep('source')} disabled={pending}>
              Back
            </Button>
            <Button type="submit" form={formId} variant="primary" pending={pending}>
              Add application
            </Button>
          </>
        )
      }
    >
      {step === 'source' ? (
        <div className="app-running">
          <div className="app-running__toolbar">
            <TextInput
              type="search"
              inputSize="sm"
              aria-label="Filter running applications"
              placeholder="Filter running apps"
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
            />
            <Button size="sm" variant="ghost" icon={<IconRefresh size={13} />} pending={loadingRunning} onClick={() => void loadRunning()}>
              Refresh
            </Button>
          </div>
          {runningError ? <InlineError error={runningError} /> : null}
          {running === null && loadingRunning ? <SkeletonLines lines={5} label="Loading running applications" /> : null}
          {running !== null && visible.length === 0 ? (
            <EmptyState compact title={filter ? 'No running app matches' : 'No windowed apps found'}>
              Open the application first, or browse for its .exe.
            </EmptyState>
          ) : null}
          <ul className="app-running__list" aria-label="Running applications">
            {visible.map((item) => {
              const matched = item.matchedApplicationId ? appNames.get(item.matchedApplicationId) : undefined;
              return (
                <li key={`${item.path}|${item.exeName}`}>
                  <button
                    type="button"
                    className="app-running__item"
                    data-matched={item.matchedApplicationId ? true : undefined}
                    onClick={() => choose(item)}
                  >
                    <span className="app-running__exe">{item.exeName}</span>
                    <span className="app-running__path sp-mono" title={item.path}>
                      {item.path}
                    </span>
                    {item.matchedApplicationId ? (
                      <Badge tone="subtle">
                        {matched ? `Already listed as ${matched.displayName}${matched.enabled ? '' : ' (off)'}` : 'Already listed'}
                      </Badge>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <form id={formId} className="app-add-form" onSubmit={submit} noValidate>
          <div className="app-add-form__row">
            <Field label="Name" htmlFor={nameId} error={showErrors && !name.trim() ? 'Enter a name.' : undefined}>
              <TextInput
                id={nameId}
                value={name}
                maxLength={80}
                invalid={showErrors && !name.trim()}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </Field>
            <Field label="Category" htmlFor={categoryId}>
              <Select<AppCategory> id={categoryId} options={CATEGORY_OPTIONS} value={category} onChange={setCategory} />
            </Field>
          </div>
          <MatcherEditor drafts={drafts} onChange={setDrafts} showErrors={showErrors} />
          <div className="app-add-form__checks">
            <Checkbox checked={enabled} onChange={setEnabled} label="Track this application" />
            <Checkbox checked={includeInReports} onChange={setIncludeInReports} label="Show it in reports" />
          </div>
        </form>
      )}
    </Dialog>
  );
}

function ResetDialog({
  open,
  hasCustom,
  onClose,
  onReset,
}: {
  open: boolean;
  hasCustom: boolean;
  onClose: () => void;
  onReset: (applications: ApplicationDefinition[]) => void;
}) {
  const [removeCustom, setRemoveCustom] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (open) {
      setRemoveCustom(false);
      setError(null);
    }
  }, [open]);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      onReset(await call('reset_applications', { removeCustom }));
    } catch (caught) {
      setError(toCommandError(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!pending}
      title="Reset applications to defaults?"
      description="Built-in applications get back their default names, categories, matchers and on/off state."
      footerStart={<InlineError error={error} />}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" pending={pending} onClick={() => void confirm()}>
            Reset
          </Button>
        </>
      }
    >
      <Checkbox
        checked={removeCustom}
        onChange={setRemoveCustom}
        disabled={!hasCustom}
        label="Also remove my custom applications"
        description={hasCustom ? 'Otherwise they are kept as they are.' : 'You have no custom applications.'}
      />
    </Dialog>
  );
}

function DeleteDialog({
  app,
  onClose,
  onDeleted,
}: {
  app: ApplicationDefinition | null;
  onClose: () => void;
  onDeleted: (id: string, name: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (app) setError(null);
  }, [app]);

  async function confirm() {
    if (!app) return;
    setPending(true);
    setError(null);
    try {
      await call('delete_application', { id: app.id });
      onDeleted(app.id, app.displayName);
    } catch (caught) {
      setError(toCommandError(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={app !== null}
      onClose={onClose}
      dismissible={!pending}
      title={app ? `Remove ${app.displayName}?` : 'Remove application?'}
      description="Studio Pulse will stop recognising this application. You can add it again later."
      footerStart={<InlineError error={error} />}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" icon={<IconTrash size={14} />} pending={pending} onClick={() => void confirm()}>
            Remove
          </Button>
        </>
      }
    />
  );
}
