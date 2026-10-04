import { describe, expect, it } from 'vitest'
import { LocalWorkspaceRepository, documentFreshness } from '../workspaceRepository'
import {
  describeStorageLocation,
  STORAGE_LOCATIONS,
  type StorageEntry,
  type StorageLocation,
  type StorageService,
} from '../storageService'
import { createInitialDocument, touchDocument, type WorkspaceDocument } from '../../../shared/models'

// 每个位置独立存储的假实现，可模拟“无数据 / 损坏 / 读取故障 / 写入失败”。
class FakeDualStorage implements StorageService {
  readonly values = new Map<StorageLocation, string | null | Error>()
  readonly writeFailures = new Set<StorageLocation>()
  readonly writes = new Map<StorageLocation, string[]>()

  set(location: StorageLocation, value: string | null | Error): this {
    this.values.set(location, value)
    return this
  }

  failWrite(location: StorageLocation): this {
    this.writeFailures.add(location)
    return this
  }

  async readAll(): Promise<StorageEntry[]> {
    return STORAGE_LOCATIONS.map((location) => {
      const value = this.values.get(location) ?? null
      if (value instanceof Error) return { location, error: true, raw: null }
      return { location, error: false, raw: value }
    })
  }

  async writeAll(value: string): Promise<StorageLocation[]> {
    const failed: StorageLocation[] = []
    for (const location of STORAGE_LOCATIONS) {
      if (this.writeFailures.has(location)) {
        failed.push(location)
        continue
      }
      this.values.set(location, value)
      const history = this.writes.get(location) ?? []
      history.push(value)
      this.writes.set(location, history)
    }
    return failed
  }
}

const IDB: StorageLocation = 'indexeddb'
const LS: StorageLocation = 'localStorage'

function docAt(document: WorkspaceDocument, updatedAt: string): WorkspaceDocument {
  return { ...document, updatedAt }
}

function describeSet(locations: StorageLocation[]): string {
  return locations.map(describeStorageLocation).sort().join('|')
}

