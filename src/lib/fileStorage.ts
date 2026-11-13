import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'

/**
 * Penyimpanan berkas BerkasSiap.
 *
 * - Di aplikasi Android (Capacitor): berkas ditulis ke folder publik
 *   Documents/BerkasSiap/<nama-checklist>/<nama-file>.
 * - Di browser biasa: berkas disimpan di IndexedDB seperti sebelumnya.
 *
 * Data checklist (localStorage) hanya menyimpan jalur + metadata berkas,
 * bukan isi berkasnya.
 */

export const FILES_FOLDER = 'BerkasSiap'

export type PhoneFile = {
  /** Jalur relatif, contoh: BerkasSiap/KTP/ktp.pdf */
  path: string
  /** Folder native yang dipakai saat menyimpan. */
  storage: 'documents' | 'external'
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
 * Simpan berkas ke Documents/BerkasSiap/<nama-checklist>/<nama-file>.
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
  return Boolean(await findDirectory(file.path, file.storage))
}

/**
 * Buka berkas yang tersimpan. Di Android berkas dibuka lewat URI lokal
 * Capacitor, di browser diunduh seperti sebelumnya.
 */
export async function openFromPhone(
  file: PhoneFile | undefined,
  key: string,
  displayName: string,
): Promise<'opened' | 'missing'> {
  if (isNativeApp() && file && !file.path.startsWith('indexeddb:')) {
    const directory = await findDirectory(file.path, file.storage)
    if (!directory) return 'missing'
    const { uri } = await Filesystem.getUri({ path: file.path, directory })
    window.open(Capacitor.convertFileSrc(uri), '_blank')
    return 'opened'
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
 * Android: Documents/BerkasSiap/cadangan-berkassiap-<tanggal>.json
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

  await requestNativePermission()
  const data64 = await blobToBase64(new Blob([content], { type: 'application/json' }))
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
