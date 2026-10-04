import type { WorkspaceDocument } from '../../shared/models'

export const STORAGE_KEY = 'focusdesk.document.v1'
const DATABASE_NAME = 'focusdesk-db'
const STORE_NAME = 'workspace'

export interface StorageBackend {
  read(): Promise<string | null>
  write(value: string): Promise<void>
}

export interface StorageSnapshot {
  primary: string | null
  backup: string | null
  primaryError: boolean
  backupError: boolean
}

export interface WriteOutcome {
  primaryOk: boolean
  backupOk: boolean
}

export interface StorageService {
  read(): Promise<StorageSnapshot>
  write(value: string): Promise<WriteOutcome>
}

export class IndexedDbBackend implements StorageBackend {
  async read(): Promise<string | null> {
    const database = await openDatabase()
    try {
      const value = await readFromDatabase(database)
      return typeof value === 'string' ? value : null
    } finally {
      database.close()
    }
  }

  async write(value: string): Promise<void> {
    const database = await openDatabase()
    try {
      await writeToDatabase(database, value)
    } finally {
      database.close()
    }
  }
}

export class LocalStorageBackend implements StorageBackend {
  async read(): Promise<string | null> {
    return window.localStorage.getItem(STORAGE_KEY)
  }

  async write(value: string): Promise<void> {
    window.localStorage.setItem(STORAGE_KEY, value)
  }
}

export class BrowserStorageService implements StorageService {
  constructor(
    private readonly primary: StorageBackend = new IndexedDbBackend(),
    private readonly backup: StorageBackend = new LocalStorageBackend(),
  ) {}

  async read(): Promise<StorageSnapshot> {
    const [primary, backup] = await Promise.all([attemptRead(this.primary), attemptRead(this.backup)])
    return {
      primary: primary.value,
      backup: backup.value,
      primaryError: primary.error,
      backupError: backup.error,
    }
  }

  async write(value: string): Promise<WriteOutcome> {
    const [primaryOk, backupOk] = await Promise.all([attemptWrite(this.primary, value), attemptWrite(this.backup, value)])
    return { primaryOk, backupOk }
  }
}

async function attemptRead(backend: StorageBackend): Promise<{ value: string | null; error: boolean }> {
  try {
    return { value: await backend.read(), error: false }
  } catch {
    return { value: null, error: true }
  }
}

async function attemptWrite(backend: StorageBackend, value: string): Promise<boolean> {
  try {
    await backend.write(value)
    return true
  } catch {
    return false
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
}

function readFromDatabase(database: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(STORAGE_KEY)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'))
  })
}

function writeToDatabase(database: IDBDatabase, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(value, STORAGE_KEY)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('IndexedDB write failed'))
  })
}

export function isWorkspaceDocument(value: unknown): value is WorkspaceDocument {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WorkspaceDocument>
  return candidate.version === 1 && Array.isArray(candidate.plans) && typeof candidate.activePlanId === 'string'
}
