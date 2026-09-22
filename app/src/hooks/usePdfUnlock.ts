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

/** Document info fields that were present before the unlock cleared them. */
export interface PdfStrippedInfo {
    title?: string;
    author?: string;
    subject?: string;
    creator?: string;
    producer?: string;
    keywords?: string;
}

export interface PdfUnlockResult {
    base64: string;
    /** What was removed, so the UI can list it as the normal path does. */
    strippedInfo: PdfStrippedInfo;
}

interface PdfUnlockPlugin {
    isDebugBuild(): Promise<{ debug: boolean }>;
    isEncrypted(options: { base64: string }): Promise<{ encrypted: boolean }>;
    unlock(options: { base64: string; password: string }): Promise<{
        base64: string;
        strippedInfo?: PdfStrippedInfo;
    }>;
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
 * Returns a decrypted, metadata-stripped copy, plus whatever document
 * information was cleared on the way.
 * Throws PdfUnlockError('WRONG_PASSWORD') when the password does not open it.
 */
export async function unlockPdf(base64: string, password: string): Promise<PdfUnlockResult> {
    if (!Capacitor.isNativePlatform()) {
        throw new PdfUnlockError('UNSUPPORTED', 'Unlocking a PDF needs the Android app.');
    }
    try {
        const res = await PdfUnlock.unlock({ base64, password });
        return { base64: res.base64, strippedInfo: res.strippedInfo ?? {} };
    } catch (err) {
        const code = codeFrom(err);
        const message =
            code === 'WRONG_PASSWORD' ? 'That password did not open the PDF.'
            : code === 'TOO_LARGE' ? 'This PDF is too large to unlock on the device.'
            : 'Could not unlock this PDF.';
        throw new PdfUnlockError(code, message);
    }
}

/**
 * Whether this build is a debug build, straight from BuildConfig.DEBUG.
 *
 * Deliberately not `import.meta.env.DEV`: the web bundle is compiled in
 * production mode even when it is packaged into a debug APK, so that flag
 * reads false on the very device this is meant to enable. Anything that
 * cannot reach the plugin is treated as a release build.
 */
export async function isDebugBuild(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) return false;
    try {
        const { debug } = await PdfUnlock.isDebugBuild();
        return Boolean(debug);
    } catch {
        return false;
    }
}
