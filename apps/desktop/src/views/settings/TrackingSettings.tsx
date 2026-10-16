import { SETTINGS_LIMITS } from '@studio-pulse/shared-types';
import type { Settings } from '@studio-pulse/shared-types';
import { currentTimeZone } from '@studio-pulse/time-engine';
import { Card, Disclosure } from '@studio-pulse/ui';
import { SettingRow, StatusLabel } from '../../components/common';
import { PauseControl } from '../../components/PauseControl';
import { useTrackerStatus } from '../../hooks/useLive';
import { clockTime } from '../../lib/format';
import { describeStatus } from '../../lib/status';
import { NumberSetting, SwitchSetting, useSettingsPatcher } from './shared';

export function TrackingSettings({ settings }: { settings: Settings }) {
  const patcher = useSettingsPatcher();
  const tracking = settings.tracking;
  const limits = SETTINGS_LIMITS;

  return (
    <>
      <Card title="Recording">
        <SwitchSetting
          title="Enable tracking"
          description="Master switch. When off, nothing is recorded."
          checked={tracking.enabled}
          pending={patcher.isPending('enabled')}
          error={patcher.errorFor('enabled')}
          onChange={(enabled) => void patcher.apply('enabled', { tracking: { enabled } })}
        />
        <SwitchSetting
          title="Start tracking automatically"
          description="Record as soon as Studio Pulse launches. When off, it launches paused until you resume. A pause you started yourself is kept across restarts either way."
          checked={tracking.startAutomatically}
          disabled={!tracking.enabled}
          pending={patcher.isPending('startAutomatically')}
          error={patcher.errorFor('startAutomatically')}
          onChange={(startAutomatically) => void patcher.apply('startAutomatically', { tracking: { startAutomatically } })}
        />
        <SwitchSetting
          title="Tracking notifications"
          description="Allow Studio Pulse to show Windows notifications about tracking."
          checked={tracking.notifications}
          pending={patcher.isPending('notifications')}
          error={patcher.errorFor('notifications')}
          onChange={(notifications) => void patcher.apply('notifications', { tracking: { notifications } })}
        />
      </Card>

      <Card title="Idle detection">
        <SwitchSetting
          title="Pause tracking when idle"
          description={
            tracking.pauseWhenIdle
              ? 'After the idle timeout without keyboard or mouse input, time counts as idle instead of active.'
              : 'Off: time without input counts as active, for example while watching renders or reviewing playback.'
          }
          checked={tracking.pauseWhenIdle}
          pending={patcher.isPending('pauseWhenIdle')}
          error={patcher.errorFor('pauseWhenIdle')}
          onChange={(pauseWhenIdle) => void patcher.apply('pauseWhenIdle', { tracking: { pauseWhenIdle } })}
        />
        <NumberSetting
          title="Idle timeout"
          description={`Minutes without input before time counts as idle (${limits.idleTimeoutMinutes.min}–${limits.idleTimeoutMinutes.max}). Only the time of the last input is read, never what it was.`}
          value={tracking.idleTimeoutMinutes}
          min={limits.idleTimeoutMinutes.min}
          max={limits.idleTimeoutMinutes.max}
          unit="min"
          disabled={!tracking.pauseWhenIdle}
          pending={patcher.isPending('idleTimeoutMinutes')}
          error={patcher.errorFor('idleTimeoutMinutes')}
          onCommit={(idleTimeoutMinutes) => patcher.apply('idleTimeoutMinutes', { tracking: { idleTimeoutMinutes } })}
        />
      </Card>

      <Card title="Pause">
        <PauseRow />
      </Card>

      <Card>
        <Disclosure summary="Advanced">
          <NumberSetting
            title="Aggregation window"
            description={`How often the interval being recorded is saved (${limits.checkpointSeconds.min}–${limits.checkpointSeconds.max} s). One long session stays one record; after a crash at most this much is lost.`}
            value={tracking.checkpointSeconds}
            min={limits.checkpointSeconds.min}
            max={limits.checkpointSeconds.max}
            unit="s"
            pending={patcher.isPending('checkpointSeconds')}
            error={patcher.errorFor('checkpointSeconds')}
            onCommit={(checkpointSeconds) => patcher.apply('checkpointSeconds', { tracking: { checkpointSeconds } })}
          />
          <NumberSetting
            title="Minimum interval"
            description={`Stretches shorter than this are discarded, which filters quick Alt+Tab flicks (${limits.minimumIntervalSeconds.min}–${limits.minimumIntervalSeconds.max} s).`}
            value={tracking.minimumIntervalSeconds}
            min={limits.minimumIntervalSeconds.min}
            max={limits.minimumIntervalSeconds.max}
            unit="s"
            pending={patcher.isPending('minimumIntervalSeconds')}
            error={patcher.errorFor('minimumIntervalSeconds')}
            onCommit={(minimumIntervalSeconds) =>
              patcher.apply('minimumIntervalSeconds', { tracking: { minimumIntervalSeconds } })
            }
          />
        </Disclosure>
      </Card>
    </>
  );
}

function PauseRow() {
  const { data: status } = useTrackerStatus();
  const presentation = status ? describeStatus(status, { formatTime: (ms) => clockTime(ms, currentTimeZone()) }) : null;
  return (
    <SettingRow
      title="Pause or resume"
      description={presentation ? `${presentation.headline}. ${presentation.explanation}` : 'Loading tracker status…'}
      badge={presentation ? <StatusLabel presentation={presentation} className="app-status-label app-status-label--inline" /> : null}
      control={() => <PauseControl state={status?.state} placement="bottom-end" />}
    />
  );
}
