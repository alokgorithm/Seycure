/**
 * Saving an image without any storage permission.
 *
 * Google's Photo & Video Permissions policy bars READ_MEDIA_IMAGES for an app
 * like this one, and WRITE_EXTERNAL_STORAGE has been a no-op on scoped storage
 * since Android 10 anyway. Writing into Directory.ExternalStorage, which is
 * what the app used to do, needed both and silently failed on modern devices.
 *
 * So: write the file into the app's own cache, which needs no permission and
 * is what FileProvider is already configured to expose, then hand the URI to
 * the system share sheet. The user picks the destination themselves - Files,
 * Drive, Photos, another app - and that choice is the grant. On the web there
 * is no share sheet, so fall back to an anchor download.
 */
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled';

/** Strips a `data:` URL prefix if one is present. Filesystem wants raw base64. */
function toRawBase64(data: string): string {
    return data.includes(',') ? data.split(',')[1] : data;
}

function downloadInBrowser(fileName: string, base64: string, mimeType: string): SaveOutcome {
    const link = document.createElement('a');
    link.href = `data:${mimeType};base64,${toRawBase64(base64)}`;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return 'downloaded';
}

/**
 * Writes the image to app-private cache and opens the share sheet so the user
 * can put it wherever they like. Never requests a permission.
 *
 * Returns 'cancelled' when the user dismisses the sheet, which is a normal
 * outcome and not an error - callers should not count it as a save.
 */
export async function saveImage(
    fileName: string,
    base64: string,
    mimeType: string = 'image/png',
    dialogTitle: string = 'Save image'
): Promise<SaveOutcome> {
    if (!Capacitor.isNativePlatform()) {
        return downloadInBrowser(fileName, base64, mimeType);
    }

    try {
        await Filesystem.writeFile({
            path: fileName,
            data: toRawBase64(base64),
            directory: Directory.Cache,
            recursive: true,
        });

        const { uri } = await Filesystem.getUri({
            path: fileName,
            directory: Directory.Cache,
        });

        await Share.share({ title: dialogTitle, url: uri, dialogTitle });
        return 'shared';
    } catch (error) {
        // The Share plugin rejects when the user dismisses the sheet. That is a
        // deliberate choice, not a failure, so report it as such.
        if (isShareDismissal(error)) return 'cancelled';

        console.error('[saveImage] native save failed, falling back to download:', error);
        return downloadInBrowser(fileName, base64, mimeType);
    }
}

function isShareDismissal(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /cancel/i.test(message) || /abort/i.test(message);
}
