import { useCallback, useEffect, useId, useState } from 'react';
import type { DataSummary, ExportFormat, ExportResult } from '@studio-pulse/shared-types';
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
import { call, toCommandError } from '../../lib/api';
import type { ApiError } from '../../lib/api';
import { count, dateTime, plural } from '../../lib/format';

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

type DeleteChoice = { kind: 'older'; days: 30 | 90 } | { kind: 'all' };

export function PrivacySettings() {
  const data = useDataSummary();
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
          <Button icon={<IconDownload size={14} />} pending={exporting === 'json'} disabled={exporting !== null} onClick={() => void exportAs('json')}>
            Export JSON
          </Button>
          <Button icon={<IconDownload size={14} />} pending={exporting === 'csv'} disabled={exporting !== null} onClick={() => void exportAs('csv')}>
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

      <Banner tone="info" title="Local only" className="app-privacy-note">
        <span className="app-inline-icon">
          <IconShield size={14} />
        </span>
        Nothing leaves this device in this version. Team sharing arrives in Phase 2 and will be opt-in and visible here.
      </Banner>

      <DeleteHistoryDialog
        choice={deleteChoice}
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
  onClose,
  onDeleted,
}: {
  choice: DeleteChoice | null;
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
    </Dialog>
  );
}
