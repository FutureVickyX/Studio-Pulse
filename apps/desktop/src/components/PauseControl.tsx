import { Button, IconChevronDown, IconPause, IconPlay, Menu } from '@studio-pulse/ui';
import type { MenuItem } from '@studio-pulse/ui';
import type { TrackerState } from '@studio-pulse/shared-types';
import { useTrackerActions } from '../hooks/useLive';
import { pauseAction } from '../lib/status';
import { InlineError } from './common';

export const PAUSE_OPTIONS: ReadonlyArray<{ id: string; label: string; minutes: number | null }> = [
  { id: '15m', label: 'For 15 minutes', minutes: 15 },
  { id: '1h', label: 'For 1 hour', minutes: 60 },
  { id: 'resume', label: 'Until I resume', minutes: null },
];

const NONE_REASON: Partial<Record<TrackerState, string>> = {
  notStarted: 'Tracking starts after setup',
  disabled: 'Tracking is switched off in Settings',
};

export interface PauseControlProps {
  state: TrackerState | undefined;
  size?: 'sm' | 'md';
  className?: string;
  /** Show command errors under the button. */
  showError?: boolean;
  placement?: 'bottom-start' | 'top-start' | 'bottom-end';
}

/** Pause (with a 15 min / 1 hour / until resumed menu) or Resume, from confirmed tracker state. */
export function PauseControl({ state, size = 'sm', className, showError = true, placement = 'bottom-start' }: PauseControlProps) {
  const actions = useTrackerActions();
  const mode = state ? pauseAction(state) : 'none';

  let control;
  if (mode === 'resume') {
    control = (
      <Button
        size={size}
        variant="primary"
        icon={<IconPlay size={13} />}
        pending={actions.pending}
        onClick={() => void actions.resume()}
        className={className}
      >
        Resume
      </Button>
    );
  } else if (mode === 'pause') {
    const items: MenuItem[] = PAUSE_OPTIONS.map((option) => ({
      id: option.id,
      label: option.label,
      onSelect: () => void actions.pause(option.minutes),
    }));
    control = (
      <Menu
        aria-label="Pause tracking"
        label="Pause tracking"
        items={items}
        placement={placement}
        trigger={(props) => (
          <Button
            {...props}
            size={size}
            icon={<IconPause size={13} />}
            iconAfter={<IconChevronDown size={13} className="app-pause__chevron" />}
            pending={actions.pending}
            className={className}
          >
            Pause
          </Button>
        )}
      />
    );
  } else {
    const reason = (state && NONE_REASON[state]) ?? 'Loading tracker status';
    control = (
      <Button size={size} icon={<IconPause size={13} />} disabled title={reason} aria-description={reason} className={className}>
        Pause
      </Button>
    );
  }

  return (
    <>
      {control}
      {showError ? <InlineError error={actions.error} /> : null}
    </>
  );
}
