import { Component, useId } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { formatDuration } from '@studio-pulse/time-engine';
import { Banner, Button, StatusDot } from '@studio-pulse/ui';
import type { StatusTone } from '@studio-pulse/ui';
import type { CommandError } from '@studio-pulse/shared-types';
import { useNow } from '../hooks/useLive';
import { parseIso } from '../lib/format';
import type { StatusPresentation } from '../lib/status';

// ---------------------------------------------------------------------------------------------
// Live duration: the only thing that re-renders every second
// ---------------------------------------------------------------------------------------------

/** `H:MM:SS` since `startedAt`, ticking once per second while the window is visible. */
export function LiveDuration({ startedAt, className }: { startedAt: string; className?: string }) {
  const startMs = parseIso(startedAt);
  const now = useNow(1000, startMs ?? 0);
  if (startMs === null) return null;
  return (
    <span role="timer" className={className ?? 'sp-num'}>
      {formatDuration(Math.max(0, now - startMs), 'clock')}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Status label: dot + text (state is never conveyed by colour alone)
// ---------------------------------------------------------------------------------------------

export function StatusLabel({
  presentation,
  size = 'md',
  className,
}: {
  presentation: Pick<StatusPresentation, 'tone' | 'label'>;
  size?: 'md' | 'lg';
  className?: string;
}) {
  return (
    <span className={className ?? 'app-status-label'}>
      <StatusDot tone={presentation.tone as StatusTone} size={size} />
      <span>{presentation.label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Page header & setting row
// ---------------------------------------------------------------------------------------------

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="app-page__header">
      <div className="app-page__titles">
        <h1 className="app-page__title">{title}</h1>
        {subtitle ? <p className="app-page__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="app-page__actions">{actions}</div> : null}
    </header>
  );
}

export interface SettingRowProps {
  title: ReactNode;
  description?: ReactNode;
  /** The control (switch, select, input…). Receives the generated ids via render prop. */
  control?: (ids: { labelId: string; descriptionId: string | undefined; controlId: string }) => ReactNode;
  /** Content below the row (status details, errors). */
  children?: ReactNode;
  disabled?: boolean;
  badge?: ReactNode;
}

export function SettingRow({ title, description, control, children, disabled = false, badge }: SettingRowProps) {
  const base = useId();
  const labelId = `${base}-label`;
  const descriptionId = description ? `${base}-description` : undefined;
  const controlId = `${base}-control`;
  return (
    <div className="app-setting" data-disabled={disabled || undefined}>
      <div className="app-setting__main">
        <div className="app-setting__text">
          <label className="app-setting__title" id={labelId} htmlFor={controlId}>
            {title}
            {badge}
          </label>
          {description ? (
            <p className="app-setting__description" id={descriptionId}>
              {description}
            </p>
          ) : null}
        </div>
        {control ? <div className="app-setting__control">{control({ labelId, descriptionId, controlId })}</div> : null}
      </div>
      {children ? <div className="app-setting__extra">{children}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export function InlineError({ error }: { error: CommandError | null | undefined }) {
  if (!error) return null;
  return (
    <p className="app-inline-error" role="alert">
      {error.message}
    </p>
  );
}

export function ErrorBanner({
  title,
  error,
  onRetry,
  retrying,
}: {
  title: ReactNode;
  error: CommandError;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <Banner tone="danger" title={title} onRetry={onRetry} retrying={retrying}>
      {error.message}
    </Banner>
  );
}

interface BoundaryState {
  error: Error | null;
}

/** Last-resort boundary: a view that throws shows a banner instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('View crashed', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app-crash">
        <Banner
          tone="danger"
          title={`${this.props.label ?? 'This view'} could not be displayed`}
          action={
            <Button size="sm" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          }
        >
          {this.state.error.message || 'An unexpected error occurred.'}
        </Banner>
      </div>
    );
  }
}
