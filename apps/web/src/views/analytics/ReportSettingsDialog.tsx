/**
 * Report settings: the reporting time zone and the saved views. Both live in this browser only;
 * no person is ever part of a saved view.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Dialog, Field, Select, TextInput } from '@studio-pulse/ui';

import { MAX_SAVED_VIEWS, SAVED_VIEW_NAME_MAX, validateSavedViewName } from '../../lib/analytics';
import type { RangeChoice, SavedView } from '../../lib/analytics';

import { LiveRegion } from './shared';

const PRESET_TEXT: Readonly<Record<Exclude<RangeChoice['preset'], 'custom'>, string>> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
};

/** "My work · Last 7 days", "Workspace · 2026-11-03 – 2026-11-09". */
export function savedViewSummary(view: Pick<SavedView, 'view' | 'range'>): string {
  const range =
    view.range.preset === 'custom'
      ? view.range.customFrom && view.range.customTo
        ? `${view.range.customFrom} – ${view.range.customTo}`
        : 'Custom range'
      : PRESET_TEXT[view.range.preset];
  return `${view.view === 'mine' ? 'My work' : 'Workspace'} · ${range}`;
}

export interface ReportSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** The active reporting zone and the zones on offer (`timeZoneOptions`). */
  timeZone: string;
  timeZoneOptions: ReadonlyArray<string>;
  /** This browser's zone: the default, marked in the list. */
  browserTimeZone: string;
  onTimeZoneChange: (zone: string) => void;
  savedViews: ReadonlyArray<SavedView>;
  onApplyView: (id: string) => void;
  onDeleteView: (id: string) => void;
  /**
   * Save the current view, range, bucket, project and application under this (valid, trimmed)
   * name. Returns why it was not saved (shown on the Name field, which stays open), or null.
   */
  onSaveView: (name: string) => string | null;
}

/**
 * Where focus goes when a saved view is deleted: the next view in the list, else the one before
 * it, else (the list is now empty) null for "Save current view…".
 */
export function focusAfterDelete(ids: ReadonlyArray<string>, deleted: string): string | null {
  const index = ids.indexOf(deleted);
  if (index === -1) return null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}

