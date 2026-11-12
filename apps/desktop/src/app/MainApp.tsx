import { SkeletonLines } from '@studio-pulse/ui';
import { EntryScreen, ErrorBanner, ErrorBoundary } from '../components/common';
import { useSettings } from '../hooks/useLive';
import { Onboarding } from './Onboarding';
import { Shell } from './Shell';

/** Main window: onboarding until it is completed, then the workspace shell. */
export function MainApp() {
  const settings = useSettings();

  if (!settings.data) {
    return (
      <EntryScreen title="Studio Pulse">
        {settings.error ? (
          <ErrorBanner title="Studio Pulse could not load its settings" error={settings.error} onRetry={() => void settings.reload()} />
        ) : (
          <SkeletonLines lines={2} label="Starting Studio Pulse" />
        )}
      </EntryScreen>
    );
  }

  return (
    <ErrorBoundary label="Studio Pulse" screen>
      {settings.data.onboarding.completed ? <Shell /> : <Onboarding settings={settings.data} />}
    </ErrorBoundary>
  );
}
