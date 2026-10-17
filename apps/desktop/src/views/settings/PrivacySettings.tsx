import { useCallback, useEffect, useId, useState } from 'react';
import type { AccountStatus, DataSummary, ExportFormat, ExportResult } from '@studio-pulse/shared-types';
import { currentTimeZone } from '@studio-pulse/time-engine';
import {
  Banner,
  Button,
  Card,
  Dialog,
  IconCheck,
  IconClose,
  IconDownload,
  IconShield,
  IconTrash,
  SkeletonLines,
  TextInput,
} from '@studio-pulse/ui';
import { ErrorBanner, InlineError } from '../../components/common';
import { useAccount } from '../../hooks/useCloud';
import { describeSharing } from '../../lib/account';
import { call, toCommandError } from '../../lib/api';
import type { ApiError } from '../../lib/api';
import { count, dateTime, plural } from '../../lib/format';
import { UPLOADED_FIELDS, UPLOADED_SUMMARY } from '../../lib/sync';

export const RECORDED: readonly string[] = [
  'Which tracked application was in front (its name)',
  'When each stretch started and ended',
  'Whether that time was active or idle',
  'This device’s random identifier',
];

export const NEVER_RECORDED: readonly string[] = [
  'Screenshots or screen recordings',
  'Keystrokes, key counts or mouse movements',
  'Window titles, file names or file contents',
  'Clipboard contents',
  'Browsing history, URLs or messages',
];

