import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@studio-pulse/ui/styles.css';
import './styles/app.css';
import './styles/indicator.css';
import { BrandMark } from '@studio-pulse/ui';
import { MainApp } from './app/MainApp';
import { ErrorBoundary } from './components/common';
import { IndicatorApp } from './indicator/IndicatorApp';
import { currentWindowLabel, isTauriRuntime } from './lib/api';

/** Shown when the page is opened outside the desktop shell (e.g. a plain browser). No mock data. */
function OutsideDesktop() {
  return (
    <main className="app-outside">
      <BrandMark size={40} />
      <h1>Studio Pulse must run inside the desktop app</h1>
      <p>This page talks to the Studio Pulse tracker on your computer and can’t work in a regular browser.</p>
    </main>
  );
}

const runtime = isTauriRuntime();
const windowLabel = runtime ? currentWindowLabel() : null;
document.documentElement.dataset.window = windowLabel === 'indicator' ? 'indicator' : 'main';

function Root() {
  if (!runtime) return <OutsideDesktop />;
  if (windowLabel === 'indicator') {
    return (
      <ErrorBoundary label="The indicator">
        <IndicatorApp />
      </ErrorBoundary>
    );
  }
  return <MainApp />;
}

const container = document.getElementById('root');
if (!container) throw new Error('#root element missing');
createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
