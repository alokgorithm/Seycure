/**
 * Password-protected PDFs, unlocked on the device.
 *
 * The work happens in the PdfUnlock native plugin because pdf-lib - which the
 * rest of the PDF path uses - can open an encrypted document but cannot
 * decrypt one. Nothing is uploaded; this exists precisely so nobody has to
 * paste a bank statement into a website to take a password off it.
 *
 * The user supplies the password. There is no guessing and no brute force.
 */
import { registerPlugin, Capacitor } from '@capacitor/core';

export type PdfUnlockErrorCode = 'WRONG_PASSWORD' | 'TOO_LARGE' | 'UNSUPPORTED' | 'FAILED';

interface PdfUnlockPlugin {
    isEncrypted(options: { base64: string }): Promise<{ encrypted: boolean }>;
    unlock(options: { base64: string; password: string }): Promise<{ base64: string }>;
}

const PdfUnlock = registerPlugin<PdfUnlockPlugin>('PdfUnlock');

/** Thrown with a code the UI can act on, rather than a string it has to match. */
export class PdfUnlockError extends Error {
    code: PdfUnlockErrorCode;
    constructor(code: PdfUnlockErrorCode, message: string) {
        super(message);
        this.name = 'PdfUnlockError';
        this.code = code;
    }
}

/** Reads the `code` a rejected PluginCall carries, falling back to FAILED. */
function codeFrom(err: unknown): PdfUnlockErrorCode {
    const raw = (err as { code?: string })?.code;
    if (raw === 'WRONG_PASSWORD' || raw === 'TOO_LARGE') return raw;
    return 'FAILED';
}

/**
 * Whether this PDF needs a password. Answers false off-device so the web build
 * keeps working; there is no native plugin there to ask.
 */
export async function isPdfEncrypted(base64: string): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) return false;
    try {
        const { encrypted } = await PdfUnlock.isEncrypted({ base64 });
        return Boolean(encrypted);
    } catch {
        // If we cannot tell, treat it as not encrypted and let the normal path
        // report whatever goes wrong. Claiming a password is needed when it is
        // not would block a file that would otherwise scrub fine.
        return false;
    }
}

/**
 * Returns a decrypted, metadata-stripped copy as base64.
 * Throws PdfUnlockError('WRONG_PASSWORD') when the password does not open it.
 */
export async function unlockPdf(base64: string, password: string): Promise<string> {
    if (!Capacitor.isNativePlatform()) {
        throw new PdfUnlockError('UNSUPPORTED', 'Unlocking a PDF needs the Android app.');
    }
    try {
        const { base64: unlocked } = await PdfUnlock.unlock({ base64, password });
        return unlocked;
    } catch (err) {
        const code = codeFrom(err);
        const message =
            code === 'WRONG_PASSWORD' ? 'That password did not open the PDF.'
            : code === 'TOO_LARGE' ? 'This PDF is too large to unlock on the device.'
            : 'Could not unlock this PDF.';
        throw new PdfUnlockError(code, message);
    }
}
