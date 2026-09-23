/**
 * Keeps the Pro entitlement in step with Play.
 *
 * Per CLAUDE.md §7 the entitlement is checked on launch and on every resume.
 * Resume matters for two reasons: a purchase may have completed in the Play
 * sheet while the app was backgrounded, and a refund granted on the web needs
 * to re-lock the app rather than wait for a reinstall.
 *
 * The cached value is shown immediately so nothing flickers, then the sync
 * corrects it. A sync that could not reach Play leaves the cache alone.
 */
import { useCallback, useEffect, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { isProUnlocked, syncEntitlement } from '@/lib/entitlements';

export interface EntitlementState {
    isPro: boolean;
    /** False until the first read resolves. */
    ready: boolean;
    /** True once Play itself has confirmed the current value this session. */
    verified: boolean;
    /** Re-asks Play. Used by Restore Purchases. */
    refresh: () => Promise<void>;
}

export function useEntitlement(): EntitlementState {
    const [isPro, setIsPro] = useState(false);
    const [ready, setReady] = useState(false);
    const [verified, setVerified] = useState(false);

    const refresh = useCallback(async () => {
        const result = await syncEntitlement();
        setIsPro(result.isPro);
        setVerified(result.verified);
        setReady(true);
    }, []);

    useEffect(() => {
        let cancelled = false;

        // Show the cached answer first: asking Play takes a round trip, and a
        // paying user should not watch their Pro features flicker on launch.
        void isProUnlocked().then(cached => {
            if (cancelled) return;
            setIsPro(cached);
            setReady(true);
        });

        void refresh();

        const listener = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
            if (isActive) void refresh();
        });

        return () => {
            cancelled = true;
            void listener.then(l => l.remove());
        };
    }, [refresh]);

    return { isPro, ready, verified, refresh };
}
