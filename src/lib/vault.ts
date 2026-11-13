import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * Vault BerkasSiap.
 *
 * Vault adalah folder pilihan pengguna di perangkat (lewat pemilih folder
 * Android). Semua berkas baru disimpan di dalamnya. Yang disimpan di
 * localStorage hanya URI folder + namanya; isi berkas tetap di perangkat.
 */

export type Vault = {
  /** URI SAF untuk folder vault. */
  uri: string
  /** Nama folder yang ditampilkan ke pengguna. */
  name: string
}

export type VaultSavedFile = {
  /** URI dokumen SAF. */
  uri: string
  /** Nama berkas final (mungkin mendapat akhiran -2, -3, ...). */
  name: string
}

type VaultPlugin = {
  pickFolder(): Promise<{ uri: string; name: string }>
  saveFile(options: {
    treeUri: string
    folder?: string
    name: string
    mimeType?: string
    data: string
  }): Promise<VaultSavedFile>
  readFile(options: { uri: string }): Promise<{ data: string }>
  exists(options: { uri: string }): Promise<{ exists: boolean }>
  deleteFile(options: { uri: string }): Promise<void>
  openFile(options: { uri: string; mimeType?: string }): Promise<void>
}

export const VaultNative = registerPlugin<VaultPlugin>('Vault')

const VAULT_KEY = 'berkassiap-vault'
const PROMPT_KEY = 'berkassiap-vault-prompted'

/** Vault hanya tersedia di aplikasi Android (butuh pemilih folder SAF). */
export function canUseVault() {
  return Capacitor.isNativePlatform()
}

export function readVault(): Vault | null {
  try {
    const stored = localStorage.getItem(VAULT_KEY)
    if (!stored) return null
    const parsed = JSON.parse(stored) as Partial<Vault>
    if (!parsed?.uri || !parsed.name) return null
    return { uri: parsed.uri, name: parsed.name }
  } catch {
    return null
  }
}

export function writeVault(vault: Vault | null) {
  try {
    if (vault) localStorage.setItem(VAULT_KEY, JSON.stringify(vault))
    else localStorage.removeItem(VAULT_KEY)
  } catch {
    // localStorage penuh/diblokir: aplikasi tetap berjalan dengan folder bawaan.
  }
}

export function wasVaultPrompted() {
  try {
    return localStorage.getItem(PROMPT_KEY) === '1'
  } catch {
    return true
  }
}

export function markVaultPrompted() {
  try {
    localStorage.setItem(PROMPT_KEY, '1')
  } catch {
    // Diabaikan.
  }
}

/** Buka pemilih folder Android. Mengembalikan null jika dibatalkan. */
export async function pickVaultFolder(): Promise<Vault | null> {
  if (!canUseVault()) return null
  const picked = await VaultNative.pickFolder()
  if (!picked?.uri) return null
  return { uri: picked.uri, name: picked.name || 'Vault' }
}
