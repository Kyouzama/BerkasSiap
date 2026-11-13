import { registerPlugin } from '@capacitor/core'

export type SystemBarStyle = 'LIGHT' | 'DARK' | 'DEFAULT'

interface SystemBarsPlugin {
  setStyle(options: {
    bar?: 'StatusBar' | 'NavigationBar'
    style: SystemBarStyle
  }): Promise<void>
}

const SystemBars = registerPlugin<SystemBarsPlugin>('SystemBars')

/**
 * Atur warna ikon system bar agar tetap terbaca.
 * `DARK` berarti ikon terang (untuk header gelap), `LIGHT` berarti ikon gelap.
 * Di browser plugin ini tidak tersedia, jadi kegagalan diabaikan.
 */
export async function setSystemBarStyle(statusBar: SystemBarStyle) {
  try {
    await Promise.all([
      SystemBars.setStyle({ bar: 'StatusBar', style: statusBar }),
      SystemBars.setStyle({ bar: 'NavigationBar', style: 'LIGHT' }),
    ])
  } catch {
    // Bukan aplikasi Android (mis. browser): tidak ada yang perlu diatur.
  }
}
