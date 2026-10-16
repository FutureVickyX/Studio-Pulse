import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { RangePreset } from '@studio-pulse/time-engine';
import { formatDayLabel } from '@studio-pulse/time-engine';
import { validateCustomRange } from '@studio-pulse/validation';
import {
  Button,
  Card,
  Disclosure,
  EmptyState,
  IconClock,
  Legend,
  SegmentedControl,
  Skeleton,
  SkeletonLines,
  Switch,
  TextInput,
} from '@studio-pulse/ui';
import type { SegmentedOption } from '@studio-pulse/ui';
import { ErrorBanner, PageHeader } from '../components/common';
import {
  ACTIVE_IDLE_LEGEND,
  CategoryBars,
  DailyTable,
  DailyTrend,
  DayTimeline,
  IntervalList,
  MeasurementNote,
  UsageStats,
  UsageTable,
  WeeklyTotals,
  useApplicationColors,
} from '../components/report';
import { useReport } from '../hooks/useEvents';
import { useApplications, useSettings, useToday } from '../hooks/useLive';
import { addDaysToKey } from '../lib/days';
import { UI_LOCALE } from '../lib/format';

const PRESETS: ReadonlyArray<SegmentedOption<RangePreset>> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom' },
];

/** The single-day interval list (the timeline's text twin) shows at most this many rows. */
const INTERVAL_LIST_LIMIT = 200;

interface TimeViewState {
  preset: RangePreset;
  custom: { start: string; end: string } | null;
  includeExcluded: boolean;
}

/** Remembered while the window is open, so leaving and returning keeps the selection. */
let remembered: TimeViewState = { preset: 'today', custom: null, includeExcluded: false };

