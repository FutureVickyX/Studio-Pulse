import { BrandMark, SkeletonLines } from '@studio-pulse/ui';
import { ErrorBanner, ErrorBoundary } from '../components/common';
import { useSettings } from '../hooks/useLive';
import { useTheme } from '../hooks/useTheme';
import { Onboarding } from './Onboarding';
import { Shell } from './Shell';

/** Main window: onboarding until it is completed, then the workspace shell. */
export function MainApp() {
  const settings = useSettings();
  useTheme(settings.data?.general.theme);

  if (!settings.data) {
    return (
      <div className="app-boot">
        <BrandMark size={36} />
        {settings.error ? (
          <ErrorBanner title="Studio Pulse could not load its settings" error={settings.error} onRetry={() => void settings.reload()} />
        ) : (
          <div className="app-boot__loading">
            <SkeletonLines lines={2} label="Starting Studio Pulse" />
          </div>
        )}
      </div>
    );
  }

  return (
    <ErrorBoundary label="Studio Pulse">
      {settings.data.onboarding.completed ? <Shell /> : <Onboarding settings={settings.data} />}
    </ErrorBoundary>
  );
}
