/**
 * The paywall.
 *
 * Per CLAUDE.md §8 it fires only when a free user has spent the day's
 * auto-detections or reaches for a Pro feature - never on launch, and never
 * before the user has had something work. Someone who has not yet seen the
 * app find anything has no reason to pay for more of it.
 *
 * There is no purchase button yet: Play Billing is slice 2. Until it lands
 * this explains the limit and gets out of the way, rather than showing a
 * button that cannot charge anyone.
 */
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { X, Sparkles, Check } from 'lucide-react';

export type PaywallReason = 'quota' | 'pro-feature';

interface PaywallModalProps {
    open: boolean;
    reason: PaywallReason;
    limit: number;
    /** What the user reached for, when it was a Pro feature. */
    featureName?: string;
    onClose: () => void;
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
}: PaywallModalProps) {
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

                <button
                    onClick={onClose}
                    className="mt-5 w-full py-3 rounded-xl bg-primary-blue text-white font-sans text-sm font-semibold hover:opacity-90 transition-opacity"
                >
                    Got it
                </button>
            </DialogContent>
        </Dialog>
    );
}
