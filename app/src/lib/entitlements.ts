/**
 * Whether the user has the Pro unlock.
 *
 * isProUnlocked() keeps the shape it has always had: an async boolean, and the
 * only thing callers should use. Play Billing replaced where the value comes
 * from, not what it looks like.
 *
 * Play is the source of truth. The value is cached in Preferences so the app
 * works offline - a user on a plane who paid last week is still Pro - but the
 * cache is a convenience and never the answer on its own. syncEntitlement()
 * asks Play and rewrites the cache, and it runs on launch and on every resume,
 * which is what makes a refund re-lock rather than lingering until reinstall.
 *
 * A network failure deliberately leaves the cache alone. Play not being
 * reachable says nothing about ownership, and wiping Pro from someone who paid
 * because their train went into a tunnel would be the worse error.
 *
 * In a debug build the cache can be written by hand from Settings, so both
 * sides can be exercised without a purchase. That gate is on the *writer*:
 * a release build has no way to set the key except through Play, so there is
 * no flag, query parameter or stored value that opens Pro there.
 */
import { Preferences } from '@capacitor/preferences';
import { isDebugBuild } from '@/hooks/usePdfUnlock';
import { queryPurchases, isBillingSupported, type BillingCode } from '@/lib/billing';

const PRO_KEY = 'seycure_pro_unlocked';

/** The cached answer. Fast, offline, and possibly stale. */
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
 * Called from syncEntitlement() with what Play reported, and from the
 * debug-only switch in Settings. Nothing else should call it.
 */
export async function setProUnlocked(unlocked: boolean): Promise<void> {
    await Preferences.set({ key: PRO_KEY, value: unlocked ? 'true' : 'false' });
}

export interface EntitlementSync {
    /** The entitlement in force after the sync - cached value if Play was unreachable. */
    isPro: boolean;
    /** Whether Play actually answered. False means isPro came from the cache. */
    verified: boolean;
    code: BillingCode;
}

/**
 * Asks Play who owns what, and updates the cache.
 *
 * Call on launch and on resume. The native side acknowledges any
 * unacknowledged purchase while it is in there, so this is also what closes
 * the 72-hour acknowledgement window for a purchase completed while the app
 * was shut.
 */
export async function syncEntitlement(): Promise<EntitlementSync> {
    const cached = await isProUnlocked();

    if (!isBillingSupported()) {
        return { isPro: cached, verified: false, code: 'UNAVAILABLE_ON_PLATFORM' };
    }

    const result = await queryPurchases();

    if (!result.ok) {
        // Play could not be asked. Keep whatever the cache says: an unreachable
        // billing service is not evidence of anything either way.
        return { isPro: cached, verified: false, code: result.code };
    }

    // Play answered, so its answer wins in both directions - including down,
    // which is how a refund re-locks.
    if (result.owned !== cached) {
        await setProUnlocked(result.owned);
    }

    return { isPro: result.owned, verified: true, code: result.code };
}

/**
 * Whether Pro can be turned on and off by hand.
 *
 * True only in a debug build. The Settings switch that calls setProUnlocked()
 * is hidden behind this, which is what keeps a release build fail-closed.
 *
 * Note that a debug override only survives until the next sync: Play will be
 * asked on the next resume and will say the product is not owned. That is the
 * correct behaviour - it is the same path a refund takes - and it is worth
 * knowing when testing, because the switch is not sticky on a device that can
 * reach Play.
 */
export async function canSimulatePro(): Promise<boolean> {
    return isDebugBuild();
}

/**
 * Whether PDF unlocking is available.
 *
 * Pro, and nothing else.
 */
export async function canUnlockPdfs(): Promise<boolean> {
    return isProUnlocked();
}
