import { createInitialDocument, type WorkspaceDocument } from '../../shared/models'
import {
  BrowserStorageService,
  describeStorageLocation,
  isWorkspaceDocument,
  STORAGE_LOCATIONS,
  type StorageEntry,
  type StorageLocation,
  type StorageService,
} from './storageService'

export interface WorkspaceRepository {
  load(): Promise<LoadResult>
  // 返回写入失败的位置；空数组表示两处都已成功写入。
  save(document: WorkspaceDocument): Promise<StorageLocation[]>
}

// 读取后对账的结论。任何降级（用到旧数据、某一处损坏/不可用、两份冲突）都必须显式呈现，
// 不能让旧数据悄悄盖掉新数据。
export type LoadOutcome =
  | 'synced' // 两处一致
  | 'reconciled' // 两处不一致，已按更新时间以新者为准并回填
  | 'conflict' // 两份同样新但内容不同，无法自动对账，当前使用主存储版本
  | 'recovered' // 只有一处能拿到有效数据（另一处缺失/损坏/不可用）
  | 'empty' // 两处都没有数据，属于首次使用
  | 'unavailable' // 两处都读不出有效数据（故障或损坏）

export interface LoadResult {
  outcome: LoadOutcome
  document: WorkspaceDocument | null
  // 最终采用的数据来自哪个（些）位置
  source: StorageLocation[]
  // 结果中涉及、需要在文案中点名的位置（故障/损坏/较旧的一方等）
  locations: StorageLocation[]
  detail: string[]
}

interface ParsedEntry {
  entry: StorageEntry
  document: WorkspaceDocument | null
}

export class LocalWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly storage: StorageService = new BrowserStorageService()) {}

  async load(): Promise<LoadResult> {
    const entries = await this.storage.readAll()
    const parsed: ParsedEntry[] = entries.map((entry) => ({
      entry,
      document: parseEntry(entry),
    }))
    const valid = parsed.filter((item): item is ParsedEntry & { document: WorkspaceDocument } => item.document !== null)
    const invalid = parsed.filter((item) => item.document === null)

    if (valid.length === 2) return this.reconcile(valid[0], valid[1])
    if (valid.length === 1) return this.recover(valid[0], invalid)
    return this.unavailable(invalid)
  }

  private async reconcile(
    first: ParsedEntry & { document: WorkspaceDocument },
    second: ParsedEntry & { document: WorkspaceDocument },
  ): Promise<LoadResult> {
    const [a, b] = [first, second].sort((left, right) =>
      documentFreshness(left.document) >= documentFreshness(right.document) ? -1 : 1,
    )
    const aTime = documentFreshness(a.document)
    const bTime = documentFreshness(b.document)

    if (sameDocument(a.document, b.document)) {
      return result('synced', a.document, [a.entry.location, b.entry.location], [a.entry.location, b.entry.location], [
        `两处本地存储（${describeStorageLocation(a.entry.location)}、${describeStorageLocation(b.entry.location)}）内容一致`,
      ])
    }

    if (aTime > bTime) {
      // a 明确更新：以 a 为准，把新数据回填到较旧的 b，消除分叉。
      const failedHeals = await this.storage.writeAll(serialize(a.document))
      const staleLocation = b.entry.location
      const detail = [
        `${describeStorageLocation(staleLocation)}中是较旧的方案（停留在 ${formatTime(bTime)}），已自动改用${describeStorageLocation(
          a.entry.location,
        )}中更新的版本（${formatTime(aTime)}）`,
      ]
      if (failedHeals.length > 0) {
        detail.push(`把新版本同步回${failedHeals.map(describeStorageLocation).join('、')}时失败，下次启动可能再次出现旧版本提示`)
      }
      return result('reconciled', a.document, [a.entry.location], [a.entry.location, staleLocation], detail)
    }

    // 时间戳相同但内容不同：无法判断谁更新，绝不能拿其中一份静默覆盖另一份。
    return result('conflict', first.document, [first.entry.location], [first.entry.location, second.entry.location], [
      `两处本地存储保存了同样新（${formatTime(aTime)}）但内容不同的方案，无法自动判断哪一份是你要的`,
      `当前先展示${describeStorageLocation(first.entry.location)}中的版本，另一份保留在${describeStorageLocation(
        second.entry.location,
      )}中未被覆盖`,
    ])
  }

  private async recover(
    only: ParsedEntry & { document: WorkspaceDocument },
    invalid: ParsedEntry[],
  ): Promise<LoadResult> {
    const bad = invalid[0]
    const reason = bad.entry.raw !== null
      ? '数据已损坏'
      : bad.entry.error
        ? '当前无法访问'
        : '没有数据'
    // 只有一处可用时，明确告知用户用的是哪一份，并把有效数据补写回另一处。
    const failedHeals = await this.storage.writeAll(serialize(only.document))
    const detail = [
      `${describeStorageLocation(bad.entry.location)}${reason}，已改用${describeStorageLocation(
        only.entry.location,
      )}中保存的方案继续，旧数据不会覆盖它`,
    ]
    if (failedHeals.length > 0) {
      detail.push(`尝试把该方案备份回${describeStorageLocation(bad.entry.location)}时失败，请检查浏览器存储权限`)
    }
    return result('recovered', only.document, [only.entry.location], [only.entry.location, bad.entry.location], detail)
  }

  private unavailable(invalid: ParsedEntry[]): LoadResult {
    const anyError = invalid.some((item) => item.entry.error)
    const anyGarbage = invalid.some((item) => !item.entry.error && item.entry.raw !== null)
    if (!anyError && !anyGarbage) {
      return result('empty', null, [], STORAGE_LOCATIONS, ['两处本地存储都没有数据'])
    }
    const detail = invalid.map((item) => {
      const what = item.entry.error
        ? '无法访问'
        : item.entry.raw !== null
          ? '数据已损坏'
          : '没有数据'
      return `${describeStorageLocation(item.entry.location)}${what}`
    })
    if (anyError) detail.push('请检查浏览器的本地存储权限，当前会先打开一个空白的临时工作台')
    else detail.push('现有内容无法识别，当前会先打开一个空白的临时工作台')
    return result('unavailable', null, [], STORAGE_LOCATIONS, detail)
  }

  async save(document: WorkspaceDocument): Promise<StorageLocation[]> {
    // 保存时刷新文档级时间戳，让下一次启动能够正确比较两处副本的新旧。
    return this.storage.writeAll(serialize({ ...document, updatedAt: new Date().toISOString() }))
  }
}

