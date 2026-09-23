/**
 * The free tier's daily auto-detect allowance.
 *
 * Per CLAUDE.md §5 the metered resource is auto-detection and nothing else:
 * manual blur is unlimited on free, because a user who is dragging their own
 * rectangles is doing the work themselves and charging them for it would be
 * mean and would not sell anything. Metadata stripping and Link Shield are
 * not metered here either.
 *
 * The count is per local device day with no server involved, which is a
 * deliberate trade: someone who moves their clock gets more free detections,
 * and that is cheaper than running an account system for a utility that
 * promises nothing leaves the device.
 */
import { useCallback, useEffect, useState } from 'react';
import { Preferences } from '@capacitor/preferences';
import { isProUnlocked } from '@/lib/entitlements';

/** Free auto-detections per day. Pro is unlimited. */
export const FREE_DAILY_AUTO_DETECTS = 3;

const STORAGE_KEY = 'seycure_auto_detect_quota';

interface QuotaRecord {
    /** Local calendar day, YYYY-MM-DD. */
    date: string;
    count: number;
}

/**
 * Today as the device reckons it.
 *
 * Deliberately not toISOString(): that is UTC, so anyone east or west of it
 * would get their day rolling over at the wrong hour - in India the reset
 * would land at 05:30 local.
 */
function localDateKey(d: Date = new Date()): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function isQuotaRecord(value: unknown): value is QuotaRecord {
    if (!value || typeof value !== 'object') return false;
    const r = value as Partial<QuotaRecord>;
    return typeof r.date === 'string' && typeof r.count === 'number'
        && Number.isFinite(r.count) && r.count >= 0;
}

/**
 * Reads today's tally.
 *
 * The stored day is compared for inequality, not for being older than today.
 * That is the whole of the clock-change handling: a stored date in the future
 * - the user moved the clock forward and back, or crossed a timezone - is as
 * much "not today" as one in the past, so it resets rather than sitting there
 * ahead of the current date locking the user out until it catches up. An
 * ordering test is what would cause that, so there is none.
 */
async function readToday(): Promise<QuotaRecord> {
    const today = localDateKey();
    try {
        const { value } = await Preferences.get({ key: STORAGE_KEY });
        if (!value) return { date: today, count: 0 };

        const parsed: unknown = JSON.parse(value);
        if (!isQuotaRecord(parsed)) return { date: today, count: 0 };

        return parsed.date === today ? parsed : { date: today, count: 0 };
    } catch {
        // Unreadable or corrupt storage starts the day fresh. Erring towards
        // giving a free detection away is the right way round: the opposite
        // locks someone out of the app's main feature over a storage glitch.
        return { date: today, count: 0 };
    }
}

async function writeToday(record: QuotaRecord): Promise<void> {
    try {
        await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(record) });
    } catch {
        // A failed write means the detection was not counted. That favours
        // the user, and is not worth interrupting them over.
    }
}

export interface QuotaState {
    /** False until the first read resolves; gates are held open meanwhile. */
    ready: boolean;
    isPro: boolean;
    limit: number;
    used: number;
    remaining: number;
    /** True when an auto-detection may run right now. */
    canAutoDetect: boolean;
    /**
     * Charges one auto-detection. Returns false when the free allowance is
     * spent, which is the caller's signal to show the paywall instead of
     * scanning. Pro is never charged.
     */
    consume: () => Promise<boolean>;
    refresh: () => Promise<void>;
}

export function useQuota(): QuotaState {
    const [ready, setReady] = useState(false);
    const [isPro, setIsPro] = useState(false);
    const [used, setUsed] = useState(0);

    const refresh = useCallback(async () => {
        const [pro, record] = await Promise.all([isProUnlocked(), readToday()]);
        setIsPro(pro);
        setUsed(record.count);
        setReady(true);
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const consume = useCallback(async () => {
        // Re-read rather than trusting state: the entitlement may have been
        // granted, and the day may have turned over, since the last render.
        const pro = await isProUnlocked();
        setIsPro(pro);
        if (pro) return true;

        const record = await readToday();
        if (record.count >= FREE_DAILY_AUTO_DETECTS) {
            setUsed(record.count);
            return false;
        }

        const next = { date: record.date, count: record.count + 1 };
        setUsed(next.count);
        await writeToday(next);
        return true;
    }, []);

    const remaining = isPro
        ? Number.POSITIVE_INFINITY
        : Math.max(0, FREE_DAILY_AUTO_DETECTS - used);

    return {
        ready,
        isPro,
        limit: FREE_DAILY_AUTO_DETECTS,
        used,
        remaining,
        // Before the first read resolves the gate stays open: a brief wrong
        // "no" on launch would block the app's main action.
        canAutoDetect: !ready || isPro || remaining > 0,
        consume,
        refresh,
    };
}
