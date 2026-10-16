import type { ReactNode } from 'react';
import type { Route, Settings } from '@studio-pulse/shared-types';
import { SkeletonLines } from '@studio-pulse/ui';
import { ErrorBanner, ErrorBoundary, PageHeader } from '../../components/common';
import { useSettings } from '../../hooks/useLive';
import { SETTINGS_TABS, settingsRoute } from '../../lib/routes';
import type { SettingsTab } from '../../lib/routes';
import { AboutSettings } from './AboutSettings';
import { ApplicationsSettings } from './ApplicationsSettings';
import { GeneralSettings } from './GeneralSettings';
import { SyncSettings, WorkspaceSettings } from './PhaseTwoSettings';
import { PrivacySettings } from './PrivacySettings';
import { TrackingSettings } from './TrackingSettings';

export function SettingsView({ tab, onNavigate }: { tab: SettingsTab; onNavigate: (route: Route) => void }) {
  const settings = useSettings();
  const label = SETTINGS_TABS.find((item) => item.tab === tab)?.label ?? 'Settings';

  function needsSettings(render: (value: Settings) => ReactNode) {
    if (settings.data) return render(settings.data);
    if (settings.error)
      return <ErrorBanner title="Settings could not be loaded" error={settings.error} onRetry={() => void settings.reload()} />;
    return <SkeletonLines lines={6} label="Loading settings" />;
  }

  return (
    <div className="app-page app-page--settings">
      <PageHeader title="Settings" />
      <nav className="app-tabs" aria-label="Settings sections">
        {SETTINGS_TABS.map((item) => (
          <button
            key={item.tab}
            type="button"
            className="app-tabs__tab"
            aria-current={item.tab === tab ? 'page' : undefined}
            onClick={() => onNavigate(settingsRoute(item.tab))}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <section className="app-settings" aria-label={`${label} settings`}>
        <ErrorBoundary key={tab} label={`${label} settings`}>
          {tab === 'general' ? needsSettings((value) => <GeneralSettings settings={value} />) : null}
          {tab === 'tracking' ? needsSettings((value) => <TrackingSettings settings={value} />) : null}
          {tab === 'applications' ? <ApplicationsSettings /> : null}
          {tab === 'privacy' ? <PrivacySettings /> : null}
          {tab === 'workspace' ? <WorkspaceSettings /> : null}
          {tab === 'sync' ? <SyncSettings /> : null}
          {tab === 'about' ? <AboutSettings /> : null}
        </ErrorBoundary>
      </section>
    </div>
  );
}
