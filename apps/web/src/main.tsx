import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@studio-pulse/ui/styles.css';
import './styles/web.css';

import { App } from './app/App';

/** Follow the system light/dark preference (the design system is dark-first). */
function applyTheme() {
  const light = window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
}
applyTheme();
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

const container = document.getElementById('root');
if (!container) throw new Error('#root element missing');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
