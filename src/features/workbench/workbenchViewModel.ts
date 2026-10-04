import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createId,
  createInitialDocument,
  createPlan,
  type DeskItem,
  type DeviceType,
  type LayoutAnalysis,
  type WorkspaceDocument,
  type WorkspacePlan,
  type WorkspaceStatus,
} from '../../shared/models'
import { clampDeskSize, clampItemDimension } from '../../shared/layoutRules'
import { moveCanvasItem, rotateCanvasItem } from '../canvas/canvasViewModel'
import { createMaterialDraft } from '../materials/materialsViewModel'
import { inspectPlan } from '../inspection/inspectionViewModel'
import { LocalWorkspaceRepository, type LoadResult, type WorkspaceRepository } from './workspaceRepository'

export interface WorkspaceViewModel {
  status: WorkspaceStatus
  document: WorkspaceDocument | null
  activePlan: WorkspacePlan | null
  selectedItem: DeskItem | null
  analysis: LayoutAnalysis
  issueIds: string[]
  issueCount: number
  feedback: string
  isPreviewOpen: boolean
  selectItem: (id: string | null) => void
  addItem: (type: DeviceType) => void
  removeItem: (id: string) => void
  moveItem: (id: string, x: number, y: number) => void
  rotateItem: (id: string, delta: number) => void
  updateItem: (id: string, patch: Partial<Pick<DeskItem, 'widthMm' | 'heightMm' | 'x' | 'y'>>) => void
  updateDesk: (field: 'deskWidthMm' | 'deskHeightMm', value: number) => void
  createNewPlan: () => void
  duplicatePlan: () => void
  selectPlan: (id: string) => void
  deleteCurrentPlan: () => void
  openPreview: () => void
  closePreview: () => void
}

const emptyInspection = { analysis: { overlapIds: [], outOfBoundsIds: [], coveragePercent: 0, status: 'clear' as const }, issueIds: [], issueCount: 0 }

