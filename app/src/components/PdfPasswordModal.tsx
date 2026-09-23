/**
 * Asks for the password to a protected PDF.
 *
 * Retry is in-place rather than a fresh prompt: a wrong password is the
 * expected case, not an error state, and closing the dialog to reopen it loses
 * whatever was typed. The password is held only in this component's state and
 * is never stored, logged or sent anywhere.
 */
import { useEffect, useRef, useState } from 'react';
import { Lock, Eye, EyeOff, AlertTriangle, X } from 'lucide-react';

interface PdfPasswordModalProps {
    open: boolean;
    fileName: string;
    /** Set after a failed attempt so the message sits next to the field. */
    error: string | null;
    busy: boolean;
    onSubmit: (password: string) => void;
    onCancel: () => void;
}

export function PdfPasswordModal({
    open,
    fileName,
    error,
    busy,
    onSubmit,
    onCancel,
}: PdfPasswordModalProps) {
    const [password, setPassword] = useState('');
    const [reveal, setReveal] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    // Clear on open so a previous file's attempt is never carried over.
    useEffect(() => {
        if (open) {
            setPassword('');
            setReveal(false);
            const id = window.setTimeout(() => inputRef.current?.focus(), 60);
            return () => window.clearTimeout(id);
        }
    }, [open]);

    if (!open) return null;

    const submit = () => {
        if (!password || busy) return;
        onSubmit(password);
    };

    return (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-bg-card border border-border-light dark:border-white/10 shadow-xl overflow-hidden">
                <div className="flex items-start gap-3 p-4 border-b border-border-light dark:border-white/10">
                    <div className="w-9 h-9 rounded-xl bg-primary-light dark:bg-primary-blue/15 flex items-center justify-center shrink-0">
                        <Lock className="w-4 h-4 text-primary-blue" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="font-sans text-sm font-semibold text-text-primary dark:text-white">
                            This PDF is password protected
                        </p>
                        <p className="font-sans text-xs text-text-secondary truncate mt-0.5">{fileName}</p>
                    </div>
                    <button
                        type="button"
                        onClick={onCancel}
                        aria-label="Cancel"
                        className="p-1 rounded-lg text-text-muted hover:text-text-primary dark:hover:text-white"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="p-4 space-y-3">
                    <p className="font-sans text-xs text-text-secondary">
                        Enter the password and Seycure will save an unlocked copy. This happens on
                        your device — the file is never uploaded.
                    </p>

                    <div className="relative">
                        <input
                            ref={inputRef}
                            type={reveal ? 'text' : 'password'}
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                            placeholder="PDF password"
                            autoComplete="off"
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck={false}
                            className="w-full pr-10 px-3 py-2.5 rounded-xl bg-bg-light dark:bg-black/30 border border-border-light dark:border-white/10 font-mono text-sm text-text-primary dark:text-white outline-none focus:border-primary-blue"
                        />
                        <button
                            type="button"
                            onClick={() => setReveal(v => !v)}
                            aria-label={reveal ? 'Hide password' : 'Show password'}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-text-muted hover:text-text-primary dark:hover:text-white"
                        >
                            {reveal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                    </div>

                    {error && (
                        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-danger-red/10 border border-danger-red/30">
                            <AlertTriangle className="w-3.5 h-3.5 text-danger-red shrink-0 mt-0.5" />
                            <p className="font-sans text-xs text-danger-red">{error}</p>
                        </div>
                    )}

                    <div className="flex gap-2 pt-1">
                        <button
                            type="button"
                            onClick={onCancel}
                            className="flex-1 py-2.5 rounded-xl border border-border-light dark:border-white/10 font-sans text-sm font-medium text-text-secondary dark:text-white/70"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={submit}
                            disabled={!password || busy}
                            className="flex-1 py-2.5 rounded-xl bg-primary-blue text-white font-sans text-sm font-semibold disabled:opacity-40"
                        >
                            {busy ? 'Unlocking…' : 'Unlock'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
