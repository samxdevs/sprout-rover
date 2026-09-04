// ============================================
// THEME
// ============================================
// Dark mode works by stamping data-theme on <html>; styles.css overrides the
// colour custom properties under [data-theme="dark"]. Applied before first
// paint (see main.ts) so the app never flashes light then swaps.
// ============================================

import { KEYS, getPref, setPref } from './storage';

export type Theme = 'light' | 'dark';

/** Write the theme to the document so the CSS overrides take effect. */
export function applyTheme(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
    // Keeps native form controls, scrollbars and the iOS status bar legible.
    document.documentElement.style.colorScheme = theme;
}

/**
 * Load the stored preference and apply it. Falls back to the OS setting the
 * first time, so the app matches the device rather than always starting light.
 */
export async function initTheme(): Promise<boolean> {
    const osPrefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    const isDark = await getPref<boolean>(KEYS.darkMode, osPrefersDark);
    applyTheme(isDark ? 'dark' : 'light');
    return isDark;
}

/** Apply and persist a theme change. */
export async function setDarkMode(isDark: boolean): Promise<void> {
    applyTheme(isDark ? 'dark' : 'light');
    await setPref(KEYS.darkMode, isDark);
}
