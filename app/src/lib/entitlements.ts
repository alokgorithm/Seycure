/**
 * Whether the user has the Pro unlock.
 *
 * Play Billing is Phase 2 slice 2 and is not here yet, so in a release build
 * nothing writes the key and isProUnlocked() is false for everyone. That is
 * the safe default: a Pro feature stays shut rather than shipping free by
 * accident.
 *
 * In a debug build the key can be written from Settings, so both sides can be
 * exercised on a device. It is deliberately *not* hardcoded true under
 * BuildConfig.DEBUG: the free tier's daily quota only applies to non-Pro
 * users, so a debug build that is always Pro can never reach the quota, the
 * paywall, or anything else being built in this slice. Defaulting the debug
 * override to off means the free path is what you get unless you ask for the
 * other one.
 *
 * The debug gate is on the *writer*, not the reader. A release build has no
 * way to set the key, so no flag, query parameter or stored value opens Pro
 * there - if one existed it would be the first thing worth abusing.
 *
 * When Play Billing arrives it replaces the source of this value, not the
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
 * Writes the cached entitlement.
 *
 * Phase 2 slice 2 calls this from the billing result and from the
 * queryPurchases() re-check. Until then the only caller is the debug-only
 * switch in Settings.
 */
export async function setProUnlocked(unlocked: boolean): Promise<void> {
    await Preferences.set({ key: PRO_KEY, value: unlocked ? 'true' : 'false' });
}

/**
 * Whether Pro can be turned on and off by hand.
 *
 * True only in a debug build. The Settings switch that calls setProUnlocked()
 * is hidden behind this, which is what keeps a release build fail-closed.
 */
export async function canSimulatePro(): Promise<boolean> {
    return isDebugBuild();
}

/**
 * Whether PDF unlocking is available.
 *
 * Pro, and nothing else. It used to be "Pro or a debug build", which meant a
 * debug build could not test the locked side at all; the debug switch above
 * covers that case now without a second rule.
 */
export async function canUnlockPdfs(): Promise<boolean> {
    return isProUnlocked();
}
