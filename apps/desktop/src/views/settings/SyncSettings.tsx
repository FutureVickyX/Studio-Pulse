import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { AccountStatus, Route, SyncOverview } from '@studio-pulse/shared-types';
import { currentTimeZone } from '@studio-pulse/time-engine';
import {
  Banner,
  Button,
  Card,
  Field,
  IconCloud,
  IconPlus,
  IconRefresh,
  Select,
  SkeletonLines,
  StatusDot,
  TextInput,
} from '@studio-pulse/ui';
import type { SelectOption, StatusTone } from '@studio-pulse/ui';
import { ErrorBanner, InlineError, SettingRow } from '../../components/common';
import { storeAccount, storeSyncOverview, useAccount, useCommandAction, useSyncStatus } from '../../hooks/useCloud';
import type { CloudResource } from '../../hooks/useCloud';
import { useNow } from '../../hooks/useLive';
import {
  accountName,
  addedWorkspaces,
  inviteCodeError,
  NAME_MAX_LENGTH,
  normalizeInviteCode,
  normalizeName,
  ROLE_LABELS,
  workspaceNameError,
} from '../../lib/account';
import { call } from '../../lib/api';
import { count, dateTime, parseIso, plural } from '../../lib/format';
import {
  canSyncNow,
  claimDismissKey,
  claimPrompt,
  claimQuestion,
  describeSyncPhase,
  relativeSchedule,
  relativeTime,
} from '../../lib/sync';
import { AuthCard, SignOutButton } from './accountForms';

