import { describe, expect, it, vi } from 'vitest';
import type { CurrentInterval, TrackerState, TrackerStatus } from '@studio-pulse/shared-types';

import { describeStatus, hasLiveSession, pauseAction } from '../../../apps/desktop/src/lib/status';
import type { StatusToneName } from '../../../apps/desktop/src/lib/status';

const ALL_STATES: readonly TrackerState[] = [
  'notStarted',
  'tracking',
  'idle',
  'untracked',
  'away',
  'paused',
  'disabled',
  'clockBehind',
];

const TONES: readonly StatusToneName[] = ['tracking', 'idle', 'paused', 'off', 'away', 'danger'];

const FIGMA: CurrentInterval = {
  eventId: '0192a1b2-0000-7000-8000-000000000001',
  applicationId: 'figma',
  applicationName: 'Figma',
  category: 'design',
  kind: 'active',
  startedAt: '2026-10-13T09:00:00.000Z',
};

function status(state: TrackerState, overrides: Partial<TrackerStatus> = {}): TrackerStatus {
  return {
    state,
    current: null,
    pausedUntil: null,
    lastSampleAt: '2026-10-13T09:30:00.000Z',
    idleThresholdSeconds: 300,
    ...overrides,
  };
}

/** Deterministic clock formatter: UTC HH:MM. */
const options = { formatTime: (ms: number) => new Date(ms).toISOString().slice(11, 16) };

describe('describeStatus: every TrackerState', () => {
  it.each(ALL_STATES)('%s has a label, headline, explanation and a known tone', (state) => {
    const presentation = describeStatus(status(state), options);
    expect(presentation.state).toBe(state);
    expect(TONES).toContain(presentation.tone);
    expect(presentation.label.trim()).not.toBe('');
    expect(presentation.headline.trim()).not.toBe('');
    expect(presentation.explanation.trim()).not.toBe('');
  });

  it('gives every state its own text label (tones are shared, so colour alone never tells states apart)', () => {
    const labels = ALL_STATES.map((state) => describeStatus(status(state), options).label);
    expect(new Set(labels).size).toBe(ALL_STATES.length);
  });

  it.each([
    ['notStarted', 'Not started', /Nothing is recorded until then/],
    ['untracked', 'Other app', /nothing is recorded/],
    ['away', 'Away', /locked or the screen saver/],
    ['disabled', 'Tracking off', /Settings › Tracking/],
    ['clockBehind', 'Clock moved back', /catches up/],
  ] as const)('%s reads "%s"', (state, label, explanation) => {
    const presentation = describeStatus(status(state), options);
    expect(presentation.label).toBe(label);
    expect(presentation.explanation).toMatch(explanation);
  });
});

describe('describeStatus: tracking and idle', () => {
  it('headlines the current application while tracking', () => {
    const presentation = describeStatus(status('tracking', { current: FIGMA }), options);
    expect(presentation.label).toBe('Tracking');
    expect(presentation.tone).toBe('tracking');
    expect(presentation.headline).toBe('Figma');
  });

  it('falls back to the label when no interval is open yet', () => {
    expect(describeStatus(status('tracking'), options).headline).toBe('Tracking');
    expect(describeStatus(status('idle'), options).headline).toBe('Idle');
  });

  it.each([
    [300, '5 min'],
    [60, '1 min'],
    [90, '2 min'],
    [20, '1 min'],
    [7_200, '120 min'],
  ])('explains idle with the configured threshold (%i s → %s)', (seconds, text) => {
    const presentation = describeStatus(
      status('idle', { current: { ...FIGMA, kind: 'idle' }, idleThresholdSeconds: seconds }),
      options,
    );
    expect(presentation.tone).toBe('idle');
    expect(presentation.headline).toBe('Figma');
    expect(presentation.explanation).toContain(`for ${text}`);
    expect(presentation.explanation).toMatch(/idle, not active/);
  });
});

describe('describeStatus: paused', () => {
  it('names the resume time for a timed pause', () => {
    const formatTime = vi.fn(options.formatTime);
    const presentation = describeStatus(status('paused', { pausedUntil: '2026-10-13T14:30:00.000Z' }), { formatTime });
    expect(formatTime).toHaveBeenCalledWith(Date.parse('2026-10-13T14:30:00.000Z'));
    expect(presentation.label).toBe('Paused');
    expect(presentation.tone).toBe('paused');
    expect(presentation.headline).toBe('Paused until 14:30');
    expect(presentation.explanation).toMatch(/resumes on its own/);
  });

  it('says a timed pause holds across a restart (the tracker persists it)', () => {
    const presentation = describeStatus(status('paused', { pausedUntil: '2026-10-13T14:30:00.000Z' }), options);
    expect(presentation.explanation).toMatch(/restart/);
  });

  it('pauses until resumed when there is no end time', () => {
    const formatTime = vi.fn(options.formatTime);
    const presentation = describeStatus(status('paused'), { formatTime });
    expect(formatTime).not.toHaveBeenCalled();
    expect(presentation.label).toBe('Paused');
    expect(presentation.headline).toBe('Paused until you resume');
    expect(presentation.explanation).toMatch(/until you resume/);
  });

  it('never implies that restarting resumes an open-ended pause', () => {
    const { explanation } = describeStatus(status('paused'), options);
    expect(explanation).toMatch(/even after Studio Pulse or Windows restarts/);
    expect(explanation).not.toMatch(/resumes on its own/);
  });

  it('treats an unreadable pausedUntil as "until you resume" rather than inventing a time', () => {
    const presentation = describeStatus(status('paused', { pausedUntil: 'not a date' }), options);
    expect(presentation.headline).toBe('Paused until you resume');
  });
});

describe('pauseAction', () => {
  it.each([
    ['notStarted', 'none'],
    ['disabled', 'none'],
    ['paused', 'resume'],
    ['tracking', 'pause'],
    ['idle', 'pause'],
    ['untracked', 'pause'],
    ['away', 'pause'],
    ['clockBehind', 'pause'],
  ] as const)('%s → %s', (state, action) => {
    expect(pauseAction(state)).toBe(action);
  });

  it('never offers to start tracking before onboarding is complete', () => {
    expect(pauseAction('notStarted')).toBe('none');
  });
});

describe('hasLiveSession', () => {
  it('is true only while tracking or idle with an open interval', () => {
    expect(hasLiveSession(status('tracking', { current: FIGMA }))).toBe(true);
    expect(hasLiveSession(status('idle', { current: { ...FIGMA, kind: 'idle' } }))).toBe(true);
    expect(hasLiveSession(status('tracking'))).toBe(false);
    for (const state of ALL_STATES.filter((s) => s !== 'tracking' && s !== 'idle')) {
      expect(hasLiveSession(status(state, { current: FIGMA })), state).toBe(false);
    }
  });
});
