import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { readVault, VaultNative } from './vault'

/**
 * Penyimpanan berkas BerkasSiap.
 *
 * - Di aplikasi Android (Capacitor) dengan vault: berkas ditulis ke folder
 *   pilihan pengguna lewat Storage Access Framework.
 * - Tanpa vault: berkas ditulis ke folder publik
 *   Documents/BerkasSiap/<nama-checklist>/<nama-file>.
 * - Di browser biasa: berkas disimpan di IndexedDB seperti sebelumnya.
 *
 * Data checklist (localStorage) hanya menyimpan jalur/URI + metadata berkas,
 * bukan isi berkasnya.
 */

export const FILES_FOLDER = 'BerkasSiap'

export type PhoneFile = {
  /** Jalur relatif, contoh: BerkasSiap/KTP/ktp.pdf atau vault:KTP/ktp.pdf */
  path: string
  /** Lokasi native yang dipakai saat menyimpan. */
  storage: 'documents' | 'external' | 'vault'
  /** URI dokumen SAF, hanya untuk berkas di vault. */
  uri?: string
  /** Nama vault saat berkas disimpan (untuk ditampilkan). */
  vault?: string
  name: string
  size: number
  type: string
  savedAt: string
}

export function isNativeApp() {
  return Capacitor.isNativePlatform()
}

function nativeDirectories(storage: PhoneFile['storage'] = 'documents') {
  return storage === 'external'
    ? [Directory.ExternalStorage, Directory.Documents]
    : [Directory.Documents, Directory.ExternalStorage]
}

function sanitizeSegment(value: string, fallback: string) {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
  return cleaned.slice(0, 60) || fallback
}

function sanitizeFileName(value: string) {
  const dot = value.lastIndexOf('.')
  const rawBase = dot > 0 ? value.slice(0, dot) : value
  const rawExtension = dot > 0 ? value.slice(dot + 1) : ''
  const base = sanitizeSegment(rawBase, 'berkas').slice(0, 48) || 'berkas'
  const extension = rawExtension.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase()
  return extension ? `${base}.${extension}` : base
}

function guessMimeType(name: string) {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  const types: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
    json: 'application/json',
  }
  return types[extension] ?? 'application/octet-stream'
}

function base64ToBlob(data: string, type: string) {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type })
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function existsAt(path: string, directory: Directory) {
  try {
    await Filesystem.stat({ path, directory })
    return true
  } catch {
    return false
  }
}

async function findDirectory(path: string, storage: PhoneFile['storage']) {
  if (storage === 'vault') return null
  for (const directory of nativeDirectories(storage)) {
    if (await existsAt(path, directory)) return directory
  }
  return null
}

async function requestNativePermission() {
  try {
    const status = await Filesystem.checkPermissions()
    if (status.publicStorage === 'granted') return true
    const requested = await Filesystem.requestPermissions()
    return requested.publicStorage === 'granted'
  } catch {
    // Perangkat/versi Android yang tidak membutuhkan izin tetap boleh lanjut.
    return true
  }
}

/** Minta penyimpanan persisten di browser agar data tidak mudah dibersihkan. */
export async function requestPersistentStorage() {
  if (isNativeApp()) return false
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist()
  } catch {
    // Diabaikan: penyimpanan tetap berjalan meski permintaan ditolak.
  }
  return false
}

/* ------------------------------------------------------------------ */
/* Fallback browser: IndexedDB (perilaku lama)                         */
/* ------------------------------------------------------------------ */

function openFileDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('berkassiap-files', 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('files')) {
        request.result.createObjectStore('files')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function saveBrowserFile(key: string, file: File) {
  const db = await openFileDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('files', 'readwrite')
    transaction.objectStore('files').put(file, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}

async function getBrowserFile(key: string) {
  const db = await openFileDatabase()
  const file = await new Promise<File | undefined>((resolve, reject) => {
    const request = db.transaction('files').objectStore('files').get(key)
    request.onsuccess = () => resolve(request.result as File | undefined)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return file
}

async function deleteBrowserFile(key: string) {
  const db = await openFileDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('files', 'readwrite')
    transaction.objectStore('files').delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}

/* ------------------------------------------------------------------ */
/* API utama                                                           */
/* ------------------------------------------------------------------ */

/**
 * Simpan berkas ke vault pengguna. Jika vault belum dipilih (atau tidak bisa
 * diakses), berkas disimpan ke Documents/BerkasSiap/<nama-checklist>/.
 * Di browser biasa, berkas disimpan ke IndexedDB.
 */
export async function saveToPhone(
  planTitle: string,
  key: string,
  file: File,
): Promise<PhoneFile> {
  if (!isNativeApp()) {
    await saveBrowserFile(key, file)
    return {
      path: `indexeddb:${key}`,
      storage: 'documents',
      name: file.name,
      size: file.size,
      type: file.type || guessMimeType(file.name),
      savedAt: new Date().toISOString(),
    }
  }

  const vault = readVault()
  if (vault) {
    const folder = sanitizeSegment(planTitle, 'Checklist')
    const fileName = sanitizeFileName(file.name)
    const type = file.type || guessMimeType(fileName)
    try {
      const saved = await VaultNative.saveFile({
        treeUri: vault.uri,
        folder,
        name: fileName,
        mimeType: type,
        data: await blobToBase64(file),
      })
      return {
        path: `vault:${folder}/${saved.name}`,
        storage: 'vault',
        uri: saved.uri,
        vault: vault.name,
        name: saved.name,
        size: file.size,
        type,
        savedAt: new Date().toISOString(),
      }
    } catch {
      // Vault tidak bisa diakses (izin dicabut/folder dipindah). Simpan ke
      // folder bawaan agar berkas pengguna tidak hilang.
    }
  }

  await requestNativePermission()
  const data = await blobToBase64(file)
  const folder = `${FILES_FOLDER}/${sanitizeSegment(planTitle, 'Checklist')}`
  const fileName = sanitizeFileName(file.name)
  const dot = fileName.lastIndexOf('.')
  const baseName = dot > 0 ? fileName.slice(0, dot) : fileName
  const extension = dot > 0 ? fileName.slice(dot) : ''

  for (const storage of ['documents', 'external'] as const) {
    const directory = nativeDirectories(storage)[0]
    try {
      let path = `${folder}/${fileName}`
      let counter = 2
      while (await existsAt(path, directory)) {
        path = `${folder}/${baseName}-${counter}${extension}`
        counter += 1
      }
      await Filesystem.writeFile({ path, data, directory, recursive: true })
      return {
        path,
        storage,
        name: fileName,
        size: file.size,
        type: file.type || guessMimeType(fileName),
        savedAt: new Date().toISOString(),
      }
    } catch {
      // Coba folder berikutnya (mis. perangkat membatasi folder Documents).
    }
  }

  throw new Error('Tidak dapat menulis ke folder Documents')
}

/** Baca isi berkas dari perangkat. Mengembalikan null jika berkas sudah hilang. */
export async function readFromPhone(file: PhoneFile | undefined, key: string) {
  if (!isNativeApp()) return (await getBrowserFile(key)) ?? null
  if (!file || !file.path || file.path.startsWith('indexeddb:')) {
    return (await getBrowserFile(key)) ?? null
  }

  if (file.storage === 'vault' && file.uri) {
    try {
      const result = await VaultNative.readFile({ uri: file.uri })
      return base64ToBlob(result.data, file.type || guessMimeType(file.name))
    } catch {
      return null
    }
  }

  const directory = await findDirectory(file.path, file.storage)
  if (!directory) return null

  try {
    const result = await Filesystem.readFile({ path: file.path, directory })
    if (result.data instanceof Blob) return result.data
    return base64ToBlob(String(result.data), file.type || guessMimeType(file.name))
  } catch {
    return null
  }
}

/** Hapus berkas dari perangkat (atau dari IndexedDB di browser). */
export async function deleteFromPhone(file: PhoneFile | undefined, key: string) {
  if (!isNativeApp()) {
    await deleteBrowserFile(key)
    return
  }

  if (!file || !file.path || file.path.startsWith('indexeddb:')) {
    await deleteBrowserFile(key)
    return
  }

  if (file.storage === 'vault' && file.uri) {
    try {
      await VaultNative.deleteFile({ uri: file.uri })
    } catch {
      // Berkas memang sudah tidak ada.
    }
    return
  }

  const directory = await findDirectory(file.path, file.storage)
  if (!directory) return
  try {
    await Filesystem.deleteFile({ path: file.path, directory })
  } catch {
    // Berkas memang sudah tidak ada.
  }
}

/** Cek apakah berkas masih ada di perangkat. */
export async function existsOnPhone(file: PhoneFile | undefined, key: string) {
  if (!isNativeApp()) return Boolean(await getBrowserFile(key))
  if (!file || !file.path || file.path.startsWith('indexeddb:')) {
    return Boolean(await getBrowserFile(key))
  }

  if (file.storage === 'vault' && file.uri) {
    try {
      return (await VaultNative.exists({ uri: file.uri })).exists
    } catch {
      return false
    }
  }

  return Boolean(await findDirectory(file.path, file.storage))
}

/**
 * Buka berkas yang tersimpan.
 *
 * Di Android berkas dibuka lewat ACTION_VIEW (aplikasi penampil bawaan),
 * sehingga BerkasSiap tetap di latar belakang dan tombol kembali tidak
 * mengembalikan pengguna ke Beranda. Di browser berkas diunduh seperti
 * sebelumnya.
 */
export async function openFromPhone(
  file: PhoneFile | undefined,
  key: string,
  displayName: string,
): Promise<'opened' | 'missing' | 'unsupported'> {
  if (isNativeApp() && file && !file.path.startsWith('indexeddb:')) {
    if (file.storage === 'vault' && file.uri) {
      if (!(await existsOnPhone(file, key))) return 'missing'
      try {
        await VaultNative.openFile({ uri: file.uri, mimeType: file.type })
        return 'opened'
      } catch {
        return 'unsupported'
      }
    }

    const directory = await findDirectory(file.path, file.storage)
    if (!directory) return 'missing'
    try {
      const { uri } = await Filesystem.getUri({ path: file.path, directory })
      await VaultNative.openFile({ uri, mimeType: file.type })
      return 'opened'
    } catch {
      return 'unsupported'
    }
  }

  const blob = await readFromPhone(file, key)
  if (!blob) return 'missing'

  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = displayName
  anchor.click()
  URL.revokeObjectURL(url)
  return 'opened'
}

/**
 * Ekspor/cadangan seluruh data checklist ke berkas JSON.
 * Android dengan vault: <vault>/cadangan-berkassiap-<tanggal>.json
 * Android tanpa vault: Documents/BerkasSiap/cadangan-berkassiap-<tanggal>.json
 * Browser: unduhan berkas .json.
 */
export async function exportBackup(data: unknown) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const fileName = `cadangan-berkassiap-${stamp}.json`
  const content = JSON.stringify(data, null, 2)

  if (!isNativeApp()) {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
    URL.revokeObjectURL(url)
    return { fileName, path: fileName, storage: 'browser' as const }
  }

  const data64 = await blobToBase64(new Blob([content], { type: 'application/json' }))
  const vault = readVault()
  if (vault) {
    try {
      const saved = await VaultNative.saveFile({
        treeUri: vault.uri,
        name: fileName,
        mimeType: 'application/json',
        data: data64,
      })
      return {
        fileName: saved.name,
        path: `vault:${saved.name}`,
        storage: 'vault' as const,
        vault: vault.name,
      }
    } catch {
      // Vault tidak bisa diakses: simpan ke folder bawaan.
    }
  }

  await requestNativePermission()
  const relative = `${FILES_FOLDER}/${fileName}`

  for (const storage of ['documents', 'external'] as const) {
    const directory = nativeDirectories(storage)[0]
    try {
      await Filesystem.writeFile({ path: relative, data: data64, directory, recursive: true })
      return { fileName, path: relative, storage }
    } catch {
      // Coba folder berikutnya.
    }
  }

  throw new Error('Tidak dapat menyimpan cadangan')
}
