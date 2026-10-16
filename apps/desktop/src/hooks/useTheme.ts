import { useEffect } from 'react';
import type { ThemePreference } from '@studio-pulse/shared-types';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function stamp(theme: 'dark' | 'light') {
  const root = document.documentElement;
  if (root.dataset.theme !== theme) root.dataset.theme = theme;
}

/**
 * Stamp `data-theme` on <html>. `system` follows the OS setting live. Until settings load the
 * page stays dark (the default, and the native window background).
 */
export function useTheme(preference: ThemePreference | undefined): void {
  useEffect(() => {
    if (!preference) return;
    if (preference !== 'system') {
      stamp(preference);
      return;
    }
    const media = window.matchMedia(DARK_QUERY);
    const apply = () => stamp(media.matches ? 'dark' : 'light');
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preference]);
}
