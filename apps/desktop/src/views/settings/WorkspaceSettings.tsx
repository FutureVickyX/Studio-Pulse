import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AccountStatus, InvitationCreated, Route, WorkspaceSummary } from '@studio-pulse/shared-types';
import { currentTimeZone } from '@studio-pulse/time-engine';
import {
  Badge,
  Button,
  Card,
  Field,
  IconCheck,
  IconCopy,
  IconRefresh,
  IconTeam,
  IconUserPlus,
  Select,
  SkeletonLines,
  TextInput,
} from '@studio-pulse/ui';
import { ErrorBanner, InlineError } from '../../components/common';
import { storeAccount, useAccount, useCommandAction } from '../../hooks/useCloud';
import { useNow } from '../../hooks/useLive';
import {
  canInvite,
  describeVisibility,
  emailError,
  inviteRoleOptions,
  normalizeEmail,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  selectedWorkspace,
} from '../../lib/account';
import type { InvitableRole } from '../../lib/account';
import { call } from '../../lib/api';
import { dateTime, parseIso } from '../../lib/format';
import { relativeTime } from '../../lib/sync';

/** Settings › Workspace: the sync workspace, your role, its visibility policy and invitations. */
export function WorkspaceSettings({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const account = useAccount();

  if (!account.data) {
    return account.error ? (
      <ErrorBanner title="Account status is unavailable" error={account.error} onRetry={() => void account.reload()} />
    ) : (
      <SkeletonLines lines={4} label="Loading workspace" />
    );
  }

  const workspace = selectedWorkspace(account.data);
  if (!workspace) return <NoWorkspace account={account.data} onNavigate={onNavigate} />;

  const visibility = describeVisibility(workspace.timeEntryVisibility);
  return (
    <>
      <Card title={workspace.name} description="Your sync workspace. Closed intervals from this device upload here.">
        <dl className="app-facts">
          <div>
            <dt>Your role</dt>
            <dd>
              <Badge tone={workspace.role === 'member' ? 'subtle' : 'accent'}>{ROLE_LABELS[workspace.role]}</Badge>
              <p className="app-facts__note">{ROLE_DESCRIPTIONS[workspace.role]}</p>
            </dd>
          </div>
          <div>
            <dt>Time-entry visibility</dt>
            <dd>
              {visibility.label}
              <p className="app-facts__note">{visibility.description}</p>
            </dd>
          </div>
        </dl>
      </Card>
      {canInvite(workspace.role) ? (
        <InviteCard key={workspace.id} workspace={workspace} />
      ) : (
        <Card title="Invitations">
          <p className="app-setting__status">
            Only owners and admins can invite people. Ask an owner or admin of “{workspace.name}” to invite your teammate.
          </p>
        </Card>
      )}
    </>
  );
}

function NoWorkspace({ account, onNavigate }: { account: AccountStatus; onNavigate: (route: Route) => void }) {
  const refresh = useCommandAction(() => call('refresh_workspaces'));
  let title: string;
  let text: string;
  let action: string | null = 'Open Settings › Sync';
  switch (account.state) {
    case 'notConfigured':
      title = 'Workspaces aren’t available in this build';
      text = 'This copy of Studio Pulse has no sync server configured. Tracking works normally and stays on this device.';
      action = null;
      break;
    case 'signedOut':
      title = 'Sign in to use a workspace';
      text = 'A workspace is shared space for your studio. Sign in under Settings › Sync, then create or join one.';
      break;
    case 'sessionExpired':
      title = 'Your session expired';
      text = 'Sign in again under Settings › Sync to see your workspace. Everything recorded meanwhile stays on this device.';
      break;
    case 'signedIn':
      if (account.syncWorkspaceId) {
        title = 'Workspace details aren’t available';
        text = 'Your sync workspace isn’t in the membership list this device last fetched. Refresh it; if it’s still missing, you may have been removed from the workspace.';
        action = null;
      } else {
        title = 'No sync workspace chosen';
        text = 'Choose, create or join a workspace under Settings › Sync. Nothing is uploaded until you do.';
      }
      break;
  }

  async function reload() {
    const result = await refresh.run();
    if (result) storeAccount(result);
  }

  return (
    <Card>
      <div className="app-phase-note">
        <span className="app-phase-note__icon" aria-hidden="true">
          <IconTeam size={18} />
        </span>
        <div>
          <p className="app-phase-note__title">{title}</p>
          <p className="app-phase-note__text">{text}</p>
          <div className="app-button-row app-cloud__note-actions">
            {action ? (
              <Button size="sm" onClick={() => onNavigate('settings/sync')}>
                {action}
              </Button>
            ) : null}
            {account.state === 'signedIn' && account.syncWorkspaceId ? (
              <Button size="sm" icon={<IconRefresh size={13} />} pending={refresh.pending} onClick={() => void reload()}>
                Refresh workspaces
              </Button>
            ) : null}
          </div>
          <InlineError error={refresh.error} />
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Invitations (owners and admins)
// ---------------------------------------------------------------------------------------------

interface CreatedInvitation {
  invitation: InvitationCreated;
  email: string;
  role: InvitableRole;
}

function InviteCard({ workspace }: { workspace: WorkspaceSummary }) {
  const roles = inviteRoleOptions(workspace.role);
  const [email, setEmail] = useState('');
  const [chosenRole, setRole] = useState<InvitableRole>(roles[0] ?? 'member');
  // If your own role changes while this is open (e.g. owner → admin), never offer a role you
  // can no longer grant; fall back to the least privileged one.
  const role: InvitableRole = roles.includes(chosenRole) ? chosenRole : (roles[0] ?? 'member');
  const [showError, setShowError] = useState(false);
  // The one-time code lives only in this component's state until "Done" or leaving the page.
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const invite = useCommandAction((input: { workspaceId: string; email: string; role: InvitableRole }) =>
    call('create_invitation', input),
  );
  const emailId = useId();
  const roleId = useId();
  const error = emailError(email);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (invite.pending) return;
    if (error) {
      setShowError(true);
      return;
    }
    setShowError(false);
    const address = normalizeEmail(email);
    const result = await invite.run({ workspaceId: workspace.id, email: address, role });
    if (!result) return;
    setCreated({ invitation: result, email: address, role });
    setEmail('');
  }

  return (
    <Card
      title="Invite a teammate"
      description={
        workspace.role === 'owner'
          ? 'As an owner you can invite admins and members.'
          : 'As an admin you can invite members. Owners can also invite admins.'
      }
    >
      <form className="app-invite" onSubmit={(event) => void submit(event)} noValidate>
        <Field label="Email address" htmlFor={emailId} error={showError ? error ?? undefined : undefined} errorId={`${emailId}-error`}>
          <TextInput
            id={emailId}
            type="email"
            value={email}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            readOnly={invite.pending}
            invalid={showError && error !== null}
            aria-describedby={showError && error ? `${emailId}-error` : undefined}
            onChange={(event) => setEmail(event.currentTarget.value)}
          />
        </Field>
        <Field label="Role" htmlFor={roleId}>
          <Select<InvitableRole>
            id={roleId}
            value={role}
            options={roles.map((value) => ({ value, label: ROLE_LABELS[value] }))}
            disabled={roles.length < 2}
            onChange={setRole}
          />
        </Field>
        <div className="app-invite__submit">
          <Button type="submit" variant="primary" icon={<IconUserPlus size={14} />} pending={invite.pending}>
            Create invitation
          </Button>
        </div>
      </form>
      <InlineError error={invite.error} />
      {created ? <InvitationCode created={created} workspaceName={workspace.name} onDone={() => setCreated(null)} /> : null}
    </Card>
  );
}

function InvitationCode({
  created,
  workspaceName,
  onDone,
}: {
  created: CreatedInvitation;
  workspaceName: string;
  onDone: () => void;
}) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<number | undefined>(undefined);
  const codeRef = useRef<HTMLInputElement>(null);
  const now = useNow(30_000);
  const codeId = useId();
  const { invitation, email, role } = created;
  const expiresMs = parseIso(invitation.expiresAt);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);
  useEffect(() => setCopy('idle'), [invitation.token]);

  /** Copies the code (only ever on this click). Never logged or kept anywhere else. */
  async function copyCode() {
    window.clearTimeout(resetTimer.current);
    let copied = false;
    try {
      await navigator.clipboard.writeText(invitation.token);
      copied = true;
    } catch {
      // The async Clipboard API can be unavailable in some WebView2 configurations; fall back to
      // copying the selected read-only field. If that fails too, the code stays selected.
      const input = codeRef.current;
      if (input) {
        input.focus();
        input.select();
        try {
          copied = document.execCommand('copy');
        } catch {
          copied = false;
        }
      }
    }
    if (copied) {
      setCopy('copied');
      resetTimer.current = window.setTimeout(() => setCopy('idle'), 2_500);
    } else {
      setCopy('failed');
    }
  }

  return (
    <section className="app-invite-code" aria-label="New invitation">
      <p className="app-invite-code__title">
        One-time code for <strong>{email}</strong> to join “{workspaceName}” as {ROLE_LABELS[role].toLowerCase()}
      </p>
      <div className="app-invite-code__row">
        <TextInput
          ref={codeRef}
          id={codeId}
          mono
          readOnly
          autoComplete="off"
          spellCheck={false}
          value={invitation.token}
          aria-label="Invitation code"
          className="app-invite-code__value"
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button icon={copy === 'copied' ? <IconCheck size={14} /> : <IconCopy size={14} />} onClick={() => void copyCode()}>
          {copy === 'copied' ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="app-setting__status" role="status" aria-live="polite">
        {copy === 'copied' ? 'Code copied to the clipboard.' : null}
        {copy === 'failed' ? 'Couldn’t copy. Select the code and press Ctrl+C.' : null}
      </p>
      <p className="app-setting__status">
        {expiresMs === null
          ? 'The server didn’t report when it expires.'
          : `Expires ${dateTime(invitation.expiresAt, currentTimeZone())} (${relativeTime(expiresMs, now)}).`}
      </p>
      <ul className="app-invite-code__notes">
        <li>Studio Pulse doesn’t email it. Send the code to {email} yourself.</li>
        <li>It works once, only for someone signed in as {email}, until it expires.</li>
        <li>
          Only a hash of the code is stored, so it can’t be shown again after you close this. If it gets lost, create a new
          invitation.
        </li>
      </ul>
      <div className="app-button-row">
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}
