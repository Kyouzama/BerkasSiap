import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'id.berkassiap.app',
  appName: 'BerkasSiap',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
  plugins: {
    // Konten digambar sampai ke area system bar; ruang aman diatur lewat CSS.
    SystemBars: {
      style: 'DARK',
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
    },
  },
}

export default config