export function TimeView() {
  const [view, setViewState] = useState<TimeViewState>(remembered);
  const setView = (next: TimeViewState) => {
    remembered = next;
    setViewState(next);
  };
  const today = useToday();
  const settings = useSettings();
  const applications = useApplications();
  const report = useReport(view.preset, {
    customStart: view.custom?.start,
    customEnd: view.custom?.end,
    includeExcluded: view.includeExcluded,
  });
  const colors = useApplicationColors(report.summary, applications.data);
  const excludedIds = useMemo(
    () => new Set((applications.data ?? []).filter((app) => !app.includeInReports).map((app) => app.id)),
    [applications.data],
  );
  const toggleId = useId();

  const tracking = settings.data?.tracking;
  const idleMinutes = tracking?.idleTimeoutMinutes ?? null;
  const idleDetection = tracking?.pauseWhenIdle ?? true;
  const summary = report.summary;
  const range = summary?.range ?? report.range;
  const singleDay = (range?.days.length ?? 1) === 1;
  const live = range ? today.anchorMs >= range.startMs && today.anchorMs < range.endMs : false;
  const empty = summary !== null && summary.totals.foregroundMs === 0;

  const subtitle = range
    ? range.days.length > 1
      ? `${range.label} · ${formatDayLabel(range.days[0] ?? '', today.timeZone, today.anchorMs, UI_LOCALE)} – ${formatDayLabel(
          range.days[range.days.length - 1] ?? '',
          today.timeZone,
          today.anchorMs,
          UI_LOCALE,
        )}`
      : range.label === 'Today' || range.label === 'Yesterday'
        ? range.label
        : formatDayLabel(range.days[0] ?? '', today.timeZone, today.anchorMs, UI_LOCALE)
    : view.preset === 'custom'
      ? 'Choose a start and end date'
      : '';

  return (
    <div className="app-page">
      <PageHeader title="Time" subtitle={subtitle} actions={<span className="app-page__note">Automatically measured</span>} />

      <div className="app-filters" role="group" aria-label="Report filters">
        <SegmentedControl
          aria-label="Date range"
          options={PRESETS}
          value={view.preset}
          onChange={(preset) => setView({ ...view, preset })}
        />
        <div className="app-filters__toggle">
          <Switch
            id={toggleId}
            checked={view.includeExcluded}
            onChange={(includeExcluded) => setView({ ...view, includeExcluded })}
          />
          <label htmlFor={toggleId}>Show apps excluded from reports</label>
        </div>
      </div>

      {view.preset === 'custom' ? (
        <CustomRangeForm
          todayKey={today.dayKey}
          initial={view.custom}
          onApply={(custom) => setView({ ...view, custom })}
        />
      ) : null}

      {report.error ? <ErrorBanner title="This report could not be loaded" error={report.error} onRetry={report.reload} /> : null}

      {view.preset === 'custom' && !view.custom ? null : (
        <>
          <UsageStats
            summary={summary}
            loading={report.loading}
            stale={report.stale}
            idleMinutes={idleMinutes}
            idleDetection={idleDetection}
          />

          {report.loading ? (
            <Card>
              <Skeleton height={140} radius={8} />
            </Card>
          ) : summary && range ? (
            empty ? (
              <Card>
                <EmptyState icon={<IconClock size={18} />} title="No tracked time in this range">
                  {live
                    ? 'Open Figma, Photoshop, Blender… time appears here within a few seconds.'
                    : 'Nothing was recorded for your tracked applications on these days.'}
                </EmptyState>
              </Card>
            ) : (
              <>
                {singleDay ? (
                  <Card title="Timeline" description="Each block is one stretch in one app. Hatched = idle.">
                    <DayTimeline
                      summary={summary}
                      range={summary.range}
                      colors={colors}
                      timeZone={today.timeZone}
                      live={live}
                      stale={report.stale}
                    />
                    <Disclosure
                      summary={`Intervals as a list${summary.timeline.length > INTERVAL_LIST_LIMIT ? ` (latest ${INTERVAL_LIST_LIMIT})` : ''}`}
                      className="app-chart-table"
                    >
                      <IntervalList
                        summary={summary}
                        colors={colors}
                        timeZone={today.timeZone}
                        limit={INTERVAL_LIST_LIMIT}
                        label="Intervals, newest first"
                      />
                    </Disclosure>
                  </Card>
                ) : (
                  <Card title="Daily trend" description="Active and idle time per day">
                    <DailyTrend summary={summary} timeZone={today.timeZone} anchorMs={today.anchorMs} stale={report.stale} />
                    <Disclosure summary="Daily totals as a table" className="app-chart-table">
                      <DailyTable summary={summary} timeZone={today.timeZone} anchorMs={today.anchorMs} />
                    </Disclosure>
                  </Card>
                )}

                <Card title="Applications" description="Sorted by active time. Select a column to sort." flush>
                  <UsageTable summary={summary} colors={colors} excludedIds={view.includeExcluded ? excludedIds : undefined} />
                </Card>

                <div className={view.preset === 'last30' ? 'app-grid-2' : undefined}>
                  <Card title="By category">
                    <CategoryBars summary={summary} stale={report.stale} />
                    <Legend items={ACTIVE_IDLE_LEGEND} className="app-legend-below" />
                  </Card>
                  {view.preset === 'last30' ? (
                    <Card title="Weekly totals" description="Monday-start weeks" flush>
                      <WeeklyTotals summary={summary} timeZone={today.timeZone} anchorMs={today.anchorMs} />
                    </Card>
                  ) : null}
                </div>
              </>
            )
          ) : !report.error ? (
            <Card>
              <SkeletonLines lines={4} />
            </Card>
          ) : null}
        </>
      )}

      <MeasurementNote idleMinutes={idleMinutes} idleDetection={idleDetection}>
        {summary && !view.includeExcluded && summary.excludedApplicationIds.length > 0
          ? `${summary.excludedApplicationIds.length} excluded ${
              summary.excludedApplicationIds.length === 1 ? 'app is' : 'apps are'
            } not shown.`
          : null}
      </MeasurementNote>
    </div>
  );
}

function CustomRangeForm({
  todayKey,
  initial,
  onApply,
}: {
  todayKey: string;
  initial: { start: string; end: string } | null;
  onApply: (range: { start: string; end: string }) => void;
}) {
  const [start, setStart] = useState(initial?.start ?? addDaysToKey(todayKey, -6));
  const [end, setEnd] = useState(initial?.end ?? todayKey);
  const [issues, setIssues] = useState<string[]>([]);
  const startId = useId();
  const endId = useId();
  const errorId = useId();

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = validateCustomRange(start, end);
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    setIssues([]);
    onApply(result.value);
  }

  const invalid = issues.length > 0;
  return (
    <form className="app-custom-range" onSubmit={submit} noValidate>
      <label htmlFor={startId}>From</label>
      <TextInput
        id={startId}
        type="date"
        inputSize="sm"
        value={start}
        max={todayKey}
        invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(event) => setStart(event.currentTarget.value)}
      />
      <label htmlFor={endId}>To</label>
      <TextInput
        id={endId}
        type="date"
        inputSize="sm"
        value={end}
        max={todayKey}
        invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(event) => setEnd(event.currentTarget.value)}
      />
      <Button type="submit" size="sm" variant="primary">
        Apply
      </Button>
      {invalid ? (
        <p className="app-inline-error app-custom-range__error" id={errorId} role="alert">
          {issues.join(' ')}
        </p>
      ) : null}
    </form>
  );
}
