/**
 * The TypeScript side of Play Billing.
 *
 * This module only talks to the native plugin and shapes its answers. It
 * deliberately holds no state: Play is the source of truth for ownership, and
 * anything cached lives in entitlements.ts, which treats the cache as a
 * convenience for working offline rather than as the answer.
 */
import { registerPlugin, Capacitor } from '@capacitor/core';

/**
 * A stable code for each state the UI has to say something about.
 *
 * The native side maps Play's response codes onto these. Matching on Play's
 * own messages would be wrong - they are localised and they change.
 */
export type BillingCode =
    | 'OK'
    | 'NO_PURCHASE'
    | 'ALREADY_OWNED'
    | 'USER_CANCELLED'
    | 'NETWORK_UNAVAILABLE'
    | 'BILLING_UNAVAILABLE'
    | 'NOT_SUPPORTED'
    | 'ITEM_UNAVAILABLE'
    | 'DEVELOPER_ERROR'
    | 'ERROR'
    /** Not Android at all - the browser build has no Play Store. */
    | 'UNAVAILABLE_ON_PLATFORM';

export interface BillingResult {
    ok: boolean;
    code: BillingCode;
    owned: boolean;
    price?: string | null;
}

interface BillingPlugin {
    queryPurchases(): Promise<BillingResult>;
    getProductDetails(): Promise<BillingResult>;
    purchase(): Promise<BillingResult>;
}

const Billing = registerPlugin<BillingPlugin>('Billing');

const OFF_PLATFORM: BillingResult = {
    ok: false,
    code: 'UNAVAILABLE_ON_PLATFORM',
    owned: false,
};

/** True on Android, where a Play Store exists to talk to. */
export function isBillingSupported(): boolean {
    return Capacitor.isNativePlatform();
}

async function call(
    fn: () => Promise<BillingResult>,
): Promise<BillingResult> {
    if (!isBillingSupported()) return OFF_PLATFORM;
    try {
        return await fn();
    } catch (error) {
        // A plugin-level throw is not a purchase state; it means the bridge or
        // the billing service could not be reached at all.
        console.error('[billing] call failed:', error);
        return { ok: false, code: 'ERROR', owned: false };
    }
}

/**
 * What Play says about ownership right now.
 *
 * The native side acknowledges anything unacknowledged while it is in there,
 * so calling this on launch and on resume is also what keeps the 72-hour
 * acknowledgement window from ever being a problem.
 */
export function queryPurchases(): Promise<BillingResult> {
    return call(() => Billing.queryPurchases());
}

/** The localised price, for the paywall. Absent if Play cannot be reached. */
export function getProductDetails(): Promise<BillingResult> {
    return call(() => Billing.getProductDetails());
}

/** Opens Play's purchase sheet and resolves once it reports back. */
export function purchase(): Promise<BillingResult> {
    return call(() => Billing.purchase());
}

/**
 * What to show the user for a whole result.
 *
 * Prefer this over messageFor(): it reads `ok` as well as the code, so a
 * failure can never render a success line. The native side was able to return
 * { ok: false, code: 'OK' } - Play answers an unknown product id with
 * responseCode OK and an empty list - and a UI keyed on the code alone said
 * "Pro unlocked. Thank you." after a purchase that never happened. That is
 * fixed on the native side too; this is the second lock on the same door,
 * because a false claim of payment is the worst thing this module could say.
 */
export function describe(result: BillingResult): string {
    if (!result.ok && (result.code === 'OK' || result.code === 'ALREADY_OWNED')) {
        return messageFor('ERROR');
    }
    return messageFor(result.code);
}

/**
 * What to show the user for a given outcome code.
 *
 * Every state the requirements call out has a line here, so no path ends in a
 * silent no-op or a raw error code.
 */
export function messageFor(code: BillingCode): string {
    switch (code) {
        case 'OK':
            return 'Pro unlocked. Thank you.';
        case 'ALREADY_OWNED':
            return 'You already own Pro — it has been restored.';
        case 'NO_PURCHASE':
            return 'No previous purchase found on this Google account.';
        case 'USER_CANCELLED':
            return 'Purchase cancelled. Nothing was charged.';
        case 'NETWORK_UNAVAILABLE':
            return 'No connection to Google Play. Check your network and try again.';
        case 'BILLING_UNAVAILABLE':
            return 'Google Play billing is unavailable. Make sure the Play Store is installed, up to date and signed in.';
        case 'NOT_SUPPORTED':
            return 'This device does not support in-app purchases.';
        case 'ITEM_UNAVAILABLE':
            return 'Pro is not available on this account or in this country yet.';
        case 'DEVELOPER_ERROR':
            return 'Purchase could not be started. Please report this.';
        case 'UNAVAILABLE_ON_PLATFORM':
            return 'Purchases are only available in the Android app.';
        default:
            return 'Something went wrong talking to Google Play. Please try again.';
    }
}
