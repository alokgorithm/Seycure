/**
 * Which of the two themes is showing, and who decided.
 *
 * Tailwind is configured with darkMode: ["class"], so everything here comes
 * down to whether `dark` is on <html>: that is what switches the dark:
 * variants and the .dark token block in index.css.
 *
 * There are three choices, not two. "System" follows the OS and is the
 * default, because a phone that is already in dark mode should not open a
 * privacy tool in white at night. Light and Dark pin the app regardless of
 * the OS, which is the case the OS-only version could not serve: there was no
 * way to see either theme from inside the app, or to keep one you preferred.
 *
 * The choice is stored in Preferences, so it survives a restart. It is a
 * display preference and never leaves the device.
 */
import { Preferences } from '@capacitor/preferences';

export type ThemeChoice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'seycure_theme';

/** The live choice, so the OS listener knows whether it still has a say. */
let current: ThemeChoice = 'system';

function systemPrefersDark(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Resolves a choice to a theme and puts it on <html>. */
function applyChoice(choice: ThemeChoice): void {
    if (typeof document === 'undefined') return;
    const dark = choice === 'dark' || (choice === 'system' && systemPrefersDark());
    document.documentElement.classList.toggle('dark', dark);
}

function isThemeChoice(value: string | null | undefined): value is ThemeChoice {
    return value === 'light' || value === 'dark' || value === 'system';
}

/** The stored choice, or 'system' when nothing has been chosen yet. */
export async function getThemeChoice(): Promise<ThemeChoice> {
    try {
        const { value } = await Preferences.get({ key: STORAGE_KEY });
        return isThemeChoice(value) ? value : 'system';
    } catch {
        // A storage failure must not leave the app themeless.
        return 'system';
    }
}

/** Applies a choice straight away, then remembers it. */
export async function setThemeChoice(choice: ThemeChoice): Promise<void> {
    current = choice;
    applyChoice(choice);
    try {
        await Preferences.set({ key: STORAGE_KEY, value: choice });
    } catch {
        // The theme is already applied; losing the preference is not worth
        // interrupting the user over.
    }
}

/**
 * Applies the stored theme and keeps it in step with the OS.
 *
 * The system theme is applied synchronously first because reading
 * Preferences is async, and waiting for it would show a flash of the wrong
 * theme on every launch. A stored Light or Dark then overrides it a tick
 * later, which is invisible in practice.
 */
export function startThemeSync(): void {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    applyChoice('system');

    void getThemeChoice().then(choice => {
        current = choice;
        applyChoice(choice);
    });

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemChange = () => {
        // A pinned theme ignores the OS; that is the point of pinning it.
        if (current === 'system') applyChoice('system');
    };

    // addEventListener is unavailable on the MediaQueryList in older WebViews.
    if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', onSystemChange);
    } else if (typeof media.addListener === 'function') {
        media.addListener(onSystemChange);
    }
}
