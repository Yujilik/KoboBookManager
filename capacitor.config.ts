import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.yujilik.kobobookmanager',
  appName: 'Kobo Book Manager',
  webDir: 'dist',
  loggingBehavior: 'none',
  // The native Activity supplies the canvas colour from day/night resources.
  plugins: { SystemBars: { style: 'DEFAULT', insetsHandling: 'css', initialViewportFitValueHint: 'cover' } },
};
export default config;
