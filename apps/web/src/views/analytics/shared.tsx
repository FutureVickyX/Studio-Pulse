/**
 * Building blocks of the Analytics cards: the loading / problem / empty frame every card uses, the
 * accessible table, the polite live region, the privacy note and the footnote. Plain props only.
 */

import { useId } from 'react';
import type { ReactNode } from 'react';
import { Banner, EmptyState, IconShield, SkeletonLines, cx } from '@studio-pulse/ui';

import { analyticsFootnote } from '../../lib/analytics';
import type { Problem } from '../../lib/errors';
import { ProblemBanner } from '../../components/common';

// ---------------------------------------------------------------------------------------------
// Card body: loading → skeleton, problem → banner with retry, empty → a specific message, data
// ---------------------------------------------------------------------------------------------

export interface CardBodyProps {
  /** First load, nothing to show yet. */
  loading: boolean;
  loadingLabel: string;
  skeletonLines?: number;
  /** The source's last read failed; data from before (if any) stays below the banner. */
  problem?: Problem | null | undefined;
  onRetry?: (() => void) | undefined;
  problemTitle?: string;
  /** There is nothing to show for this selection. */
  empty: boolean;
  emptyTitle: string;
  emptyText?: ReactNode;
  emptyIcon?: ReactNode;
  children: ReactNode;
}

export function CardBody({
  loading,
  loadingLabel,
  skeletonLines = 4,
  problem,
  onRetry,
  problemTitle,
  empty,
  emptyTitle,
  emptyText,
  emptyIcon,
  children,
}: CardBodyProps) {
  const banner = problem ? (
    <ProblemBanner problem={problem} {...(onRetry ? { onRetry } : {})} {...(problemTitle ? { title: problemTitle } : {})} />
  ) : null;
  if (loading) {
    return banner ?? <SkeletonLines lines={skeletonLines} label={loadingLabel} />;
  }
  return (
    <>
      {banner}
      {empty ? (
        banner ? null : (
          <EmptyState compact title={emptyTitle} {...(emptyIcon ? { icon: emptyIcon } : {})}>
            {emptyText}
          </EmptyState>
        )
      ) : (
        children
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Table: a real <table> with a caption, scoped headers, tabular numbers and an overflow wrapper
// ---------------------------------------------------------------------------------------------

export interface TableColumn<T> {
  readonly id: string;
  readonly header: ReactNode;
  /** Explains the column (a native tooltip on its header). */
  readonly title?: string;
  /** `end` for figures: right-aligned, tabular numbers. */
  readonly align?: 'start' | 'end';
  /** This column names the row: rendered as `<th scope="row">`. */
  readonly rowHeader?: boolean;
  readonly cell: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  /** What the table lists; shown above it unless `captionHidden`. */
  caption: ReactNode;
  captionHidden?: boolean;
  columns: ReadonlyArray<TableColumn<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T) => string;
  /** A closing row (totals), one cell per column. */
  footer?: ReadonlyArray<ReactNode>;
  /** Dim the rows while newer data loads. */
  stale?: boolean;
  className?: string;
}

export function DataTable<T>({ caption, captionHidden = false, columns, rows, rowKey, footer, stale = false, className }: DataTableProps<T>) {
  const captionId = useId();
  return (
    // Focusable, so a keyboard user can scroll a table wider than the card.
    <div className={cx('web-table-wrap', className)} role="region" aria-labelledby={captionId} tabIndex={0}>
      <table className="web-table" data-stale={stale || undefined}>
        <caption id={captionId} className={captionHidden ? 'sp-visually-hidden' : undefined}>
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.id} scope="col" title={column.title} className={column.align === 'end' ? 'web-table__num' : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) =>
                column.rowHeader ? (
                  <th key={column.id} scope="row" className={column.align === 'end' ? 'web-table__num' : undefined}>
                    {column.cell(row)}
                  </th>
                ) : (
                  <td key={column.id} className={column.align === 'end' ? 'web-table__num' : undefined}>
                    {column.cell(row)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
        {footer ? (
          <tfoot>
            <tr>
              {columns.map((column, index) =>
                index === 0 ? (
                  <th key={column.id} scope="row">
                    {footer[index]}
                  </th>
                ) : (
                  <td key={column.id} className={column.align === 'end' ? 'web-table__num' : undefined}>
                    {footer[index]}
                  </td>
                ),
              )}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Live region, privacy note, time-zone notice, footnote
// ---------------------------------------------------------------------------------------------

export interface LiveRegionProps {
  /** The latest announcement ("Analytics updated", "20 more sessions loaded"); empty says nothing. */
  message: string;
}

/** A polite, visually hidden live region. Keep it mounted and change `message` to announce. */
export function LiveRegion({ message }: LiveRegionProps) {
  return (
    <div className="sp-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}

export interface PrivacyNoteProps {
  /** `privacyNote(workspace)`: whose time this workspace lets the viewer see. */
  text: string;
}

export function PrivacyNote({ text }: PrivacyNoteProps) {
  return (
    <p className="web-analytics-note">
      <IconShield size={14} className="web-analytics-note__icon" />
      <span>{text}</span>
    </p>
  );
}

export interface TimeZoneNoticeProps {
  /** The zone the database did not know. */
  zone: string;
}

/** Shown after an "unknown time zone" answer: the report fell back to UTC. */
export function TimeZoneNotice({ zone }: TimeZoneNoticeProps) {
  return (
    <Banner tone="warning" title="Showing times in UTC">
      The reporting time zone “{zone}” isn’t available, so this report uses UTC. Choose another zone in Report settings.
    </Banner>
  );
}

export interface AnalyticsFootnoteProps {
  /** Time recorded more than once (several devices) and counted once, ms. */
  overlapMs: number;
}

export function AnalyticsFootnote({ overlapMs }: AnalyticsFootnoteProps) {
  return <p className="web-footnote web-analytics-footnote">{analyticsFootnote(overlapMs)}</p>;
}
