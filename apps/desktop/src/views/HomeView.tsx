import { useState } from 'react';
import type { Route, TrackerStatus } from '@studio-pulse/shared-types';
import { currentTimeZone } from '@studio-pulse/time-engine';
import { Banner, Button, Card, EmptyState, IconApps, IconPulse, Skeleton, SkeletonLines } from '@studio-pulse/ui';
import { ErrorBanner, InlineError, LiveDuration, PageHeader, StatusLabel } from '../components/common';
import { PauseControl } from '../components/PauseControl';
import {
  ApplicationBars,
  DayTimeline,
  IntervalList,
  MeasurementNote,
  UsageStats,
  useApplicationColors,
} from '../components/report';
import { useReport } from '../hooks/useEvents';
import { useApplications, useSettings, useTrackerStatus } from '../hooks/useLive';
import { toCommandError } from '../lib/api';
import type { ApiError } from '../lib/api';
import { clockTime, longDate } from '../lib/format';
import { describeStatus, hasLiveSession } from '../lib/status';

const HOME_APP_LIMIT = 8;

export function HomeView({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const report = useReport('today');
  const applications = useApplications();
  const settings = useSettings();
  const colors = useApplicationColors(report.summary, applications.data);
  const tracking = settings.data?.tracking;
  const idleMinutes = tracking?.idleTimeoutMinutes ?? null;
  const idleDetection = tracking?.pauseWhenIdle ?? true;
  const summary = report.summary;
  const empty = summary !== null && summary.timeline.length === 0;

  return (
    <div className="app-page">
      <PageHeader
        title="Today"
        subtitle={<span className="sp-num">{longDate(report.anchorMs, report.timeZone)}</span>}
        actions={<span className="app-page__note">Automatically measured</span>}
      />

      <StatusHero />

      {report.error ? (
        <ErrorBanner title="Today’s activity could not be loaded" error={report.error} onRetry={report.reload} />
      ) : null}

      <UsageStats
        summary={summary}
        loading={report.loading}
        stale={report.stale}
        idleMinutes={idleMinutes}
        idleDetection={idleDetection}
      />

      {report.loading ? (
        <Card title="Timeline">
          <Skeleton height={30} radius={6} />
        </Card>
      ) : summary && report.range ? (
        empty ? (
          <Card>
            <EmptyState icon={<IconPulse size={18} />} title="Nothing recorded yet today">
              Open Figma, Photoshop, Blender… time appears here within a few seconds.
            </EmptyState>
          </Card>
        ) : (
          <>
            <Card title="Timeline" description="Each block is one stretch in one app. Hatched = idle.">
              <DayTimeline
                summary={summary}
                range={report.range}
                colors={colors}
                timeZone={report.timeZone}
                live
                stale={report.stale}
              />
            </Card>
            <div className="app-grid-2">
              <Card
                title="Time by application"
                description="Active time, with idle time hatched"
                actions={
                  summary.byApplication.length > HOME_APP_LIMIT ? (
                    <Button size="sm" variant="ghost" onClick={() => onNavigate('time')}>
                      All {summary.byApplication.length}
                    </Button>
                  ) : null
                }
              >
                <ApplicationBars summary={summary} colors={colors} limit={HOME_APP_LIMIT} stale={report.stale} />
              </Card>
              <Card title="Recent intervals" flush>
                <IntervalList summary={summary} colors={colors} timeZone={report.timeZone} />
              </Card>
            </div>
          </>
        )
      ) : !report.error ? (
        <Card>
          <SkeletonLines lines={4} />
        </Card>
      ) : null}

      {summary && summary.excludedApplicationIds.length > 0 ? (
        <Banner tone="neutral" compact>
          {summary.excludedApplicationIds.length === 1
            ? '1 application is hidden from reports.'
            : `${summary.excludedApplicationIds.length} applications are hidden from reports.`}{' '}
          <button type="button" className="app-link" onClick={() => onNavigate('settings/applications')}>
            Manage applications
          </button>
        </Banner>
      ) : null}

      {applications.data && applications.data.every((app) => !app.enabled) ? (
        <Banner
          tone="warning"
          title="No applications are tracked"
          action={
            <Button size="sm" icon={<IconApps size={14} />} onClick={() => onNavigate('settings/applications')}>
              Choose apps
            </Button>
          }
        >
          Turn on at least one application in Settings › Applications.
        </Banner>
      ) : null}

      <MeasurementNote idleMinutes={idleMinutes} idleDetection={idleDetection} />
    </div>
  );
}

/** Current state for every TrackerState, with a one-line explanation. */
function StatusHero() {
  const { data: status, error, reload } = useTrackerStatus();
  if (error && !status) {
    return <ErrorBanner title="Tracker status is unavailable" error={error} onRetry={() => void reload()} />;
  }
  if (!status) {
    return (
      <section className="app-hero" aria-busy="true" aria-label="Tracker status">
        <SkeletonLines lines={2} label="Loading tracker status" />
      </section>
    );
  }
  return <StatusHeroBody status={status} />;
}

function StatusHeroBody({ status }: { status: TrackerStatus }) {
  const timeZone = currentTimeZone();
  const presentation = describeStatus(status, { formatTime: (ms) => clockTime(ms, timeZone) });
  const live = hasLiveSession(status) && status.current;
  return (
    <section className="app-hero" data-state={status.state} aria-label="Tracker status">
      <div className="app-hero__main">
        <StatusLabel presentation={presentation} className="app-status-label app-status-label--hero" />
        <p className="app-hero__headline sp-truncate">{presentation.headline}</p>
        <p className="app-hero__explanation">{presentation.explanation}</p>
      </div>
      <div className="app-hero__side">
        {live ? (
          <div className="app-hero__timer">
            <span className="app-hero__timer-label">{status.current?.kind === 'idle' ? 'Idle for' : 'This session'}</span>
            <LiveDuration startedAt={live.startedAt} className="app-hero__clock sp-num" />
          </div>
        ) : null}
        {status.state === 'disabled' ? <TurnTrackingOn /> : <PauseControl state={status.state} placement="bottom-end" />}
      </div>
    </section>
  );
}

function TurnTrackingOn() {
  const settings = useSettings();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <>
      <Button
        size="sm"
        variant="primary"
        pending={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            await settings.update({ tracking: { enabled: true } });
          } catch (caught) {
            setError(toCommandError(caught));
          } finally {
            setPending(false);
          }
        }}
      >
        Turn tracking on
      </Button>
      <InlineError error={error} />
    </>
  );
}
