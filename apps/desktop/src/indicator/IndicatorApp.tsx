import { useEffect, useState } from 'react';
import { currentTimeZone, formatDuration } from '@studio-pulse/time-engine';
import { Button, IconButton, IconClose, IconExternal } from '@studio-pulse/ui';
import { LiveDuration, StatusLabel } from '../components/common';
import { PauseControl } from '../components/PauseControl';
import { useReport } from '../hooks/useEvents';
import { useTrackerStatus } from '../hooks/useLive';
import { hideIndicator, openMainWindow, toCommandError } from '../lib/api';
import type { ApiError } from '../lib/api';
import { clockTime } from '../lib/format';
import { describeStatus, hasLiveSession } from '../lib/status';

/**
 * Compact always-on-top indicator (320 x 204, frameless), shown above the tray icon. Always dark:
 * it floats over the taskbar and the native window background is dark (no light flash on show).
 */
export function IndicatorApp() {
  useEffect(() => {
    document.documentElement.dataset.theme = 'dark';
  }, []);
  const { data: status, error, reload } = useTrackerStatus();
  const [openError, setOpenError] = useState<ApiError | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      void hideIndicator().catch(() => undefined);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  async function openMain() {
    setOpening(true);
    setOpenError(null);
    try {
      await openMainWindow(null);
    } catch (caught) {
      setOpenError(toCommandError(caught));
    } finally {
      setOpening(false);
    }
  }

  const presentation = status ? describeStatus(status, { formatTime: (ms) => clockTime(ms, currentTimeZone()) }) : null;
  const live = status && hasLiveSession(status) ? status.current : null;

  return (
    <div className="ind" data-state={status?.state}>
      <header className="ind__header" data-tauri-drag-region>
        {presentation ? (
          <StatusLabel presentation={presentation} className="app-status-label ind__status" />
        ) : (
          <span className="ind__status ind__status--loading">{error ? 'Status unavailable' : 'Loading…'}</span>
        )}
        <span className="ind__spacer" data-tauri-drag-region />
        <IconButton
          size="sm"
          label="Hide (Esc)"
          icon={<IconClose size={13} />}
          onClick={() => void hideIndicator().catch(() => undefined)}
        />
      </header>

      <div className="ind__body">
        {status && presentation ? (
          <>
            <p className="ind__app sp-truncate" title={live ? live.applicationName : presentation.headline}>
              {live ? live.applicationName : presentation.headline}
            </p>
            {live ? (
              <div className="ind__live">
                <LiveDuration startedAt={live.startedAt} className="ind__clock sp-num" />
                <span className="ind__live-label">{live.kind === 'idle' ? 'idle' : 'this session'}</span>
              </div>
            ) : (
              <p className="ind__explanation">{presentation.explanation}</p>
            )}
          </>
        ) : error ? (
          <div className="ind__error">
            <p className="app-inline-error">{error.message}</p>
            <Button size="sm" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="ind__skeleton">
            <span className="sp-skeleton" style={{ width: '60%', height: 16 }} />
            <span className="sp-skeleton" style={{ width: '40%', height: 26 }} />
          </div>
        )}
        <TodayActive />
      </div>

      {openError ? <p className="app-inline-error ind__floating-error">{openError.message}</p> : null}

      <footer className="ind__actions">
        <PauseControl state={status?.state} size="sm" placement="top-start" />
        <Button size="sm" variant="ghost" icon={<IconExternal size={13} />} pending={opening} onClick={() => void openMain()}>
          Open Studio Pulse
        </Button>
      </footer>
    </div>
  );
}

/** Today's active total, from the same report pipeline as the main window. */
function TodayActive() {
  const report = useReport('today');
  let text: string;
  if (report.summary) text = `${formatDuration(report.summary.totals.activeMs, 'compact')} active today`;
  else if (report.error) text = 'Today’s total unavailable';
  else text = 'Loading today…';
  return (
    <p className="ind__today sp-num" aria-live="off">
      {text}
    </p>
  );
}
