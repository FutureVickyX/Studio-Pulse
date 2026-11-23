/**
 * The Analytics page's header actions (Export, Refresh) and its one row of filters. Plain props:
 * the container owns the state and the preferences.
 */

import type { RangePreset } from '@studio-pulse/time-engine';
import { Button, IconButton, IconDownload, IconRefresh, IconSettings, Menu, SegmentedControl, Select } from '@studio-pulse/ui';

import { ALL, EVERYONE } from '../../lib/analytics';
import type { AnalyticsView, FilterOption, RangeChoice } from '../../lib/analytics';
import { DateInput } from '../../components/common';

import { clockText } from './models';

// ---------------------------------------------------------------------------------------------
// Header actions
// ---------------------------------------------------------------------------------------------

export type ExportKind = 'summary-csv' | 'summary-json' | 'sessions-csv' | 'sessions-json';

const EXPORT_LABEL: Readonly<Record<ExportKind, string>> = {
  'summary-csv': 'Summary CSV',
  'summary-json': 'Summary JSON',
  'sessions-csv': 'My sessions CSV',
  'sessions-json': 'My sessions JSON',
};

export interface AnalyticsHeaderActionsProps {
  /** When the shown report was read (ms), or null before the first one. */
  updatedAt: number | null;
  /** The reporting zone, for "Updated HH:MM". */
  timeZone: string;
  refreshing: boolean;
  onRefresh: () => void;
  /** The exports this view offers, in menu order (the session exports only in My work). */
  exportKinds: ReadonlyArray<ExportKind>;
  onExport: (kind: ExportKind) => void;
  /** Nothing to export yet (no report), or an export is being prepared. */
  exportDisabled?: boolean;
  exporting?: boolean;
}

