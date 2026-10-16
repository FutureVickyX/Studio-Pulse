import { useCallback, useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { SettingsPatch } from '@studio-pulse/shared-types';
import { Badge, Banner, Switch, TextInput } from '@studio-pulse/ui';
import { InlineError, SettingRow } from '../../components/common';
import { updateSettings } from '../../hooks/useLive';
import type { StartupStatusHook } from '../../hooks/useStartupStatus';
import { toCommandError } from '../../lib/api';
import type { ApiError } from '../../lib/api';

// ---------------------------------------------------------------------------------------------
// Settings patches with per-field pending and error state
// ---------------------------------------------------------------------------------------------

export interface SettingsPatcher {
  apply: (field: string, patch: SettingsPatch) => Promise<boolean>;
  isPending: (field: string) => boolean;
  errorFor: (field: string) => ApiError | null;
}

/** Controls show the confirmed value; while a patch runs the field is pending, never optimistic. */
export function useSettingsPatcher(): SettingsPatcher {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, ApiError>>>({});

  const apply = useCallback(async (field: string, patch: SettingsPatch) => {
    setPending((previous) => new Set(previous).add(field));
    setErrors((previous) => {
      if (!(field in previous)) return previous;
      const next = { ...previous };
      delete next[field];
      return next;
    });
    try {
      await updateSettings(patch);
      return true;
    } catch (caught) {
      setErrors((previous) => ({ ...previous, [field]: toCommandError(caught) }));
      return false;
    } finally {
      setPending((previous) => {
        const next = new Set(previous);
        next.delete(field);
        return next;
      });
    }
  }, []);

  return {
    apply,
    isPending: (field) => pending.has(field),
    errorFor: (field) => errors[field] ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Switch row
// ---------------------------------------------------------------------------------------------

export function SwitchSetting({
  title,
  description,
  checked,
  onChange,
  pending = false,
  disabled = false,
  error,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  pending?: boolean;
  disabled?: boolean;
  error?: ApiError | null;
}) {
  return (
    <SettingRow
      title={title}
      description={description}
      disabled={disabled}
      control={({ controlId, descriptionId }) => (
        <Switch
          id={controlId}
          checked={checked}
          pending={pending}
          disabled={disabled}
          aria-describedby={descriptionId}
          onChange={onChange}
        />
      )}
    >
      {error ? <InlineError error={error} /> : null}
    </SettingRow>
  );
}

// ---------------------------------------------------------------------------------------------
// Integer field committed on blur / Enter
// ---------------------------------------------------------------------------------------------

export function NumberSetting({
  title,
  description,
  value,
  min,
  max,
  unit,
  onCommit,
  pending = false,
  disabled = false,
  error,
}: {
  title: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onCommit: (next: number) => Promise<boolean>;
  pending?: boolean;
  disabled?: boolean;
  error?: ApiError | null;
}) {
  const [draft, setDraft] = useState(String(value));
  const [localError, setLocalError] = useState<string | null>(null);

  // Follow confirmed changes (e.g. from another window) when not editing an invalid draft.
  useEffect(() => {
    setDraft(String(value));
    setLocalError(null);
  }, [value]);

  async function commit() {
    const trimmed = draft.trim();
    if (trimmed === String(value)) {
      setLocalError(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
      setLocalError(`Enter a whole number from ${min} to ${max}.`);
      return;
    }
    setLocalError(null);
    const ok = await onCommit(parsed);
    if (!ok) setDraft(String(value));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
    } else if (event.key === 'Escape') {
      setDraft(String(value));
      setLocalError(null);
    }
  }

  const shownError = localError ?? error?.message ?? null;
  return (
    <SettingRow
      title={title}
      description={description}
      disabled={disabled}
      control={({ controlId, descriptionId }) => (
        <span className="app-number">
          <TextInput
            id={controlId}
            inputSize="sm"
            inputMode="numeric"
            className="app-number__input"
            value={draft}
            disabled={disabled || pending}
            invalid={shownError !== null}
            aria-describedby={descriptionId}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={() => void commit()}
            onKeyDown={onKeyDown}
          />
          <span className="app-number__unit">{unit}</span>
        </span>
      )}
    >
      {shownError ? (
        <p className="app-inline-error" role="alert">
          {shownError}
        </p>
      ) : null}
    </SettingRow>
  );
}

// ---------------------------------------------------------------------------------------------
// Launch at Windows startup (registry-derived; never optimistic)
// ---------------------------------------------------------------------------------------------

export function LaunchAtLoginSetting({ startup }: { startup: StartupStatusHook }) {
  const { status, pending, error, loading } = startup;
  let summary: string;
  if (pending) summary = 'Updating the Windows startup entry…';
  else if (!status) summary = loading ? 'Checking Windows startup…' : 'Status unavailable.';
  else if (status.enabled) summary = 'On. Windows starts Studio Pulse when you sign in.';
  else if (status.registered) summary = 'Registered, but Windows will not start it. See below.';
  else summary = 'Off. Studio Pulse starts only when you open it.';

  return (
    <SettingRow
      title="Launch Studio Pulse when Windows starts"
      description="Adds a per-user startup entry, checked by reading it back from the registry."
      badge={status?.isDevelopmentBuild ? <Badge tone="warning">Dev build</Badge> : null}
      control={({ controlId, descriptionId }) => (
        <Switch
          id={controlId}
          checked={status?.enabled ?? false}
          pending={pending}
          disabled={!status}
          aria-describedby={descriptionId}
          onChange={(next) => void startup.setEnabled(next)}
        />
      )}
    >
      <p className="app-setting__status" role="status" aria-live="polite">
        {summary}
      </p>
      {status && !pending && status.message ? (
        <Banner tone="warning" compact>
          {status.message}
        </Banner>
      ) : null}
      {status && !pending && status.registered && status.approvedByWindows === false && !status.message ? (
        <Banner tone="warning" compact>
          Windows has disabled this entry (Task Manager › Startup apps).
        </Banner>
      ) : null}
      {status && !pending && status.registered && !status.pointsToCurrentExecutable && !status.message ? (
        <Banner tone="warning" compact>
          The startup entry points to a different copy of Studio Pulse.
        </Banner>
      ) : null}
      {status?.command ? (
        <p className="app-setting__mono">
          <span className="sp-faint">Registered command </span>
          <code className="sp-mono">{status.command}</code>
        </p>
      ) : null}
      {error ? (
        <Banner
          tone="danger"
          compact
          title={status ? 'Windows startup could not be changed' : 'Windows startup status is unavailable'}
          onRetry={() => void startup.reload()}
          retryLabel="Recheck"
        >
          {error.message}
        </Banner>
      ) : null}
    </SettingRow>
  );
}
