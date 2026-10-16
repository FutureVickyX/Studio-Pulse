/**
 * Human presentation of the tracker state. Every state has a short label (shown next to a dot,
 * so state is never colour alone), a headline and a one-line explanation.
 */

import type { TrackerState, TrackerStatus } from '@studio-pulse/shared-types';

/** Mirrors `StatusTone` in @studio-pulse/ui (kept local so this module stays DOM-free). */
export type StatusToneName = 'tracking' | 'idle' | 'paused' | 'off' | 'away' | 'danger';

export interface StatusPresentation {
  state: TrackerState;
  tone: StatusToneName;
  label: string;
  headline: string;
  explanation: string;
}

export interface DescribeOptions {
  /** Formats an epoch-ms instant as a local clock time (for "Paused until 14:30"). */
  formatTime: (ms: number) => string;
}

function idleMinutes(status: TrackerStatus): number {
  return Math.max(1, Math.round(status.idleThresholdSeconds / 60));
}

export function describeStatus(status: TrackerStatus, options: DescribeOptions): StatusPresentation {
  const app = status.current?.applicationName ?? null;
  switch (status.state) {
    case 'notStarted':
      return {
        state: status.state,
        tone: 'off',
        label: 'Not started',
        headline: 'Tracking hasn’t started',
        explanation: 'Finish setup to choose your applications. Nothing is recorded until then.',
      };
    case 'tracking':
      return {
        state: status.state,
        tone: 'tracking',
        label: 'Tracking',
        headline: app ?? 'Tracking',
        explanation: 'Active time is being recorded while you work in this app.',
      };
    case 'idle':
      return {
        state: status.state,
        tone: 'idle',
        label: 'Idle',
        headline: app ?? 'Idle',
        explanation: `No keyboard or mouse input for ${idleMinutes(status)} min, so this time counts as idle, not active.`,
      };
    case 'untracked':
      return {
        state: status.state,
        tone: 'paused',
        label: 'Other app',
        headline: 'An untracked app is in front',
        explanation: 'It isn’t in your tracked applications, so nothing is recorded.',
      };
    case 'away':
      return {
        state: status.state,
        tone: 'away',
        label: 'Away',
        headline: 'You’re away',
        explanation: 'The screen is locked or the screen saver is on. Nothing is recorded.',
      };
    case 'paused': {
      // A pause is stored by the tracker and survives restarts of Studio Pulse and of Windows.
      const until = status.pausedUntil ? Date.parse(status.pausedUntil) : Number.NaN;
      return {
        state: status.state,
        tone: 'paused',
        label: 'Paused',
        headline: Number.isFinite(until) ? `Paused until ${options.formatTime(until)}` : 'Paused until you resume',
        explanation: Number.isFinite(until)
          ? 'Nothing is recorded until then, even across a restart. Tracking then resumes on its own.'
          : 'Nothing is recorded until you resume, even after Studio Pulse or Windows restarts.',
      };
    }
    case 'disabled':
      return {
        state: status.state,
        tone: 'off',
        label: 'Tracking off',
        headline: 'Tracking is switched off',
        explanation: 'Turn it on in Settings › Tracking. Nothing is recorded meanwhile.',
      };
    case 'clockBehind':
      return {
        state: status.state,
        tone: 'danger',
        label: 'Clock moved back',
        headline: 'Waiting for the system clock',
        explanation: 'The clock moved backwards. Recording resumes when it catches up, so no time is counted twice.',
      };
  }
}

/** Pause/resume affordance for a state. */
export function pauseAction(state: TrackerState): 'pause' | 'resume' | 'none' {
  if (state === 'paused') return 'resume';
  if (state === 'notStarted' || state === 'disabled') return 'none';
  return 'pause';
}

/** The live session counter applies only while an interval is open. */
export function hasLiveSession(status: TrackerStatus): boolean {
  return (status.state === 'tracking' || status.state === 'idle') && status.current !== null;
}
