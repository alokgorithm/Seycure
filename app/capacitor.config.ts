import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.arkqube.clrlink',
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
      launchShowDuration: 2000,
      backgroundColor: '#FFFFFF',
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: true,
    }
  }
};

export default config;
