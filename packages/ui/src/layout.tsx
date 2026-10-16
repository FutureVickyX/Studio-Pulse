import type { CSSProperties, ReactNode } from 'react';
import { Button } from './Button';
import { cx } from './cx';
import { IconAlert, IconAlertCircle, IconCheckCircle, IconChevronRight, IconInfo, IconRefresh } from './icons';

// ---------------------------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------------------------

export interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Body without side padding (lists that draw their own row padding). */
  flush?: boolean;
  /** Accessible label for the section when the title isn't plain text. */
  'aria-label'?: string;
  headingLevel?: 2 | 3;
  id?: string;
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
  flush = false,
  headingLevel = 2,
  id,
  'aria-label': ariaLabel,
}: CardProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className={cx('sp-card', flush && 'sp-card--flush', className)} aria-label={ariaLabel} id={id}>
      {title || actions ? (
        <header className="sp-card__header">
          <div className="sp-card__heading">
            {title ? <Heading className="sp-card__title">{title}</Heading> : null}
            {description ? <p className="sp-card__description">{description}</p> : null}
          </div>
          {actions ? <div className="sp-card__actions">{actions}</div> : null}
        </header>
      ) : null}
      {children != null ? <div className="sp-card__body">{children}</div> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Badge, Kbd, StatusDot
// ---------------------------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'subtle' | 'accent' | 'warning' | 'danger' | 'success';

export function Badge({
  tone = 'neutral',
  children,
  title,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span className={cx('sp-badge', tone !== 'neutral' && `sp-badge--${tone}`, className)} title={title}>
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="sp-kbd">{children}</kbd>;
}

export type StatusTone = 'tracking' | 'idle' | 'paused' | 'off' | 'away' | 'danger' | 'accent';

/** Coloured state dot. Decorative: always render the state as text next to it. */
export function StatusDot({ tone, size = 'md' }: { tone: StatusTone; size?: 'md' | 'lg' }) {
  return <span className={cx('sp-dot', `sp-dot--${tone}`, size === 'lg' && 'sp-dot--lg')} aria-hidden="true" />;
}

// ---------------------------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------------------------

export type BannerTone = 'danger' | 'warning' | 'info' | 'success' | 'neutral';

export interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
  compact?: boolean;
  className?: string;
}

export function Banner({
  tone = 'neutral',
  title,
  children,
  action,
  onRetry,
  retryLabel = 'Retry',
  retrying = false,
  compact = false,
  className,
}: BannerProps) {
  const icon =
    tone === 'danger' ? (
      <IconAlertCircle />
    ) : tone === 'warning' ? (
      <IconAlert />
    ) : tone === 'success' ? (
      <IconCheckCircle />
    ) : (
      <IconInfo />
    );
  return (
    <div
      className={cx('sp-banner', tone !== 'neutral' && `sp-banner--${tone}`, compact && 'sp-banner--compact', className)}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <span className="sp-banner__icon">{icon}</span>
      <div className="sp-banner__body">
        {title ? <span className="sp-banner__title">{title}</span> : null}
        {children ? <span className="sp-banner__text">{children}</span> : null}
      </div>
      {action || onRetry ? (
        <div className="sp-banner__action">
          {action ??
            (onRetry ? (
              <Button size="sm" icon={<IconRefresh size={14} />} onClick={onRetry} pending={retrying}>
                {retryLabel}
              </Button>
            ) : null)}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Empty state & skeleton
// ---------------------------------------------------------------------------------------------

export function EmptyState({
  icon,
  title,
  children,
  action,
  compact = false,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cx('sp-empty', compact && 'sp-empty--compact')}>
      {icon ? <span className="sp-empty__icon">{icon}</span> : null}
      <p className="sp-empty__title">{title}</p>
      {children ? <p className="sp-empty__text">{children}</p> : null}
      {action ? <div className="sp-empty__action">{action}</div> : null}
    </div>
  );
}

export function Skeleton({
  width = '100%',
  height = 12,
  radius,
  className,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={cx('sp-skeleton', className)}
      style={{ width, height, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  );
}

/** A few lines of placeholder text, announced once as "Loading". */
export function SkeletonLines({ lines = 3, label = 'Loading' }: { lines?: number; label?: string }) {
  const widths = ['92%', '74%', '84%', '61%', '88%', '70%'];
  return (
    <div role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className="sp-skeleton--text" width={widths[index % widths.length]} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------------------------

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details className={cx('sp-disclosure', className)} open={defaultOpen || undefined}>
      <summary>
        <IconChevronRight size={14} className="sp-disclosure__chevron" />
        {summary}
      </summary>
      <div className="sp-disclosure__body">{children}</div>
    </details>
  );
}
