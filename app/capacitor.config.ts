import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.arkqube.seycure',
  appName: 'Seycure',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  },
  plugins: {
    Share: {
      // Share plugin configuration
    },
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 500,
      backgroundColor: '#FFFFFF',
      androidScaleType: 'CENTER_CROP',
      // splashFullScreen and splashImmersive used to be true here. Immersive
      // mode hides the status bar, and on Android the flag outlives the splash,
      // so the clock, battery and signal stayed gone for the whole session.
      splashFullScreen: false,
      splashImmersive: false,
    }
  }
};

export default config;
