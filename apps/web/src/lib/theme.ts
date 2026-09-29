export type Theme = 'light' | 'dark';

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

/** User override of prefers-color-scheme (design system 10); read before first paint in index.html. */
export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('cbam.theme', theme);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}