describe('local workspace repository', () => {
  it('round trips a document to both stores', async () => {
    const storage = new FakeDualStorage()
    const repository = new LocalWorkspaceRepository(storage)
    const document = createInitialDocument()
    const failed = await repository.save(document)
    expect(failed).toEqual([])

    const loaded = await repository.load()
    expect(loaded.outcome).toBe('synced')
    expect(loaded.document).toMatchObject({ version: 1, activePlanId: document.activePlanId })
    expect(loaded.document?.updatedAt).toBeTruthy()
  })

  it('prefers the newer copy when stores diverge and heals the stale one', async () => {
    // 复现 bug：IndexedDB 里是新版，localStorage 停留在很久以前的旧版
    const base = createInitialDocument()
    const oldDoc = docAt(base, '2024-01-01T00:00:00.000Z')
    const newDoc = docAt(
      { ...base, plans: [{ ...base.plans[0], name: '新版方案' }] },
      '2026-09-30T10:00:00.000Z',
    )
    const storage = new FakeDualStorage().set(IDB, JSON.stringify(newDoc)).set(LS, JSON.stringify(oldDoc))
    const repository = new LocalWorkspaceRepository(storage)

    const loaded = await repository.load()
    expect(loaded.outcome).toBe('reconciled')
    expect(loaded.document).toEqual(newDoc)
    expect(loaded.source).toEqual([IDB])
    expect(loaded.detail.join('')).toContain('较旧')
    // 旧副本已被新版回填，而不是旧数据盖掉新数据
    expect(JSON.parse(storage.values.get(LS) as string)).toEqual(newDoc)
  })

  it('also picks newer localStorage when it is ahead of IndexedDB', async () => {
    const base = createInitialDocument()
    const oldDoc = docAt(base, '2024-01-01T00:00:00.000Z')
    const newDoc = docAt({ ...base, activePlanId: base.plans[0].id }, '2026-09-30T10:00:00.000Z')
    // 模拟清浏览器数据后 IndexedDB 被清空、只剩 localStorage，随后 localStorage 反而是更新的
    const storage = new FakeDualStorage().set(IDB, JSON.stringify(oldDoc)).set(LS, JSON.stringify(newDoc))
    const repository = new LocalWorkspaceRepository(storage)

    const loaded = await repository.load()
    expect(loaded.outcome).toBe('reconciled')
    expect(loaded.document).toEqual(newDoc)
    expect(loaded.source).toEqual([LS])
    expect(JSON.parse(storage.values.get(IDB) as string)).toEqual(newDoc)
  })

  it('recovers from the only readable store and backs it up to the other', async () => {
    const document = docAt(createInitialDocument(), '2026-09-30T10:00:00.000Z')
    const storage = new FakeDualStorage().set(IDB, null).set(LS, JSON.stringify(document))
    const repository = new LocalWorkspaceRepository(storage)

    const loaded = await repository.load()
    expect(loaded.outcome).toBe('recovered')
    expect(loaded.document).toEqual(document)
    expect(loaded.source).toEqual([LS])
    expect(loaded.detail.join('')).toContain('旧数据不会覆盖它')
    expect(JSON.parse(storage.values.get(IDB) as string)).toEqual(document)
  })

  it('reports a corrupted sibling instead of silently trusting it', async () => {
    const document = docAt(createInitialDocument(), '2026-09-30T10:00:00.000Z')
    const storage = new FakeDualStorage().set(IDB, '{broken').set(LS, JSON.stringify(document))
    const repository = new LocalWorkspaceRepository(storage)

    const loaded = await repository.load()
    expect(loaded.outcome).toBe('recovered')
    expect(loaded.document).toEqual(document)
    expect(loaded.detail.join('')).toContain('损坏')
  })

  it('reports an inaccessible sibling explicitly', async () => {
    const document = docAt(createInitialDocument(), '2026-09-30T10:00:00.000Z')
    const storage = new FakeDualStorage().set(IDB, new Error('idb blocked')).set(LS, JSON.stringify(document))
    const repository = new LocalWorkspaceRepository(storage)

    const loaded = await repository.load()
    expect(loaded.outcome).toBe('recovered')
    expect(loaded.detail.join('')).toContain('无法访问')
  })

  it('does not overwrite anything when equally fresh copies conflict', async () => {
    const base = createInitialDocument()
    const stamp = '2026-09-30T10:00:00.000Z'
    const versionA = docAt({ ...base, plans: [{ ...base.plans[0], name: 'A' }] }, stamp)
    const versionB = docAt({ ...base, plans: [{ ...base.plans[0], name: 'B' }] }, stamp)
    const storage = new FakeDualStorage().set(IDB, JSON.stringify(versionA)).set(LS, JSON.stringify(versionB))
    const repository = new LocalWorkspaceRepository(storage)

    const loaded = await repository.load()
    expect(loaded.outcome).toBe('conflict')
    expect(loaded.document).toEqual(versionA)
    expect(loaded.detail.join('')).toContain('无法自动判断')
    // 两份都保持原样
    expect(JSON.parse(storage.values.get(IDB) as string)).toEqual(versionA)
    expect(JSON.parse(storage.values.get(LS) as string)).toEqual(versionB)
  })

  it('treats identical copies as synced even with different key order', async () => {
    const document = docAt(createInitialDocument(), '2026-09-30T10:00:00.000Z')
    const normal = JSON.stringify(document)
    // 手动构造键顺序相反、但内容完全一致的 JSON
    const plan = document.plans[0]
    const reorderedItems = plan.items
      .map((item) => `{"rotation":${item.rotation},"y":${item.y},"x":${item.x},"heightMm":${item.heightMm},"widthMm":${item.widthMm},"type":"${item.type}","id":"${item.id}"}`)
      .join(',')
    const reorderedPlan = `{"updatedAt":"${plan.updatedAt}","items":[${reorderedItems}],"deskHeightMm":${plan.deskHeightMm},"deskWidthMm":${plan.deskWidthMm},"name":"${plan.name}","id":"${plan.id}"}`
    const reversed = `{"updatedAt":"${document.updatedAt}","activePlanId":"${document.activePlanId}","plans":[${reorderedPlan}],"version":1}`
    expect(reversed).not.toBe(normal)

    const storage = new FakeDualStorage().set(IDB, normal).set(LS, reversed)
    const loaded = await new LocalWorkspaceRepository(storage).load()
    expect(loaded.outcome).toBe('synced')
  })

  it('falls back to the newest plan timestamp for legacy documents without document updatedAt', async () => {
    const legacy = createInitialDocument()
    delete legacy.updatedAt
    expect(documentFreshness(legacy)).toBe(new Date(legacy.plans[0].updatedAt).getTime())

    const older = { ...legacy, plans: [{ ...legacy.plans[0], updatedAt: '2024-01-01T00:00:00.000Z' }] }
    const storage = new FakeDualStorage().set(IDB, JSON.stringify(legacy)).set(LS, JSON.stringify(older))
    const loaded = await new LocalWorkspaceRepository(storage).load()
    expect(loaded.outcome).toBe('reconciled')
    expect(loaded.document).toEqual(legacy)
  })

  it('returns empty outcome only when both stores genuinely have no data', async () => {
    const storage = new FakeDualStorage().set(IDB, null).set(LS, null)
    const loaded = await new LocalWorkspaceRepository(storage).load()
    expect(loaded.outcome).toBe('empty')
    expect(loaded.document).toBeNull()
  })

  it('reports unavailable when neither store yields a valid document', async () => {
    const storage = new FakeDualStorage().set(IDB, '{broken').set(LS, new Error('blocked'))
    const loaded = await new LocalWorkspaceRepository(storage).load()
    expect(loaded.outcome).toBe('unavailable')
    expect(loaded.document).toBeNull()
    expect(loaded.detail.join('')).toContain('损坏')
    expect(loaded.detail.join('')).toContain('无法访问')
  })

  it('surfaces failed heal writes in reconciled detail', async () => {
    const base = createInitialDocument()
    const oldDoc = docAt(base, '2024-01-01T00:00:00.000Z')
    const newDoc = docAt(base, '2026-09-30T10:00:00.000Z')
    const storage = new FakeDualStorage()
      .set(IDB, JSON.stringify(newDoc))
      .set(LS, JSON.stringify(oldDoc))
      .failWrite(LS)
    const loaded = await new LocalWorkspaceRepository(storage).load()
    expect(loaded.outcome).toBe('reconciled')
    expect(loaded.document).toEqual(newDoc)
    expect(loaded.detail.join('')).toContain('同步回')
    // 旧副本原样保留
    expect(JSON.parse(storage.values.get(LS) as string)).toEqual(oldDoc)
  })

  it('reports failed locations on save instead of throwing', async () => {
    const storage = new FakeDualStorage().failWrite(LS)
    const failed = await new LocalWorkspaceRepository(storage).save(createInitialDocument())
    expect(failed).toEqual([LS])
    expect(storage.writes.get(IDB)?.length).toBe(1)
  })

  it('stamps updatedAt on every save so plan switches are detectable', async () => {
    const storage = new FakeDualStorage()
    const repository = new LocalWorkspaceRepository(storage)
    const first = await repository.save(createInitialDocument())
    expect(first).toEqual([])
    const firstRaw = storage.values.get(IDB) as string
    await new Promise((resolve) => setTimeout(resolve, 10))
    await repository.save(JSON.parse(firstRaw) as WorkspaceDocument)
    const secondDoc = JSON.parse(storage.values.get(IDB) as string) as WorkspaceDocument
    expect(new Date(secondDoc.updatedAt as string).getTime()).toBeGreaterThan(
      new Date((JSON.parse(firstRaw) as WorkspaceDocument).updatedAt as string).getTime(),
    )
  })

  it('touchDocument refreshes the document timestamp', () => {
    const touched = touchDocument(docAt(createInitialDocument(), '2024-01-01T00:00:00.000Z'))
    expect(new Date(touched.updatedAt as string).getTime()).toBeGreaterThan(Date.parse('2024-01-01'))
  })

  it('names both storage locations for users', () => {
    expect(describeSet(STORAGE_LOCATIONS)).toContain('本地数据库')
    expect(describeSet(STORAGE_LOCATIONS)).toContain('本地缓存')
  })
})
