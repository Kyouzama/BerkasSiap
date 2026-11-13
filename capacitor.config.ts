import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'id.berkassiap.app',
  appName: 'BerkasSiap',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
}

export default config
