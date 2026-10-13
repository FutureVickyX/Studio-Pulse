import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Skeleton entry point. Replaced by the workspace shell (main window) and the compact
// indicator (indicator window); see docs/architecture.md §12.
function Placeholder() {
  return <p style={{ fontFamily: 'Segoe UI Variable, Segoe UI, sans-serif' }}>Studio Pulse</p>;
}

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');
createRoot(root).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>,
);