export function useWorkspaceViewModel(repository?: WorkspaceRepository): WorkspaceViewModel {
  const repositoryRef = useRef(repository ?? new LocalWorkspaceRepository())
  const [status, setStatus] = useState<WorkspaceStatus>('loading')
  const [document, setDocument] = useState<WorkspaceDocument | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const [feedback, setFeedback] = useState('正在准备你的工作台…')

  useEffect(() => {
    let active = true
    void repositoryRef.current.load().then((loaded) => {
      if (!active) return
      applyLoadResult(loaded)
    }).catch(() => {
      if (!active) return
      setDocument(createInitialDocument())
      setStatus('error')
      setFeedback('本地数据读取失败，当前使用临时工作台；为避免旧数据覆盖新数据，本次内容不会自动保存')
    })
    return () => { active = false }

    function applyLoadResult(loaded: LoadResult) {
      switch (loaded.outcome) {
        case 'synced':
          setDocument(loaded.document)
          setStatus('ready')
          setFeedback('已恢复上次编辑状态，两处本地存储一致')
          break
        case 'reconciled':
          setDocument(loaded.document)
          setStatus('warning')
          setFeedback(loaded.detail.join('；'))
          break
        case 'conflict':
          setDocument(loaded.document)
          setStatus('warning')
          setFeedback(loaded.detail.join('；'))
          break
        case 'recovered':
          setDocument(loaded.document)
          setStatus('warning')
          setFeedback(loaded.detail.join('；'))
          break
        case 'empty':
          setDocument(createInitialDocument())
          setStatus('ready')
          setFeedback('未发现历史方案，已创建示例工作台，可以直接拖动设备')
          break
        case 'unavailable':
          setDocument(createInitialDocument())
          setStatus('error')
          setFeedback(`${loaded.detail.join('；')}`)
          break
      }
    }
  }, [])

  const activePlan = useMemo(
    () => document?.plans.find((plan) => plan.id === document.activePlanId) ?? null,
    [document],
  )
  const selectedItem = activePlan?.items.find((item) => item.id === selectedItemId) ?? null
  const inspection = useMemo(() => activePlan ? inspectPlan(activePlan) : emptyInspection, [activePlan])
  const { analysis, issueIds, issueCount } = inspection

  const persist = useCallback(async (nextDocument: WorkspaceDocument, message: string) => {
    setDocument(nextDocument)
    setStatus('saving')
    setFeedback(message)
    try {
      const failedLocations = await repositoryRef.current.save(nextDocument)
      if (failedLocations.length === 0) {
        setStatus('ready')
        setFeedback(message)
      } else {
        // 只写进了一处时必须告警：另一处仍是旧副本，下次启动可能读到旧版。
        setStatus('warning')
        const names = failedLocations.map((location) => location === 'indexeddb' ? '本地数据库' : '浏览器本地缓存').join('、')
        setFeedback(`${message}，但${names}暂时无法写入；两处备份不一致，请勿清理浏览器数据，并检查存储权限`)
      }
    } catch {
      setStatus('error')
      setFeedback('自动保存失败，两处本地存储都无法写入，请检查浏览器本地存储权限')
    }
  }, [])

  const updateActivePlan = useCallback((updater: (plan: WorkspacePlan) => WorkspacePlan, message: string) => {
    if (!document || !activePlan) return
    const nextPlan = { ...updater(activePlan), updatedAt: new Date().toISOString() }
    const nextDocument = { ...document, plans: document.plans.map((plan) => plan.id === nextPlan.id ? nextPlan : plan) }
    void persist(nextDocument, message)
  }, [activePlan, document, persist])

  const selectItem = useCallback((id: string | null) => setSelectedItemId(id), [])

  const addItem = useCallback((type: DeviceType) => {
    if (!activePlan) return
    const draft = createMaterialDraft(type, activePlan.items.length)
    updateActivePlan((plan) => ({ ...plan, items: [...plan.items, draft.item] }), draft.feedback)
    setSelectedItemId(draft.item.id)
  }, [activePlan, updateActivePlan])

  const removeItem = useCallback((id: string) => {
    updateActivePlan((plan) => ({ ...plan, items: plan.items.filter((item) => item.id !== id) }), '设备已移除')
    setSelectedItemId((current) => current === id ? null : current)
  }, [updateActivePlan])

  const moveItem = useCallback((id: string, x: number, y: number) => {
    updateActivePlan((plan) => ({ ...plan, items: moveCanvasItem(plan.items, id, x, y) }), '位置已更新')
  }, [updateActivePlan])

  const rotateItem = useCallback((id: string, delta: number) => {
    updateActivePlan((plan) => ({ ...plan, items: rotateCanvasItem(plan.items, id, delta) }), '角度已更新')
  }, [updateActivePlan])

  const updateItem = useCallback((id: string, patch: Partial<Pick<DeskItem, 'widthMm' | 'heightMm' | 'x' | 'y'>>) => {
    updateActivePlan((plan) => ({
      ...plan,
      items: plan.items.map((item) => item.id === id ? {
        ...item,
        ...patch,
        widthMm: patch.widthMm === undefined ? item.widthMm : clampItemDimension(patch.widthMm, item.widthMm),
        heightMm: patch.heightMm === undefined ? item.heightMm : clampItemDimension(patch.heightMm, item.heightMm),
      } : item),
    }), '尺寸参数已更新')
  }, [updateActivePlan])

  const updateDesk = useCallback((field: 'deskWidthMm' | 'deskHeightMm', value: number) => {
    if (!activePlan) return
    updateActivePlan((plan) => ({ ...plan, [field]: clampDeskSize(value, plan[field]) }), '桌面尺寸已更新')
  }, [activePlan, updateActivePlan])

  const createNewPlan = useCallback(() => {
    if (!document) return
    const plan = createPlan(`工作台 ${document.plans.length + 1}`, false)
    void persist({ ...document, plans: [...document.plans, plan], activePlanId: plan.id }, '已创建空白方案')
    setSelectedItemId(null)
  }, [document, persist])

  const duplicatePlan = useCallback(() => {
    if (!document || !activePlan) return
    const copy: WorkspacePlan = {
      ...activePlan,
      id: createId('plan'),
      name: `${activePlan.name} · 副本`,
      items: activePlan.items.map((item) => ({ ...item, id: createId('item') })),
      updatedAt: new Date().toISOString(),
    }
    void persist({ ...document, plans: [...document.plans, copy], activePlanId: copy.id }, '方案已复制')
    setSelectedItemId(null)
  }, [activePlan, document, persist])

  const selectPlan = useCallback((id: string) => {
    if (!document || !document.plans.some((plan) => plan.id === id)) return
    void persist({ ...document, activePlanId: id }, '已切换方案')
    setSelectedItemId(null)
  }, [document, persist])

  const deleteCurrentPlan = useCallback(() => {
    if (!document || !activePlan || document.plans.length <= 1) {
      setFeedback('至少保留一个工作台方案')
      return
    }
    const remaining = document.plans.filter((plan) => plan.id !== activePlan.id)
    void persist({ ...document, plans: remaining, activePlanId: remaining[0].id }, '方案已删除')
    setSelectedItemId(null)
  }, [activePlan, document, persist])

  const openPreview = useCallback(() => setIsPreviewOpen(true), [])
  const closePreview = useCallback(() => setIsPreviewOpen(false), [])

  return {
    status,
    document,
    activePlan,
    selectedItem,
    analysis,
    issueIds,
    issueCount,
    feedback,
    isPreviewOpen,
    selectItem,
    addItem,
    removeItem,
    moveItem,
    rotateItem,
    updateItem,
    updateDesk,
    createNewPlan,
    duplicatePlan,
    selectPlan,
    deleteCurrentPlan,
    openPreview,
    closePreview,
  }
}
