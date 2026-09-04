// ============================================
// LOCAL PERSISTENCE
// ============================================
// Thin wrapper over Capacitor Preferences, which uses UserDefaults on iOS,
// SharedPreferences on Android, and localStorage on web — so the same calls
// work on all three targets.
//
// Used for device-local settings (theme, notification opt-in, last known
// position). Anything that belongs to the *account* rather than the device
// goes to Firestore via auth.ts instead.
// ============================================

import { Preferences } from '@capacitor/preferences';

export const KEYS = {
    darkMode: 'sprout.darkMode',
    notifications: 'sprout.notifications',
    lastPosition: 'sprout.lastPosition',
    captures: 'sprout.captures',
} as const;

/**
 * Read a JSON-encoded value. Returns `fallback` when the key is unset or
 * holds malformed JSON (e.g. written by an older build).
 */
export async function getPref<T>(key: string, fallback: T): Promise<T> {
    try {
        const { value } = await Preferences.get({ key });
        if (value === null) return fallback;
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

/** Write a value as JSON. */
export async function setPref(key: string, value: unknown): Promise<void> {
    try {
        await Preferences.set({ key, value: JSON.stringify(value) });
    } catch {
        // Storage full or unavailable (e.g. Safari private mode). A lost
        // preference should never break the interaction that triggered it.
    }
}

/** Remove a key. */
export async function removePref(key: string): Promise<void> {
    try {
        await Preferences.remove({ key });
    } catch {
        // Non-fatal, as above.
    }
}
