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

export type SaveOutcome = 'saved' | 'downloaded' | 'failed';

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
 * Returns 'failed' only when no file could be produced at all. A share sheet
 * that opened counts as a save - see the note in the catch below for why we
 * cannot tell a completed share from a dismissed one on Android.
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

        try {
            await Share.share({ title: dialogTitle, url: uri, dialogTitle });
        } catch (shareError) {
            // Android's chooser returns RESULT_CANCELED for most targets even
            // when the user completed the share, so Capacitor rejects with
            // "Share canceled" on saves that actually succeeded. There is no
            // reliable way to tell the two apart from here.
            //
            // So a sheet that opened counts as a save. Under-counting a real
            // save is the worse error: the user watches the number stay put
            // after saving and concludes the app is broken. Over-counting a
            // dismissal costs nothing, because the metered resource in the
            // Free tier is auto-detect, not saving (CLAUDE.md §5) - when the
            // Phase 2 quota lands it must be charged at detection time, not
            // here.
            console.debug('[saveImage] share sheet closed:', shareError);
        }

        return 'saved';
    } catch (error) {
        console.error('[saveImage] could not write the file, falling back to download:', error);
        try {
            return downloadInBrowser(fileName, base64, mimeType);
        } catch (downloadError) {
            console.error('[saveImage] download fallback failed too:', downloadError);
            return 'failed';
        }
    }
}
