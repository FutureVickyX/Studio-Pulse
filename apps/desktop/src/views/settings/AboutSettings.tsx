import { Badge, BrandMark, Card, SkeletonLines } from '@studio-pulse/ui';
import { ErrorBanner } from '../../components/common';
import { useAppInfo } from '../../hooks/useLive';

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

export function AboutSettings() {
  const info = useAppInfo();
  const app = info.data;
  return (
    <>
      <Card>
        {info.error && !app ? (
          <ErrorBanner title="App information is unavailable" error={info.error} onRetry={() => void info.reload()} />
        ) : null}
        {!app && !info.error ? <SkeletonLines lines={3} label="Loading app information" /> : null}
        {app ? (
          <div className="app-about">
            <BrandMark size={44} />
            <div className="app-about__text">
              <p className="app-about__name">
                {app.name}
                {app.isDevelopmentBuild ? <Badge tone="warning">Development build</Badge> : null}
              </p>
              <p className="app-about__version sp-num">Version {app.version}</p>
            </div>
          </div>
        ) : null}
        {app ? (
          <dl className="app-facts app-facts--spaced">
            <div>
              <dt>Platform</dt>
              <dd>{PLATFORM_NAMES[app.platform] ?? app.platform}</dd>
            </div>
            <div>
              <dt>This launch</dt>
              <dd>{app.launchedAtLogin ? 'Started by Windows at sign-in' : 'Opened manually'}</dd>
            </div>
            <div className="app-facts__wide">
              <dt>Data directory</dt>
              <dd>
                <code className="sp-mono app-break">{app.dataDirectory}</code>
              </dd>
            </div>
          </dl>
        ) : null}
      </Card>
      <Card title="Privacy">
        <p className="app-prose">
          Studio Pulse records which tracked application is in front, when, and whether you were active or idle. It never
          records screenshots, keystrokes, window titles, file contents, clipboard or browsing. Everything stays on this
          device unless you sign in and choose a workspace in Settings › Sync.
        </p>
      </Card>
    </>
  );
}
