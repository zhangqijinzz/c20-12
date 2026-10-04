import type { WorkspaceDocument } from '../../shared/models'

export const STORAGE_KEY = 'focusdesk.document.v1'
const DATABASE_NAME = 'focusdesk-db'
const STORE_NAME = 'workspace'

// 本地的两处存放位置：IndexedDB 为常用主存储，localStorage 为降级备份。
export type StorageLocation = 'indexeddb' | 'localStorage'

export const STORAGE_LOCATIONS: StorageLocation[] = ['indexeddb', 'localStorage']

export function describeStorageLocation(location: StorageLocation): string {
  return location === 'indexeddb' ? '本地数据库' : '浏览器本地缓存'
}

// 每个位置各自的读取结果，故障与“没有数据/数据损坏”区分开，且互不影响。
export interface StorageEntry {
  location: StorageLocation
  // 读取或解析阶段是否发生异常（存储不可用）
  error: boolean
  // 成功读到的原始字符串；null 表示该位置没有数据
  raw: string | null
}

export interface StorageService {
  // 同时读取两处存储，永远不抛出异常；每个位置的故障在各自的 entry 里标记。
  readAll(): Promise<StorageEntry[]>
  // 同时写入两处存储，返回写入失败的位置列表；不抛出异常。
  writeAll(value: string): Promise<StorageLocation[]>
}

export class BrowserStorageService implements StorageService {
  async readAll(): Promise<StorageEntry[]> {
    return Promise.all(STORAGE_LOCATIONS.map((location) => readOne(location)))
  }

  async writeAll(value: string): Promise<StorageLocation[]> {
    const results = await Promise.all(
      STORAGE_LOCATIONS.map(async (location) => ({ location, ok: await writeOne(location, value) })),
    )
    return results.filter((result) => !result.ok).map((result) => result.location)
  }
}

async function readOne(location: StorageLocation): Promise<StorageEntry> {
  try {
    if (location === 'indexeddb') {
      const database = await openDatabase()
      try {
        const value = await readFromDatabase(database)
        return { location, error: false, raw: typeof value === 'string' ? value : null }
      } finally {
        database.close()
      }
    }
    return { location, error: false, raw: window.localStorage.getItem(STORAGE_KEY) }
  } catch {
    // 注意：这里不再“出错就去读另一处”——降级由对账层处理，并需要让用户知道。
    return { location, error: true, raw: null }
  }
}

async function writeOne(location: StorageLocation, value: string): Promise<boolean> {
  try {
    if (location === 'indexeddb') {
      const database = await openDatabase()
      try {
        await writeToDatabase(database, value)
      } finally {
        database.close()
      }
    } else {
      window.localStorage.setItem(STORAGE_KEY, value)
    }
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
