/**
 * Keeps the `dark` class on <html> in step with the OS light/dark setting.
 *
 * Tailwind is configured with darkMode: ["class"], so this is what makes the
 * dark: variants and the .dark token overrides in index.css apply. There is
 * deliberately no in-app toggle: one less setting to build and support.
 */
export function startThemeSync(): void {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
        document.documentElement.classList.toggle('dark', media.matches);
    };

    apply();

    // addEventListener is unavailable on the MediaQueryList in older WebViews.
    if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', apply);
    } else if (typeof media.addListener === 'function') {
        media.addListener(apply);
    }
}
