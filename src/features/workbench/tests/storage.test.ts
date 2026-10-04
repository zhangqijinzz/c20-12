import { describe, expect, it } from 'vitest'
import { BrowserStorageService, type StorageBackend } from '../storageService'
import { LocalWorkspaceRepository, StorageConflictError } from '../workspaceRepository'
import { createInitialDocument, type WorkspaceDocument } from '../../../shared/models'

class MemoryBackend implements StorageBackend {
  failRead = false
  failWrite = false

  constructor(public value: string | null = null) {}

  async read(): Promise<string | null> {
    if (this.failRead) throw new Error('read failed')
    return this.value
  }

  async write(value: string): Promise<void> {
    if (this.failWrite) throw new Error('write failed')
    this.value = value
  }
}

function envelope(document: WorkspaceDocument, savedAt: string): string {
  return JSON.stringify({ savedAt, document })
}

function setup(primaryValue: string | null = null, backupValue: string | null = null) {
  const primary = new MemoryBackend(primaryValue)
  const backup = new MemoryBackend(backupValue)
  const repository = new LocalWorkspaceRepository(new BrowserStorageService(primary, backup))
  return { primary, backup, repository }
}

const T_OLD = '2026-08-01T08:00:00.000Z'
const T_NEW = '2026-09-01T08:00:00.000Z'

describe('local workspace repository', () => {
  it('round trips a document and mirrors it to both locations', async () => {
    const { primary, backup, repository } = setup()
    const document = createInitialDocument()
    await repository.save(document)
    expect(primary.value).not.toBeNull()
    expect(primary.value).toBe(backup.value)

    const result = await repository.load()
    expect(result.notice).toEqual({ kind: 'ok' })
    expect(result.document).toEqual(document)
  })

  it('prefers the newer copy when the two locations diverge and heals the stale one', async () => {
    const newer = createInitialDocument()
    const older = createInitialDocument()
    const { backup, repository } = setup(envelope(newer, T_NEW), envelope(older, T_OLD))

    const result = await repository.load()
    expect(result.notice).toEqual({ kind: 'ok' })
    expect(result.document).toEqual(newer)
    expect(JSON.parse(backup.value!)).toEqual({ savedAt: T_NEW, document: newer })
  })

  it('prefers the backup when it holds the newer copy and heals the primary', async () => {
    const newer = createInitialDocument()
    const older = createInitialDocument()
    const { primary, repository } = setup(envelope(older, T_OLD), envelope(newer, T_NEW))

    const result = await repository.load()
    expect(result.notice).toEqual({ kind: 'ok' })
    expect(result.document).toEqual(newer)
    expect(JSON.parse(primary.value!)).toEqual({ savedAt: T_NEW, document: newer })
  })

  it('restores from the backup when the primary location is empty', async () => {
    const document = createInitialDocument()
    const { primary, repository } = setup(null, envelope(document, T_OLD))

    const result = await repository.load()
    expect(result.document).toEqual(document)
    expect(result.notice).toEqual({ kind: 'restored-from-backup', savedAt: T_OLD })
    expect(JSON.parse(primary.value!)).toEqual({ savedAt: T_OLD, document })
  })

  it('restores from the backup when the primary location cannot be read', async () => {
    const document = createInitialDocument()
    const { primary, repository } = setup(null, envelope(document, T_OLD))
    primary.failRead = true

    const result = await repository.load()
    expect(result.document).toEqual(document)
    expect(result.notice).toEqual({ kind: 'restored-from-backup', savedAt: T_OLD })
  })

  it('keeps primary data and warns when the backup location cannot be read', async () => {
    const document = createInitialDocument()
    const { backup, repository } = setup(envelope(document, T_NEW), null)
    backup.failRead = true

    const result = await repository.load()
    expect(result.document).toEqual(document)
    expect(result.notice).toEqual({ kind: 'backup-unavailable' })
  })

  it('reports empty when neither location has data', async () => {
    const { repository } = setup()
    const result = await repository.load()
    expect(result.document).toBeNull()
    expect(result.notice).toEqual({ kind: 'empty' })
  })

  it('reports unreadable when both locations fail', async () => {
    const { primary, backup, repository } = setup()
    primary.failRead = true
    backup.failRead = true

    const result = await repository.load()
    expect(result.document).toBeNull()
    expect(result.notice).toEqual({ kind: 'unreadable' })
  })

  it('reports unreadable when both copies are damaged', async () => {
    const { repository } = setup('{broken', '{also broken')
    const result = await repository.load()
    expect(result.document).toBeNull()
    expect(result.notice).toEqual({ kind: 'unreadable' })
  })

  it('loads legacy documents stored without an envelope', async () => {
    const legacy = createInitialDocument()
    const { repository } = setup(JSON.stringify(legacy), null)

    const result = await repository.load()
    expect(result.notice).toEqual({ kind: 'ok' })
    expect(result.document).toEqual(legacy)
  })

  it('refuses to overwrite an existing snapshot it never loaded', async () => {
    const stored = createInitialDocument()
    const storedRaw = envelope(stored, T_NEW)
    const { primary, repository } = setup(storedRaw, null)

    await expect(repository.save(createInitialDocument())).rejects.toBeInstanceOf(StorageConflictError)
    expect(primary.value).toBe(storedRaw)
  })

  it('refuses to overwrite a newer snapshot written after the load', async () => {
    const loaded = createInitialDocument()
    const { primary, backup, repository } = setup(envelope(loaded, T_OLD), envelope(loaded, T_OLD))
    await repository.load()

    const newerElsewhere = createInitialDocument()
    primary.value = envelope(newerElsewhere, T_NEW)
    backup.value = envelope(newerElsewhere, T_NEW)

    await expect(repository.save(loaded)).rejects.toBeInstanceOf(StorageConflictError)
    expect(JSON.parse(primary.value!)).toEqual({ savedAt: T_NEW, document: newerElsewhere })
  })

  it('allows consecutive saves after a load', async () => {
    const document = createInitialDocument()
    const { repository } = setup(envelope(document, T_OLD), envelope(document, T_OLD))
    await repository.load()

    await expect(repository.save(document)).resolves.toEqual({ primaryOk: true, backupOk: true })
    await expect(repository.save(document)).resolves.toEqual({ primaryOk: true, backupOk: true })
  })

  it('reports a degraded save when one location cannot be written', async () => {
    const { backup, repository } = setup()
    backup.failWrite = true

    await expect(repository.save(createInitialDocument())).resolves.toEqual({ primaryOk: true, backupOk: false })
  })

  it('fails the save when both locations cannot be written', async () => {
    const { primary, backup, repository } = setup()
    primary.failWrite = true
    backup.failWrite = true

    await expect(repository.save(createInitialDocument())).rejects.toThrow()
  })
})