export function AnalyticsHeaderActions({
  updatedAt,
  timeZone,
  refreshing,
  onRefresh,
  exportKinds,
  onExport,
  exportDisabled = false,
  exporting = false,
}: AnalyticsHeaderActionsProps) {
  return (
    <>
      {updatedAt !== null ? (
        <span className="web-analytics-updated">Updated {clockText(updatedAt, timeZone)}</span>
      ) : null}
      <IconButton label="Refresh" icon={<IconRefresh size={16} />} pending={refreshing} onClick={onRefresh} />
      {exportKinds.length > 0 ? (
        <Menu
          aria-label="Export"
          placement="bottom-end"
          label="Recorded time — not billable"
          trigger={(props) => (
            <Button {...props} size="sm" icon={<IconDownload size={14} />} pending={exporting} disabled={exportDisabled}>
              Export
            </Button>
          )}
          items={exportKinds.map((kind) => ({ id: kind, label: EXPORT_LABEL[kind], onSelect: () => onExport(kind) }))}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------------------------

const VIEW_OPTIONS: ReadonlyArray<{ value: AnalyticsView; label: string }> = [
  { value: 'mine', label: 'My work' },
  { value: 'workspace', label: 'Workspace' },
];

const RANGE_OPTIONS: ReadonlyArray<{ value: RangePreset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom' },
];

export interface TimeOfFilter {
  /** `EVERYONE` or a person's id. Never saved. */
  value: string;
  options: ReadonlyArray<FilterOption>;
  onChange: (value: string) => void;
}

export interface AnalyticsToolbarProps {
  view: AnalyticsView;
  onViewChange: (view: AnalyticsView) => void;
  range: RangeChoice;
  onRangeChange: (range: RangeChoice) => void;
  /** The days the range resolves to: they prefill Custom. */
  resolvedDays?: { readonly fromDay: string; readonly toDay: string } | null;
  /** "3–9 Nov": the resolved range in words. */
  rangeText?: string | null;
  /** Why a custom range cannot be used. */
  rangeError?: string | null;
  /** Encoded project filter (`encodeProjectFilter`) and its options (`projectFilterOptions`). */
  projectValue: string;
  projectOptions: ReadonlyArray<FilterOption>;
  onProjectChange: (value: string) => void;
  /** `ALL` or an application id, and `applicationOptions`. */
  applicationValue: string;
  applicationOptions: ReadonlyArray<FilterOption>;
  onApplicationChange: (value: string) => void;
  /** "Time of": only in Workspace view while teammates' time is visible, else null. */
  timeOf?: TimeOfFilter | null;
  /** No time is shown (Workspace view without visibility): the range and application do not apply. */
  timeHidden?: boolean;
  /** The active reporting zone, shown as text. */
  timeZone: string;
  onOpenSettings: () => void;
}

export function AnalyticsToolbar({
  view,
  onViewChange,
  range,
  onRangeChange,
  resolvedDays = null,
  rangeText = null,
  rangeError = null,
  projectValue,
  projectOptions,
  onProjectChange,
  applicationValue,
  applicationOptions,
  onApplicationChange,
  timeOf = null,
  timeHidden = false,
  timeZone,
  onOpenSettings,
}: AnalyticsToolbarProps) {
  // In Custom the fields show the choice as it is (an emptied field stays empty); the resolved
  // days only prefill them when Custom is first chosen.
  const isCustom = range.preset === 'custom';
  const customFrom = isCustom ? (range.customFrom ?? null) : (resolvedDays?.fromDay ?? null);
  const customTo = isCustom ? (range.customTo ?? null) : (resolvedDays?.toDay ?? null);

  function custom(from: string | null, to: string | null): RangeChoice {
    return { preset: 'custom', ...(from ? { customFrom: from } : {}), ...(to ? { customTo: to } : {}) };
  }

  function choosePreset(preset: RangePreset) {
    if (preset === 'custom') onRangeChange(custom(customFrom, customTo));
    else onRangeChange({ preset });
  }

  return (
    <div className="web-analytics-toolbar" role="group" aria-label="Report filters">
      <SegmentedControl<AnalyticsView> aria-label="View" value={view} onChange={onViewChange} options={VIEW_OPTIONS} />

      {timeHidden ? null : (
        <div className="web-analytics-toolbar__range">
          <SegmentedControl<RangePreset>
            aria-label="Range"
            className="web-analytics-toolbar__presets"
            value={range.preset}
            onChange={choosePreset}
            options={RANGE_OPTIONS}
          />
          {range.preset === 'custom' ? (
            <span className="web-analytics-toolbar__dates">
              <DateInput size="sm" label="From" value={customFrom} onChange={(next) => onRangeChange(custom(next, customTo))} />
              <span aria-hidden="true">–</span>
              <DateInput size="sm" label="To" value={customTo} onChange={(next) => onRangeChange(custom(customFrom, next))} />
            </span>
          ) : null}
          {rangeText ? <span className="web-analytics-toolbar__text">{rangeText}</span> : null}
        </div>
      )}

      <div className="web-filters">
        <Select
          aria-label="Project"
          selectSize="sm"
          className={projectValue !== ALL ? 'web-filter--active' : undefined}
          value={projectValue}
          onChange={onProjectChange}
          options={projectOptions}
        />
        {timeHidden ? null : (
          <Select
            aria-label="Application"
            selectSize="sm"
            className={applicationValue !== ALL ? 'web-filter--active' : undefined}
            value={applicationValue}
            onChange={onApplicationChange}
            options={applicationOptions}
          />
        )}
        {timeOf && !timeHidden ? (
          <Select
            aria-label="Time of"
            selectSize="sm"
            className={timeOf.value !== EVERYONE ? 'web-filter--active' : undefined}
            value={timeOf.value}
            onChange={timeOf.onChange}
            options={timeOf.options}
          />
        ) : null}
        <Button size="sm" variant="ghost" icon={<IconSettings size={14} />} onClick={onOpenSettings}>
          Report settings
        </Button>
        <span className="web-analytics-toolbar__text" title="Days and times follow this time zone">
          {timeZone}
        </span>
      </div>

      {rangeError && !timeHidden ? (
        <p className="web-analytics-toolbar__error" role="alert">
          {rangeError}
        </p>
      ) : null}
    </div>
  );
}
