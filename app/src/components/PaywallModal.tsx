/**
 * The paywall.
 *
 * Per CLAUDE.md §8 it fires only when a free user has spent the day's
 * auto-detections or reaches for a Pro feature - never on launch, and never
 * before the user has had something work. Someone who has not yet seen the
 * app find anything has no reason to pay for more of it.
 *
 * The price comes from Play rather than being written in, so it is the user's
 * currency and whatever Play Console actually says. When Play cannot be
 * reached the button still works - the purchase flow reports its own failure,
 * with a message per state - but it does not claim a price it could not read.
 */
import { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { X, Sparkles, Check, Loader2 } from 'lucide-react';
import {
    getProductDetails,
    purchase as startPurchase,
    describe,
    isBillingSupported,
} from '@/lib/billing';

export type PaywallReason = 'quota' | 'pro-feature';

interface PaywallModalProps {
    open: boolean;
    reason: PaywallReason;
    limit: number;
    /** What the user reached for, when it was a Pro feature. */
    featureName?: string;
    onClose: () => void;
    /** Called after a purchase succeeds, so the app can re-check with Play. */
    onPurchased?: () => void;
}

const PRO_FEATURES = [
    'Unlimited auto-detection',
    'Batch processing',
    'The full pattern set',
    'Learned rules',
    'PDF and DOCX scrubbing',
];

export function PaywallModal({
    open,
    reason,
    limit,
    featureName,
    onClose,
    onPurchased,
}: PaywallModalProps) {
    const [price, setPrice] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    // Ask for the price when the sheet opens rather than on mount: no point
    // talking to Play for a dialog the user may never see.
    useEffect(() => {
        if (!open || !isBillingSupported()) return;
        setMessage(null);
        void getProductDetails().then(result => {
            if (result.ok && result.price) setPrice(result.price);
        });
    }, [open]);

    const buy = async () => {
        setBusy(true);
        setMessage(null);
        const result = await startPurchase();
        setBusy(false);
        setMessage(describe(result));
        if (result.ok && result.owned) onPurchased?.();
    };
    const title = reason === 'quota'
        ? "That's today's free auto-detects"
        : `${featureName ?? 'That feature'} is part of Pro`;

    const body = reason === 'quota'
        ? `Free covers ${limit} automatic scans a day. Manual blur is unlimited — you can still pick out anything on this screenshot yourself, and come back tomorrow for ${limit} more.`
        : 'Manual blur and the daily auto-detects stay free.';

    return (
        <Dialog open={open} onOpenChange={onClose}>
            <DialogContent className="max-w-sm bg-bg-card text-text-primary border border-border-light dark:border-white/10 rounded-3xl p-6 shadow-2xl">
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-xl bg-primary-blue/10 text-primary-blue flex items-center justify-center shrink-0">
                            <Sparkles className="w-5 h-5" />
                        </div>
                        <h3 className="font-sans text-base font-bold leading-tight">{title}</h3>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg text-text-secondary hover:text-text-primary shrink-0"
                        aria-label="Close"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <p className="mt-3 font-sans text-sm text-text-secondary leading-relaxed">
                    {body}
                </p>

                <ul className="mt-4 space-y-2">
                    {PRO_FEATURES.map(feature => (
                        <li key={feature} className="flex items-center gap-2.5">
                            <Check className="w-4 h-4 text-success-green shrink-0" />
                            <span className="font-sans text-sm text-text-primary">{feature}</span>
                        </li>
                    ))}
                </ul>

                <p className="mt-4 font-sans text-xs text-text-muted">
                    Pro is a one-time unlock. No subscription.
                </p>

                {message && (
                    <p className="mt-3 font-sans text-xs text-text-secondary">{message}</p>
                )}

                <button
                    onClick={() => void buy()}
                    disabled={busy || !isBillingSupported()}
                    className="mt-4 w-full py-3 rounded-xl bg-primary-blue text-white font-sans text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-60 flex items-center justify-center gap-2"
                >
                    {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                    {busy
                        ? 'Talking to Google Play…'
                        : price
                            ? `Unlock Pro — ${price}`
                            : 'Unlock Pro'}
                </button>

                <button
                    onClick={onClose}
                    className="mt-2 w-full py-2.5 rounded-xl font-sans text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
                >
                    Not now
                </button>
            </DialogContent>
        </Dialog>
    );
}
