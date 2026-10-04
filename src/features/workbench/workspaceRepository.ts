import { type WorkspaceDocument } from '../../shared/models'
import { BrowserStorageService, isWorkspaceDocument, type StorageService, type StorageSnapshot } from './storageService'

export type LoadNotice =
  | { kind: 'ok' }
  | { kind: 'empty' }
  | { kind: 'restored-from-backup'; savedAt: string | null }
  | { kind: 'backup-unavailable' }
  | { kind: 'unreadable' }

export interface LoadResult {
  document: WorkspaceDocument | null
  notice: LoadNotice
}

export interface SaveResult {
  primaryOk: boolean
  backupOk: boolean
}

export class StorageConflictError extends Error {
  constructor() {
    super('本地已存在更新的存档，本次保存被阻止')
    this.name = 'StorageConflictError'
  }
}

export interface WorkspaceRepository {
  load(): Promise<LoadResult>
  save(document: WorkspaceDocument): Promise<SaveResult>
}

interface OkEntry {
  status: 'ok'
  document: WorkspaceDocument
  savedAtMs: number
}

type StoredEntry = { status: 'empty' } | { status: 'unusable' } | OkEntry

export class LocalWorkspaceRepository implements WorkspaceRepository {
  private baselineMs: number | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly storage: StorageService = new BrowserStorageService()) {}

  load(): Promise<LoadResult> {
    return this.enqueue(() => this.loadInternal())
  }

  save(document: WorkspaceDocument): Promise<SaveResult> {
    return this.enqueue(() => this.saveInternal(document))
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private async loadInternal(): Promise<LoadResult> {
    const snapshot = await this.storage.read()
    const primary = toEntry(snapshot.primary, snapshot.primaryError)
    const backup = toEntry(snapshot.backup, snapshot.backupError)
    const winner = pickWinner(primary, backup)

    if (!winner) {
      this.baselineMs = null
      return { document: null, notice: primary.status === 'unusable' ? { kind: 'unreadable' } : { kind: 'empty' } }
    }

    this.baselineMs = winner.savedAtMs
    await this.reconcile(winner, primary, backup)

    if (primary.status !== 'ok') {
      return { document: winner.document, notice: { kind: 'restored-from-backup', savedAt: toIso(winner.savedAtMs) } }
    }
    return { document: winner.document, notice: backup.status === 'unusable' ? { kind: 'backup-unavailable' } : { kind: 'ok' } }
  }

  private async saveInternal(document: WorkspaceDocument): Promise<SaveResult> {
    const snapshot = await this.storage.read()
    const storedMs = newestMs(snapshot)
    if (storedMs !== null && storedMs > (this.baselineMs ?? -1)) {
      throw new StorageConflictError()
    }

    const savedAtMs = Date.now()
    const outcome = await this.storage.write(serializeEnvelope(document, savedAtMs))
    if (!outcome.primaryOk && !outcome.backupOk) {
      throw new Error('所有本地存储位置都写入失败')
    }
    this.baselineMs = savedAtMs
    return { primaryOk: outcome.primaryOk, backupOk: outcome.backupOk }
  }

  private async reconcile(winner: OkEntry, primary: StoredEntry, backup: StoredEntry): Promise<void> {
    const diverged = primary.status !== 'ok' || backup.status !== 'ok' || primary.savedAtMs !== backup.savedAtMs
    if (!diverged) return
    try {
      await this.storage.write(serializeEnvelope(winner.document, winner.savedAtMs))
    } catch {
      // 对账失败不影响本次读取，下次保存时会再次暴露
    }
  }
}

function pickWinner(primary: StoredEntry, backup: StoredEntry): OkEntry | null {
  if (primary.status === 'ok' && backup.status === 'ok') {
    return primary.savedAtMs >= backup.savedAtMs ? primary : backup
  }
  if (primary.status === 'ok') return primary
  if (backup.status === 'ok') return backup
  return null
}

function newestMs(snapshot: StorageSnapshot): number | null {
  const entries = [toEntry(snapshot.primary, snapshot.primaryError), toEntry(snapshot.backup, snapshot.backupError)]
  let best: number | null = null
  for (const entry of entries) {
    if (entry.status !== 'ok') continue
    best = best === null ? entry.savedAtMs : Math.max(best, entry.savedAtMs)
  }
  return best
}

function toEntry(raw: string | null, transportError: boolean): StoredEntry {
  if (transportError) return { status: 'unusable' }
  if (raw === null) return { status: 'empty' }
  const parsed = parseStored(raw)
  return parsed ? { status: 'ok', ...parsed } : { status: 'unusable' }
}

function parseStored(raw: string): { document: WorkspaceDocument; savedAtMs: number } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (isEnvelope(parsed)) {
    return { document: parsed.document, savedAtMs: parseMs(parsed.savedAt) ?? freshnessOf(parsed.document) }
  }
  if (isWorkspaceDocument(parsed)) {
    return { document: parsed, savedAtMs: freshnessOf(parsed) }
  }
  return null
}

function isEnvelope(value: unknown): value is { savedAt?: unknown; document: WorkspaceDocument } {
  if (!value || typeof value !== 'object') return false
  return isWorkspaceDocument((value as { document?: unknown }).document)
}

function parseMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function freshnessOf(document: WorkspaceDocument): number {
  return document.plans.reduce((max, plan) => {
    const ms = Date.parse(plan.updatedAt)
    return Number.isNaN(ms) ? max : Math.max(max, ms)
  }, 0)
}

function serializeEnvelope(document: WorkspaceDocument, savedAtMs: number): string {
  return JSON.stringify({ savedAt: toIso(savedAtMs), document })
}

function toIso(savedAtMs: number): string | null {
  return savedAtMs > 0 ? new Date(savedAtMs).toISOString() : null
}
