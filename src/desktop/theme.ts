import { useEffect } from 'react';
import type { ThemePreference } from '../shared/desktop-contract';

/** Apply the saved preference to every panel view and native form control. */
export function usePanelTheme(preference: ThemePreference): void {
  useEffect(() => {
    const root = document.documentElement;
    const media = preference === 'system' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined;
    const apply = () => {
      root.dataset.theme = preference === 'system' ? (media?.matches ? 'dark' : 'light') : preference;
    };
    apply();
    media?.addEventListener('change', apply);
    return () => {
      media?.removeEventListener('change', apply);
      delete root.dataset.theme;
    };
  }, [preference]);
}