function result(
  outcome: LoadOutcome,
  document: WorkspaceDocument | null,
  source: StorageLocation[],
  locations: StorageLocation[],
  detail: string[],
): LoadResult {
  return { outcome, document, source, locations, detail }
}

function parseEntry(entry: StorageEntry): WorkspaceDocument | null {
  if (entry.error || entry.raw === null) return null
  try {
    const parsed: unknown = JSON.parse(entry.raw)
    return isWorkspaceDocument(parsed) ? parsed : null
  } catch {
    return null
  }
}

function serialize(document: WorkspaceDocument): string {
  return JSON.stringify(document)
}

// 文档新旧程度：文档级 updatedAt 是每次保存时刷新的权威时间戳，存在时直接采用
// （它覆盖了“只切换方案”这类不改动方案内容的操作）；
// 旧版本数据没有该字段时，回退为各方案 updatedAt 的最大值。
export function documentFreshness(document: WorkspaceDocument): number {
  if (document.updatedAt) {
    const touched = Date.parse(document.updatedAt)
    if (!Number.isNaN(touched)) return touched
  }
  const planTimes = document.plans.map((plan) => Date.parse(plan.updatedAt)).filter((time) => !Number.isNaN(time))
  return planTimes.length > 0 ? Math.max(...planTimes) : 0
}

function formatTime(time: number): string {
  return time > 0 ? new Date(time).toLocaleString() : '未知时间'
}

// 与键顺序无关的结构化深比较，用来识别“两份其实完全相同”。
function sameDocument(left: WorkspaceDocument, right: WorkspaceDocument): boolean {
  return stableStringify(left) === stableStringify(right)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
  return `{${entries.join(',')}}`
}

export function getInitialDocument(document: WorkspaceDocument | null): WorkspaceDocument {
  return document ?? createInitialDocument()
}