export function ReportSettingsDialog({
  open,
  onClose,
  timeZone,
  timeZoneOptions,
  browserTimeZone,
  onTimeZoneChange,
  savedViews,
  onApplyView,
  onDeleteView,
  onSaveView,
}: ReportSettingsDialogProps) {
  const zoneId = useId();
  const nameId = useId();
  const errorId = useId();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The page's live region is outside this modal dialog (inert while it is open): saves and
  // deletes are announced from in here.
  const [status, setStatus] = useState('');

  // Focus never falls to the page body while the dialog is open: after Save view or Cancel it
  // goes back to "Save current view…"; after Delete, to the next view's Apply (or the previous
  // one's, or "Save current view…" once the list is empty).
  const saveTrigger = useRef<HTMLButtonElement>(null);
  const applyButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusTrigger = useRef(false);
  const focusAfterDeleting = useRef<{ readonly id: string | null } | null>(null);
  useEffect(() => {
    if (naming || !focusTrigger.current) return;
    focusTrigger.current = false;
    saveTrigger.current?.focus();
  }, [naming]);
  useEffect(() => {
    const target = focusAfterDeleting.current;
    if (target === null) return;
    focusAfterDeleting.current = null;
    const next = target.id === null ? undefined : applyButtons.current.get(target.id);
    (next ?? saveTrigger.current)?.focus();
  }, [savedViews]);
  useEffect(() => {
    if (!open) setStatus('');
  }, [open]);

  function stopNaming() {
    setNaming(false);
    setName('');
    setError(null);
  }

  /** Close the form and give focus back to "Save current view…". */
  function finishNaming() {
    focusTrigger.current = true;
    stopNaming();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const checked = validateSavedViewName(name);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    const replaces = savedViews.some((view) => view.name.toLowerCase() === checked.value.toLowerCase());
    if (!replaces && savedViews.length >= MAX_SAVED_VIEWS) {
      setError(`You can keep ${MAX_SAVED_VIEWS} saved views. Delete one, or reuse a name to replace it.`);
      return;
    }
    const refused = onSaveView(checked.value);
    if (refused !== null) {
      // Not saved (an incomplete custom range, say): the form stays, with the reason on the field.
      setError(refused);
      return;
    }
    setStatus(`View “${checked.value}” saved in this browser.`);
    finishNaming();
  }

  function deleteView(view: SavedView) {
    focusAfterDeleting.current = { id: focusAfterDelete(savedViews.map((item) => item.id), view.id) };
    setStatus(`View “${view.name}” deleted.`);
    onDeleteView(view.id);
  }

  const zones = timeZoneOptions.includes(timeZone) ? timeZoneOptions : [timeZone, ...timeZoneOptions];

  return (
    <Dialog
      open={open}
      onClose={() => {
        stopNaming();
        onClose();
      }}
      title="Report settings"
      description="Saved in this browser."
      size="md"
      footer={
        <Button
          variant="primary"
          onClick={() => {
            stopNaming();
            onClose();
          }}
        >
          Done
        </Button>
      }
    >
      <div className="web-analytics-settings">
        <Field label="Time zone" htmlFor={zoneId} hint="Days, weeks and months in the report start and end in this time zone.">
          <Select
            id={zoneId}
            value={timeZone}
            onChange={onTimeZoneChange}
            options={zones.map((zone) => ({ value: zone, label: zone === browserTimeZone ? `${zone} (this browser)` : zone }))}
          />
        </Field>

        <section className="web-analytics-settings__views" aria-label="Saved views">
          <h3 className="web-section__title">Saved views</h3>
          {savedViews.length === 0 ? (
            <p className="web-muted">No saved views yet. A saved view keeps the view, range, bucket, project and application.</p>
          ) : (
            <ul className="web-rows web-rows--compact">
              {savedViews.map((view) => (
                <li key={view.id} className="web-row web-row--static">
                  <span className="web-row__main">
                    <span className="web-row__title">{view.name}</span>
                    <span className="web-row__sub">{savedViewSummary(view)}</span>
                  </span>
                  <span className="web-row__aside web-analytics-settings__actions">
                    <Button
                      ref={(button) => {
                        if (button) applyButtons.current.set(view.id, button);
                        else applyButtons.current.delete(view.id);
                      }}
                      size="sm"
                      aria-label={`Apply ${view.name}`}
                      onClick={() => onApplyView(view.id)}
                    >
                      Apply
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Delete ${view.name}`} onClick={() => deleteView(view)}>
                      Delete
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {naming ? (
            <form className="web-analytics-settings__form" onSubmit={submit} noValidate>
              <Field label="Name" htmlFor={nameId} error={error} errorId={errorId}>
                <TextInput
                  id={nameId}
                  value={name}
                  maxLength={SAVED_VIEW_NAME_MAX * 2}
                  invalid={error !== null}
                  aria-describedby={error ? errorId : undefined}
                  autoFocus
                  onChange={(event) => {
                    setName(event.currentTarget.value);
                    setError(null);
                  }}
                />
              </Field>
              <span className="web-analytics-settings__actions">
                <Button type="submit" size="sm" variant="primary">
                  Save view
                </Button>
                <Button size="sm" variant="ghost" onClick={finishNaming}>
                  Cancel
                </Button>
              </span>
            </form>
          ) : (
            <Button ref={saveTrigger} size="sm" onClick={() => setNaming(true)}>
              Save current view…
            </Button>
          )}
          <p className="web-footnote">
            Saved in this browser, for you in this workspace. Saved views never include a person, and they stay on this browser after you
            sign out.
          </p>
        </section>
        <LiveRegion message={status} />
      </div>
    </Dialog>
  );
}