export function useDataSummary() {
  const [summary, setSummary] = useState<DataSummary | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await call('get_data_summary'));
      setError(null);
    } catch (caught) {
      setError(toCommandError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { summary, error, loading, reload };
}

export function RecordedLists() {
  return (
    <div className="app-privacy-lists">
      <div>
        <h3 className="app-list-title">What Studio Pulse records</h3>
        <ul className="app-checklist">
          {RECORDED.map((item) => (
            <li key={item}>
              <IconCheck size={14} className="app-checklist__yes" />
              {item}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="app-list-title">Never recorded</h3>
        <ul className="app-checklist">
          {NEVER_RECORDED.map((item) => (
            <li key={item}>
              <IconClose size={14} className="app-checklist__no" />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function SharingCard({ account }: { account: AccountStatus | undefined }) {
  // Where this device's records go right now, derived from the account status (never assumed).
  const current = describeSharing(account);
  return (
    <Card title="What leaves this device">
      <p className="app-prose">
        <span className="app-inline-icon">
          <IconShield size={14} />
        </span>
        Nothing leaves this device unless you sign in and choose a workspace. Then closed intervals, with the fields below,
        are uploaded to that workspace, private to you unless the workspace owner allows its owners and admins to see
        members’ entries. History recorded while no account was signed in is uploaded only if you agree.
      </p>
      {current ? (
        <p className="app-sharing-state" role="status">
          {current}
        </p>
      ) : null}
      <h3 className="app-list-title">Uploaded for each closed interval, only while syncing</h3>
      <ul className="app-checklist">
        {UPLOADED_SUMMARY.map((item) => (
          <li key={item}>
            <IconCheck size={14} className="app-checklist__yes" />
            {item}
          </li>
        ))}
      </ul>
      <ul className="app-fields app-fields--spaced" aria-label="Uploaded fields">
        {UPLOADED_FIELDS.map((field) => (
          <li key={field}>
            <code className="sp-mono">{field}</code>
          </li>
        ))}
      </ul>
      <p className="app-footnote app-sharing-footnote">
        The interval being recorded right now uploads only after it closes. <code className="sp-mono">project_id</code> and{' '}
        <code className="sp-mono">task_id</code> stay empty: Studio Pulse never assigns time to projects on its own. Things
        that are never recorded, such as window titles, keystrokes, screenshots or clipboard contents, can never be
        uploaded.
      </p>
    </Card>
  );
}

type DeleteChoice = { kind: 'older'; days: 30 | 90 } | { kind: 'all' };

export function PrivacySettings() {
  const data = useDataSummary();
  const account = useAccount();
  const timeZone = currentTimeZone();
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportResult, setExportResult] = useState<{ result: ExportResult | null; format: ExportFormat } | null>(null);
  const [exportError, setExportError] = useState<ApiError | null>(null);
  const [deleteChoice, setDeleteChoice] = useState<DeleteChoice | null>(null);
  const [deletedNotice, setDeletedNotice] = useState<string | null>(null);

  async function exportAs(format: ExportFormat) {
    setExporting(format);
    setExportError(null);
    setExportResult(null);
    try {
      setExportResult({ result: await call('export_tracking_events', { format }), format });
    } catch (caught) {
      setExportError(toCommandError(caught));
    } finally {
      setExporting(null);
    }
  }

  const summary = data.summary;
  return (
    <>
      <Card title="What is recorded" description="Tracking is automatic and limited to the items on the left.">
        <RecordedLists />
      </Card>

      <SharingCard account={account.data} />

      <Card title="Data on this device" actions={<Button size="sm" variant="ghost" onClick={() => void data.reload()} pending={data.loading && !!summary}>Refresh</Button>}>
        {data.error ? (
          <ErrorBanner title="The data summary could not be loaded" error={data.error} onRetry={() => void data.reload()} />
        ) : null}
        {!summary && !data.error ? <SkeletonLines lines={5} label="Loading data summary" /> : null}
        {summary ? (
          <>
            <dl className="app-facts">
              <div>
                <dt>Recorded intervals</dt>
                <dd className="sp-num">
                  {count(summary.eventCount)}
                  {summary.openEventCount > 0 ? <span className="sp-faint"> ({summary.openEventCount} in progress)</span> : null}
                </dd>
              </div>
              <div>
                <dt>Applications</dt>
                <dd className="sp-num">{count(summary.applicationCount)}</dd>
              </div>
              <div>
                <dt>Oldest record</dt>
                <dd>{summary.oldestEventAt ? dateTime(summary.oldestEventAt, timeZone) : 'None yet'}</dd>
              </div>
              <div>
                <dt>Newest record</dt>
                <dd>{summary.newestEventAt ? dateTime(summary.newestEventAt, timeZone) : 'None yet'}</dd>
              </div>
              <div className="app-facts__wide">
                <dt>Database</dt>
                <dd>
                  <code className="sp-mono app-break">{summary.databasePath}</code>
                </dd>
              </div>
              <div className="app-facts__wide">
                <dt>Device ID</dt>
                <dd>
                  <code className="sp-mono app-break">{summary.deviceId}</code>
                </dd>
              </div>
            </dl>
            <h3 className="app-list-title">Fields stored for each interval</h3>
            <ul className="app-fields" aria-label="Stored fields">
              {summary.storedFields.map((field) => (
                <li key={field}>
                  <code className="sp-mono">{field}</code>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Card>

      <Card title="Export" description="Save your full tracking history as a file. You choose where it goes.">
        <div className="app-button-row">
          {/* The running export's own button is `pending` (still focusable); only the other is disabled. */}
          <Button
            icon={<IconDownload size={14} />}
            pending={exporting === 'json'}
            disabled={exporting === 'csv'}
            onClick={() => void exportAs('json')}
          >
            Export JSON
          </Button>
          <Button
            icon={<IconDownload size={14} />}
            pending={exporting === 'csv'}
            disabled={exporting === 'json'}
            onClick={() => void exportAs('csv')}
          >
            Export CSV
          </Button>
        </div>
        {exportResult ? (
          exportResult.result ? (
            <Banner tone="success" compact title={`Exported ${plural(exportResult.result.count, 'record', 'records')}`}>
              <code className="sp-mono app-break">{exportResult.result.path}</code>
            </Banner>
          ) : (
            <p className="app-setting__status" role="status">
              Export cancelled. Nothing was saved.
            </p>
          )
        ) : null}
        <InlineError error={exportError} />
      </Card>

      <Card title="Delete history" description="Deleted intervals cannot be recovered.">
        <div className="app-button-row">
          <Button variant="danger" icon={<IconTrash size={14} />} onClick={() => setDeleteChoice({ kind: 'older', days: 30 })}>
            Older than 30 days
          </Button>
          <Button variant="danger" icon={<IconTrash size={14} />} onClick={() => setDeleteChoice({ kind: 'older', days: 90 })}>
            Older than 90 days
          </Button>
          <Button variant="danger" icon={<IconTrash size={14} />} onClick={() => setDeleteChoice({ kind: 'all' })}>
            Everything
          </Button>
        </div>
        {deletedNotice ? (
          <p className="app-setting__status" role="status">
            {deletedNotice}
          </p>
        ) : null}
      </Card>

      <DeleteHistoryDialog
        choice={deleteChoice}
        syncAvailable={account.data !== undefined && account.data.state !== 'notConfigured'}
        onClose={() => setDeleteChoice(null)}
        onDeleted={(deleted) => {
          setDeleteChoice(null);
          setDeletedNotice(`Deleted ${plural(deleted, 'interval', 'intervals')}.`);
          void data.reload();
        }}
      />
    </>
  );
}

const DAY_MS = 86_400_000;

function DeleteHistoryDialog({
  choice,
  syncAvailable,
  onClose,
  onDeleted,
}: {
  choice: DeleteChoice | null;
  /** Sync exists in this build, so some intervals may also have been uploaded to a workspace. */
  syncAvailable: boolean;
  onClose: () => void;
  onDeleted: (deleted: number) => void;
}) {
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const confirmId = useId();

  useEffect(() => {
    if (choice) {
      setTyped('');
      setError(null);
    }
  }, [choice]);

  const all = choice?.kind === 'all';
  const ready = !all || typed.trim() === 'DELETE';

  async function confirm() {
    if (!choice || !ready) return;
    setPending(true);
    setError(null);
    try {
      const beforeMs = choice.kind === 'all' ? null : Date.now() - choice.days * DAY_MS;
      const result = await call('delete_tracking_events', { beforeMs });
      onDeleted(result.deleted);
    } catch (caught) {
      setError(toCommandError(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={choice !== null}
      onClose={onClose}
      dismissible={!pending}
      title={all ? 'Delete all tracking history?' : `Delete history older than ${choice?.kind === 'older' ? choice.days : ''} days?`}
      description={
        all
          ? 'Every recorded interval on this device is removed. Your settings and applications stay.'
          : 'Intervals that ended before that point are removed. Recent history stays.'
      }
      footerStart={<InlineError error={error} />}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" icon={<IconTrash size={14} />} pending={pending} disabled={!ready} onClick={() => void confirm()}>
            Delete
          </Button>
        </>
      }
    >
      {all ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <label htmlFor={confirmId} className="app-confirm-label">
            Type <strong>DELETE</strong> to confirm
          </label>
          <TextInput
            id={confirmId}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.currentTarget.value)}
          />
        </form>
      ) : (
        <p className="app-dialog-text">This cannot be undone. Export first if you want a copy.</p>
      )}
      {syncAvailable ? (
        <p className="app-dialog-text">
          This deletes intervals on this device only, including any that haven’t uploaded yet. Copies already
          uploaded to a workspace are not removed.
        </p>
      ) : null}
    </Dialog>
  );
}
