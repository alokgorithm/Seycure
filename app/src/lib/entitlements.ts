/**
 * Whether the user has the Pro unlock.
 *
 * Phase 2 has not been built yet, so there is no Play Billing here and nothing
 * writes the key: `isProUnlocked()` returns false for everyone, which is the
 * safe default - a Pro feature stays shut rather than shipping free by
 * accident. This module exists now because Phase 2's first feature landed
 * ahead of it and needed something to gate against.
 *
 * When Play Billing arrives it replaces the *source* of this value, not the
 * interface. Per CLAUDE.md §7 the entitlement is cached so the app works
 * offline and re-verified with queryPurchases() on launch and on resume, so a
 * refund re-locks. Callers should keep using isProUnlocked() and nothing else.
 */
import { Preferences } from '@capacitor/preferences';
import { isDebugBuild } from '@/hooks/usePdfUnlock';

const PRO_KEY = 'seycure_pro_unlocked';

export async function isProUnlocked(): Promise<boolean> {
    try {
        const { value } = await Preferences.get({ key: PRO_KEY });
        return value === 'true';
    } catch {
        // A storage failure must not hand out Pro.
        return false;
    }
}

/**
 * Writes the cached entitlement. Phase 2 calls this from the billing result
 * and from the queryPurchases() re-check; nothing else should.
 */
export async function setProUnlocked(unlocked: boolean): Promise<void> {
    await Preferences.set({ key: PRO_KEY, value: unlocked ? 'true' : 'false' });
}

/**
 * Whether PDF unlocking is available.
 *
 * Pro or a debug build, and nothing else. In a release build isProUnlocked()
 * is false for everyone until Phase 2 writes the key, so release fails closed;
 * the debug arm exists only so the feature can be tested on a device before
 * then. There is deliberately no flag, query parameter or stored value that
 * opens this in a release build - if one existed, it would be the first thing
 * worth abusing.
 */
export async function canUnlockPdfs(): Promise<boolean> {
    if (await isDebugBuild()) return true;
    return isProUnlocked();
}
