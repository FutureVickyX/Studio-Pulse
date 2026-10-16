import { useCallback, useEffect, useRef, useState } from 'react';
import type { StartupStatus } from '@studio-pulse/shared-types';
import { call, toCommandError } from '../lib/api';
import type { ApiError } from '../lib/api';

export interface StartupStatusHook {
  /** Always the registry-derived status reported by Rust; never a stored preference. */
  status: StartupStatus | null;
  loading: boolean;
  /** `set_launch_at_login` is running. */
  pending: boolean;
  /** The last load or change failure. */
  error: ApiError | null;
  reload: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
}

/** Launch-at-login state (main window only). Never optimistic: the toggle shows confirmed state. */
export function useStartupStatus(): StartupStatusHook {
  const [status, setStatus] = useState<StartupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await call('get_startup_status');
      if (!mounted.current) return;
      setStatus(next);
      setError(null);
    } catch (caught) {
      if (mounted.current) setError(toCommandError(caught));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    setPending(true);
    setError(null);
    try {
      const next = await call('set_launch_at_login', { enabled });
      if (mounted.current) setStatus(next);
    } catch (caught) {
      if (!mounted.current) return;
      setError(toCommandError(caught));
      // The change failed part-way or not at all: show what the registry really says now.
      try {
        const actual = await call('get_startup_status');
        if (mounted.current) setStatus(actual);
      } catch {
        // Keep the last confirmed status; the error above is already shown.
      }
    } finally {
      if (mounted.current) setPending(false);
    }
  }, []);

  return { status, loading, pending, error, reload, setEnabled };
}
