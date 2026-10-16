import { Badge, Button, Card, IconCloud, IconTeam, SkeletonLines } from '@studio-pulse/ui';
import { ErrorBanner, SettingRow } from '../../components/common';
import { count } from '../../lib/format';
import { useDataSummary } from './PrivacySettings';

const WORKSPACE_ITEMS: ReadonlyArray<{ title: string; description: string }> = [
  { title: 'Workspace name', description: 'A shared space for your studio or team.' },
  { title: 'Members', description: 'Who belongs to the workspace.' },
  { title: 'Invitations', description: 'Invite people by email; they choose to join.' },
  { title: 'Roles', description: 'Owners, admins and members.' },
  {
    title: 'Tracking visibility policy',
    description: 'What teammates may see, such as aggregated totals only. Detailed records stay with their owner.',
  },
];

export function WorkspaceSettings() {
  return (
    <>
      <Card>
        <div className="app-phase-note">
          <span className="app-phase-note__icon" aria-hidden="true">
            <IconTeam size={18} />
          </span>
          <div>
            <p className="app-phase-note__title">Shared workspaces arrive in Phase 2</p>
            <p className="app-phase-note__text">
              Studio Pulse is personal and local in this version. There is no account, no workspace, and nobody else can
              see your time. Joining a workspace will always be your choice.
            </p>
          </div>
        </div>
      </Card>
      <Card title="Coming in Phase 2">
        {WORKSPACE_ITEMS.map((item) => (
          <SettingRow key={item.title} title={item.title} description={item.description} badge={<Badge tone="subtle">Phase 2</Badge>} disabled />
        ))}
      </Card>
    </>
  );
}

export function SyncSettings() {
  const data = useDataSummary();
  return (
    <>
      <Card title="Sync">
        <SettingRow title="Connection" description="Local only (no account). Your data stays on this device." />
        <SettingRow
          title="Pending records"
          description={
            data.summary
              ? `${count(data.summary.pendingSyncCount)} waiting for Phase 2 sync. They stay on this device until you sign in to a workspace.`
              : data.error
                ? 'Unavailable.'
                : 'Counting…'
          }
        />
        <SettingRow title="Last successful sync" description="Never" />
        <SettingRow
          title="Retry sync"
          description="Sync isn’t available in this version, so there is nothing to retry."
          badge={<Badge tone="subtle">Phase 2</Badge>}
          disabled
          control={() => (
            <Button size="sm" icon={<IconCloud size={14} />} disabled>
              Retry
            </Button>
          )}
        />
        {data.error ? (
          <ErrorBanner title="The pending count could not be loaded" error={data.error} onRetry={() => void data.reload()} />
        ) : null}
        {!data.summary && !data.error ? <SkeletonLines lines={1} label="Loading" /> : null}
      </Card>
    </>
  );
}
