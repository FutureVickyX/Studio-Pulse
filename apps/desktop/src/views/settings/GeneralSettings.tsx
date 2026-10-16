import type { Settings, ThemePreference } from '@studio-pulse/shared-types';
import { Badge, Card, SegmentedControl } from '@studio-pulse/ui';
import { InlineError, SettingRow } from '../../components/common';
import { useStartupStatus } from '../../hooks/useStartupStatus';
import { LaunchAtLoginSetting, SwitchSetting, useSettingsPatcher } from './shared';

const THEMES = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
] as const;

export function GeneralSettings({ settings }: { settings: Settings }) {
  const patcher = useSettingsPatcher();
  const startup = useStartupStatus();
  const general = settings.general;

  return (
    <>
      <Card title="Appearance">
        <SettingRow
          title="Theme"
          description="System follows the Windows light or dark setting."
          control={({ labelId }) => (
            <span aria-labelledby={labelId} role="presentation">
              <SegmentedControl<ThemePreference>
                aria-label="Theme"
                options={THEMES}
                value={general.theme}
                disabled={patcher.isPending('theme')}
                onChange={(theme) => void patcher.apply('theme', { general: { theme } })}
              />
            </span>
          )}
        >
          <InlineError error={patcher.errorFor('theme')} />
        </SettingRow>
      </Card>

      <Card title="Startup and window">
        <LaunchAtLoginSetting startup={startup} />
        <SwitchSetting
          title="Start minimized"
          description="When Windows starts Studio Pulse, stay in the system tray. Tracking runs in the background."
          checked={general.startMinimized}
          pending={patcher.isPending('startMinimized')}
          error={patcher.errorFor('startMinimized')}
          onChange={(startMinimized) => void patcher.apply('startMinimized', { general: { startMinimized } })}
        />
        <SwitchSetting
          title="Launch full window on startup"
          description={
            general.startMinimized
              ? 'Not used while Start minimized is on: only the tray icon appears at sign-in.'
              : 'At sign-in, open the full window instead of the compact indicator.'
          }
          checked={general.launchFullWindowOnStartup}
          disabled={general.startMinimized}
          pending={patcher.isPending('launchFullWindowOnStartup')}
          error={patcher.errorFor('launchFullWindowOnStartup')}
          onChange={(launchFullWindowOnStartup) =>
            void patcher.apply('launchFullWindowOnStartup', { general: { launchFullWindowOnStartup } })
          }
        />
        <SwitchSetting
          title="Minimize to tray"
          description={
            general.minimizeToTray
              ? 'Closing or minimizing the window keeps Studio Pulse running in the tray, and tracking continues.'
              : 'Closing the window quits Studio Pulse, and tracking stops.'
          }
          checked={general.minimizeToTray}
          pending={patcher.isPending('minimizeToTray')}
          error={patcher.errorFor('minimizeToTray')}
          onChange={(minimizeToTray) => void patcher.apply('minimizeToTray', { general: { minimizeToTray } })}
        />
      </Card>

      <Card title="Shortcuts">
        <SettingRow
          title="Global shortcut"
          description="Quick capture arrives in Phase 3."
          badge={<Badge tone="subtle">Phase 3</Badge>}
          disabled
        />
      </Card>
    </>
  );
}