/** Settings › Sync: account, sync workspace, consent for earlier history, and the uploader's state. */
export function SyncSettings({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const account = useAccount();
  const sync = useSyncStatus();

  if (!account.data) {
    return account.error ? (
      <ErrorBanner title="Account status is unavailable" error={account.error} onRetry={() => void account.reload()} />
    ) : (
      <SkeletonLines lines={5} label="Loading account" />
    );
  }

  const status = account.data;
  switch (status.state) {
    case 'notConfigured':
      return <NotConfigured configurationError={status.configurationError} />;
    case 'signedOut':
      return (
        <>
          <AuthCard
            key="sign-in"
            title="Sign in to sync"
            description="Sync uploads closed intervals from this device to a workspace you choose. Until you sign in and choose one, nothing leaves this device."
          />
          <SignedOutHistoryNote overview={sync.data} />
        </>
      );
    case 'sessionExpired':
      return (
        <>
          <Banner
            tone="warning"
            title="Your session expired"
            action={<SignOutButton label="Use another account" variant="ghost" />}
          >
            Sign in again to resume syncing. Nothing was deleted: everything recorded meanwhile stays on this device
            {sync.data && sync.data.pendingCount > 0
              ? ` (${plural(sync.data.pendingCount, 'interval', 'intervals')} waiting to upload)`
              : ''}
            .
          </Banner>
          {/* Keyed by email: the form always starts prefilled with the expired session's address. */}
          <AuthCard
            key={`sign-in-again:${status.email ?? ''}`}
            title="Sign in again"
            initialEmail={status.email ?? ''}
            allowSignUp={false}
          />
        </>
      );
    case 'signedIn':
      return <SignedIn account={status} sync={sync} onNavigate={onNavigate} />;
  }
}

// ---------------------------------------------------------------------------------------------
// Not configured / signed out
// ---------------------------------------------------------------------------------------------

function NotConfigured({ configurationError }: { configurationError: string | null }) {
  return (
    <Card>
      <div className="app-phase-note">
        <span className="app-phase-note__icon" aria-hidden="true">
          <IconCloud size={18} />
        </span>
        <div>
          <p className="app-phase-note__title">Sync isn’t configured in this build</p>
          <p className="app-phase-note__text">
            This copy of Studio Pulse has no usable sync server configuration, so there is nothing to sign in to.
            Tracking works normally and everything stays on this device.
          </p>
          {configurationError ? (
            <p className="app-setting__mono app-cloud__detail">
              <span className="sp-faint">Details </span>
              <code className="sp-mono">{configurationError}</code>
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/**
 * While signed out, what can be waiting is history linked to no account (recorded while signed
 * out). It uploads only after a sign-in and an explicit claim, so this is a note, not an alert.
 */
function SignedOutHistoryNote({ overview }: { overview: SyncOverview | undefined }) {
  if (!overview || overview.unclaimedCount === 0) return null;
  return (
    <p className="app-footnote">
      {plural(overview.unclaimedCount, 'interval', 'intervals')} recorded on this device{' '}
      {overview.unclaimedCount === 1 ? 'isn’t' : 'aren’t'} linked to any account. After you sign in, you decide whether to
      upload {overview.unclaimedCount === 1 ? 'it' : 'them'}.
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// Signed in
// ---------------------------------------------------------------------------------------------

function SignedIn({
  account,
  sync,
  onNavigate,
}: {
  account: AccountStatus;
  sync: CloudResource<SyncOverview>;
  onNavigate: (route: Route) => void;
}) {
  const [claimedNotice, setClaimedNotice] = useState<string | null>(null);
  return (
    <>
      <Card
        title="Account"
        actions={<SignOutButton />}
      >
        <div className="app-account">
          <span className="app-account__avatar" aria-hidden="true">
            {accountName(account).charAt(0).toUpperCase()}
          </span>
          <div className="app-account__text">
            <p className="app-account__name sp-truncate">{accountName(account)}</p>
            {account.email && account.email !== accountName(account) ? (
              <p className="app-account__email sp-truncate">{account.email}</p>
            ) : null}
          </div>
        </div>
      </Card>

      {sync.data ? (
        <ClaimHistoryCard account={account} overview={sync.data} onClaimed={setClaimedNotice} />
      ) : null}
      {claimedNotice ? (
        <Banner tone="success" compact>
          {claimedNotice}
        </Banner>
      ) : null}

      <WorkspaceCard account={account} onNavigate={onNavigate} />

      <SyncStatusCard sync={sync} />

      <AddWorkspaceCard account={account} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Consent: intervals recorded while signed out (never uploaded automatically)
// ---------------------------------------------------------------------------------------------

/**
 * "Keep local only" answers, for this app session only: the question comes back after a restart.
 * Module scope (not component state) so switching settings tabs doesn't ask again.
 */
const dismissedClaims = new Set<string>();

function ClaimHistoryCard({
  account,
  overview,
  onClaimed,
}: {
  account: AccountStatus;
  overview: SyncOverview;
  onClaimed: (notice: string) => void;
}) {
  const [, rerender] = useState(0);
  const claim = useCommandAction(() => call('claim_local_history'));
  const titleId = useId();
  const prompt = claimPrompt(account, overview, dismissedClaims);
  if (prompt.kind === 'none') return null;

  const n = prompt.count;
  if (prompt.kind === 'chooseWorkspace') {
    return (
      <Banner tone="info" title="Earlier history on this device">
        {plural(n, 'interval was', 'intervals were')} recorded on this device while no account was signed in. Choose a
        sync workspace below first; then you decide whether to upload {n === 1 ? 'it' : 'them'}. Nothing is uploaded
        without your consent.
      </Banner>
    );
  }

  const { workspaceName } = prompt;
  // Captured now: the answer applies to exactly the history the user was asked about.
  const dismissKey = claimDismissKey(account.userId, n);

  // Only this click uploads earlier history; nothing calls `claim_local_history` on its own.
  async function upload() {
    const result = await claim.run();
    if (!result) return;
    storeSyncOverview(result);
    onClaimed(
      `The earlier history now belongs to your account and uploads to ${workspaceName ? `“${workspaceName}”` : 'your sync workspace'}.`,
    );
  }

  function keepLocal() {
    dismissedClaims.add(dismissKey);
    rerender((value) => value + 1);
  }

  return (
    <section className="app-consent" aria-labelledby={titleId}>
      <h2 className="app-consent__title" id={titleId}>
        Upload earlier history?
      </h2>
      <p className="app-consent__text">{claimQuestion(n, workspaceName, { formatCount: count })}</p>
      <p className="app-consent__hint">
        Uploading adds {n === 1 ? 'it' : 'them'} to your account with the same fields and privacy as everything else you
        sync. If you keep {n === 1 ? 'it' : 'them'} local, nothing is uploaded; you’ll be asked again the next time Studio
        Pulse starts.
      </p>
      <div className="app-button-row">
        <Button variant="primary" icon={<IconCloud size={14} />} pending={claim.pending} onClick={() => void upload()}>
          Upload
        </Button>
        <Button disabled={claim.pending} onClick={keepLocal}>
          Keep local only
        </Button>
      </div>
      <InlineError error={claim.error} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Sync workspace picker
// ---------------------------------------------------------------------------------------------

const NO_WORKSPACE = '';

function WorkspaceCard({ account, onNavigate }: { account: AccountStatus; onNavigate: (route: Route) => void }) {
  const select = useCommandAction((workspaceId: string | null) => call('select_sync_workspace', { workspaceId }));
  const refresh = useCommandAction(() => call('refresh_workspaces'));
  const selectedId = account.syncWorkspaceId ?? NO_WORKSPACE;
  const known = account.workspaces.some((workspace) => workspace.id === selectedId);

  const options: SelectOption<string>[] = [
    { value: NO_WORKSPACE, label: 'Don’t sync (keep everything on this device)' },
    ...account.workspaces.map((workspace) => ({ value: workspace.id, label: `${workspace.name} · ${ROLE_LABELS[workspace.role]}` })),
  ];
  if (selectedId !== NO_WORKSPACE && !known) {
    options.push({ value: selectedId, label: 'Selected workspace (details unavailable — refresh)' });
  }

  async function choose(value: string) {
    if (select.pending || value === selectedId) return;
    const result = await select.run(value === NO_WORKSPACE ? null : value);
    if (result) storeAccount(result);
  }

  async function reload() {
    const result = await refresh.run();
    if (result) storeAccount(result);
  }

  const description =
    selectedId === NO_WORKSPACE
      ? 'Nothing is uploaded until you choose a workspace.'
      : 'Closed intervals from this device upload here. The interval being recorded uploads after it closes.';

  return (
    <Card
      title="Sync workspace"
      actions={
        <Button size="sm" variant="ghost" icon={<IconRefresh size={13} />} pending={refresh.pending} onClick={() => void reload()}>
          Refresh
        </Button>
      }
    >
      {account.workspaces.length === 0 && selectedId === NO_WORKSPACE ? (
        <p className="app-setting__status">
          No workspace is known for this account yet. Create one or join with an invitation code below. If you already
          belong to one, choose Refresh.
        </p>
      ) : (
        <SettingRow
          title="Upload to"
          description={description}
          control={({ controlId, descriptionId }) => (
            <Select<string>
              id={controlId}
              className="app-cloud__select"
              value={selectedId}
              options={options}
              aria-describedby={descriptionId}
              aria-busy={select.pending || undefined}
              onChange={(value) => void choose(value)}
            />
          )}
        >
          {select.pending ? (
            <p className="app-setting__status" role="status">
              Saving your choice…
            </p>
          ) : null}
          <InlineError error={select.error} />
          {known ? (
            <p className="app-setting__status">
              Manage this workspace in{' '}
              <button type="button" className="app-link" onClick={() => onNavigate('settings/workspace')}>
                Settings › Workspace
              </button>
              .
            </p>
          ) : null}
        </SettingRow>
      )}
      <InlineError error={refresh.error} />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Create or join a workspace
// ---------------------------------------------------------------------------------------------

function AddWorkspaceCard({ account }: { account: AccountStatus }) {
  return (
    <Card title="Add a workspace" description="Create a workspace for your studio, or join one with an invitation code.">
      <div className="app-cloud__forms">
        <CreateWorkspaceForm account={account} />
        <JoinWorkspaceForm account={account} />
      </div>
    </Card>
  );
}

function CreateWorkspaceForm({ account }: { account: AccountStatus }) {
  const [name, setName] = useState('');
  const [showError, setShowError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const create = useCommandAction((value: string) => call('create_workspace', { name: value }));
  const id = useId();
  const error = workspaceNameError(name);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (create.pending) return;
    setNotice(null);
    if (error) {
      setShowError(true);
      return;
    }
    setShowError(false);
    const result = await create.run(normalizeName(name));
    if (!result) return;
    const added = addedWorkspaces(account.workspaces, result.workspaces)[0];
    storeAccount(result);
    setName('');
    const label = `“${added?.name ?? normalizeName(name)}”`;
    setNotice(
      added && result.syncWorkspaceId === added.id
        ? `Created ${label}. It is now your sync workspace.`
        : `Created ${label}. You are its owner.`,
    );
  }

  return (
    <form className="app-cloud__form" onSubmit={(event) => void submit(event)} noValidate>
      <h3 className="app-list-title">Create a workspace</h3>
      <Field
        label="Workspace name"
        htmlFor={id}
        hint="You become its owner. If no sync workspace is chosen yet, this one is selected."
        error={showError ? error ?? undefined : undefined}
        errorId={`${id}-error`}
      >
        <TextInput
          id={id}
          value={name}
          maxLength={NAME_MAX_LENGTH * 2}
          readOnly={create.pending}
          invalid={showError && error !== null}
          aria-describedby={showError && error ? `${id}-error` : undefined}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </Field>
      <div className="app-button-row">
        <Button type="submit" icon={<IconPlus size={14} />} pending={create.pending}>
          Create workspace
        </Button>
      </div>
      <InlineError error={create.error} />
      {notice ? (
        <p className="app-setting__status" role="status">
          {notice}
        </p>
      ) : null}
    </form>
  );
}

function JoinWorkspaceForm({ account }: { account: AccountStatus }) {
  const [code, setCode] = useState('');
  const [showError, setShowError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const accept = useCommandAction((token: string) => call('accept_invitation', { token }));
  const id = useId();
  const error = inviteCodeError(code);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (accept.pending) return;
    setNotice(null);
    if (error) {
      setShowError(true);
      return;
    }
    setShowError(false);
    const result = await accept.run(normalizeInviteCode(code));
    if (!result) return;
    const joined = addedWorkspaces(account.workspaces, result.workspaces)[0];
    storeAccount(result);
    setCode('');
    if (!joined) setNotice('Invitation accepted.');
    else if (result.syncWorkspaceId === joined.id) setNotice(`Joined “${joined.name}” as ${ROLE_LABELS[joined.role].toLowerCase()}. It is now your sync workspace.`);
    else setNotice(`Joined “${joined.name}” as ${ROLE_LABELS[joined.role].toLowerCase()}. Choose it above to upload your time there.`);
  }

  return (
    <form className="app-cloud__form" onSubmit={(event) => void submit(event)} noValidate>
      <h3 className="app-list-title">Join with an invitation code</h3>
      <Field
        label="Invitation code"
        htmlFor={id}
        hint={`A code works once, for the email address it was sent to${account.email ? ` (yours is ${account.email})` : ''}.`}
        error={showError ? error ?? undefined : undefined}
        errorId={`${id}-error`}
      >
        <TextInput
          id={id}
          mono
          value={code}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          readOnly={accept.pending}
          invalid={showError && error !== null}
          aria-describedby={showError && error ? `${id}-error` : undefined}
          onChange={(event) => setCode(event.currentTarget.value)}
        />
      </Field>
      <div className="app-button-row">
        <Button type="submit" pending={accept.pending}>
          Join workspace
        </Button>
      </div>
      <InlineError error={accept.error} />
      {notice ? (
        <p className="app-setting__status" role="status">
          {notice}
        </p>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Sync status panel
// ---------------------------------------------------------------------------------------------

function SyncStatusCard({ sync }: { sync: CloudResource<SyncOverview> }) {
  const syncNow = useCommandAction(() => call('sync_now'));
  const overview = sync.data;
  const available = overview ? canSyncNow(overview.phase) : false;

  async function run() {
    const result = await syncNow.run();
    if (result) storeSyncOverview(result);
  }

  return (
    <Card
      title="Sync status"
      actions={
        overview ? (
          <Button
            size="sm"
            icon={<IconRefresh size={13} />}
            pending={syncNow.pending}
            disabled={!available}
            title={available ? 'Upload waiting intervals now instead of at the next scheduled attempt' : 'Sync can’t run until the step above is done'}
            onClick={() => void run()}
          >
            Sync now
          </Button>
        ) : null
      }
    >
      {overview ? <SyncPanel overview={overview} /> : null}
      <InlineError error={syncNow.error} />
      {!overview && sync.error ? (
        <ErrorBanner title="Sync status is unavailable" error={sync.error} onRetry={() => void sync.reload()} />
      ) : null}
      {!overview && !sync.error ? <SkeletonLines lines={4} label="Loading sync status" /> : null}
    </Card>
  );
}

function SyncPanel({ overview }: { overview: SyncOverview }) {
  const now = useNow(30_000);
  const timeZone = currentTimeZone();
  const phase = describeSyncPhase(overview, { formatCount: count });

  /** Local date and time plus a relative hint. Past events never read "in …" (clock skew). */
  function when(iso: string | null, empty: string, kind: 'past' | 'scheduled') {
    const ms = parseIso(iso);
    if (ms === null) return empty;
    const relative = kind === 'past' ? relativeTime(Math.min(ms, now), now) : relativeSchedule(ms, now);
    return `${dateTime(iso, timeZone)} (${relative})`;
  }

  return (
    <>
      <div className="app-sync-phase" role="status" aria-live="polite">
        <span className="app-status-label">
          <StatusDot tone={phase.tone as StatusTone} />
          <span>{phase.label}</span>
        </span>
        <p className="app-setting__status">{phase.explanation}</p>
      </div>
      {overview.lastError ? (
        <Banner tone={overview.phase === 'error' ? 'danger' : 'warning'} compact title="Last problem">
          {overview.lastError}
        </Banner>
      ) : null}
      <dl className="app-facts app-facts--spaced">
        <div>
          <dt>Workspace</dt>
          <dd className="sp-truncate">{overview.workspaceName ?? 'None chosen'}</dd>
        </div>
        <div>
          <dt>Waiting to upload</dt>
          <dd className="sp-num">{count(overview.pendingCount)}</dd>
        </div>
        <div>
          <dt>Last successful sync</dt>
          <dd>{when(overview.lastSuccessAt, 'Never', 'past')}</dd>
        </div>
        <div>
          <dt>Next attempt</dt>
          <dd>{when(overview.nextAttemptAt, 'Not scheduled', 'scheduled')}</dd>
        </div>
        <div>
          <dt>Recorded while signed out</dt>
          <dd className="sp-num">
            {count(overview.unclaimedCount)}
            {overview.unclaimedCount > 0 ? <span className="sp-faint"> (uploaded only if you agree)</span> : null}
          </dd>
        </div>
        <div>
          <dt>Rejected by the server</dt>
          <dd className="sp-num">{count(overview.rejectedCount)}</dd>
        </div>
        <div>
          <dt>Last attempt</dt>
          <dd>{when(overview.lastAttemptAt, 'None yet', 'past')}</dd>
        </div>
      </dl>
      {overview.rejectedCount > 0 ? (
        <p className="app-footnote app-sync-footnote">
          Rejected intervals failed the server’s checks. They are kept on this device and are not retried automatically.
        </p>
      ) : null}
    </>
  );
}
