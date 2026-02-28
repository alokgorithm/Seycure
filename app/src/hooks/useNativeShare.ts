import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';

export interface ShareOption {
  id: string;
  name: string;
  icon: string;
  packageName?: string;
  urlScheme?: string;
}

export const SHARE_OPTIONS: ShareOption[] = [
  { id: 'instagram-story', name: 'Instagram Story', icon: 'instagram', packageName: 'com.instagram.android', urlScheme: 'instagram-stories://share' },
  { id: 'instagram-post', name: 'Instagram Post', icon: 'instagram', packageName: 'com.instagram.android' },
  { id: 'whatsapp', name: 'WhatsApp', icon: 'whatsapp', packageName: 'com.whatsapp' },
  { id: 'telegram', name: 'Telegram', icon: 'telegram', packageName: 'org.telegram.messenger' },
  { id: 'chatgpt', name: 'ChatGPT', icon: 'openai', packageName: 'com.openai.chatgpt' },
  { id: 'claude', name: 'Claude', icon: 'anthropic', packageName: 'com.anthropic.claude' },
  { id: 'gemini', name: 'Gemini', icon: 'google', packageName: 'com.google.android.apps.bard' },
  { id: 'more', name: 'More Options', icon: 'share' },
];

export function useNativeShare() {
  const shareFile = async (
    _fileName: string,
    base64Data: string,
    mimeType: string,
    dialogTitle: string = 'Share scrubbed media'
  ) => {
    try {
      // Write file to temporary directory
      const extension = mimeType.split('/')[1] || 'jpg';
      const tempFileName = `scrubbed_${Date.now()}.${extension}`;

      await Filesystem.writeFile({
        path: tempFileName,
        data: base64Data,
        directory: Directory.Cache,
        recursive: true,
      });

      // Get the file URI
      const fileUri = await Filesystem.getUri({
        path: tempFileName,
        directory: Directory.Cache,
      });

      // Share the file
      await Share.share({
        title: 'Share Scrubbed Media',
        text: 'Scrubbed media - metadata removed by Seycure',
        url: fileUri.uri,
        dialogTitle: dialogTitle,
      });

      return { success: true };
    } catch (error) {
      console.error('Share error:', error);
      return { success: false, error };
    }
  };

  const shareToSpecificApp = async (
    _fileName: string,
    base64Data: string,
    mimeType: string,
    targetApp: ShareOption
  ) => {
    try {
      const extension = mimeType.split('/')[1] || 'jpg';
      const tempFileName = `scrubbed_${Date.now()}.${extension}`;

      await Filesystem.writeFile({
        path: tempFileName,
        data: base64Data,
        directory: Directory.Cache,
        recursive: true,
      });

      const fileUri = await Filesystem.getUri({
        path: tempFileName,
        directory: Directory.Cache,
      });

      // For specific apps, use the URL scheme if available
      if (targetApp.urlScheme) {
        // Try to open with URL scheme for Instagram Stories
        if (targetApp.id === 'instagram-story') {
          try {
            await Share.share({
              title: 'Share to Instagram Story',
              url: fileUri.uri,
            });
            return { success: true };
          } catch {
            // Fallback to generic share
          }
        }
      }

      // Generic share with specific package hint
      await Share.share({
        title: `Share to ${targetApp.name}`,
        text: 'Scrubbed media - metadata removed by Seycure',
        url: fileUri.uri,
        dialogTitle: `Share to ${targetApp.name}`,
      });

      return { success: true };
    } catch (error) {
      console.error('Share error:', error);
      return { success: false, error };
    }
  };

  const canShare = async (): Promise<boolean> => {
    try {
      const result = await Share.canShare();
      return result.value;
    } catch {
      return false;
    }
  };

  return {
    shareFile,
    shareToSpecificApp,
    canShare,
    SHARE_OPTIONS,
  };
}
