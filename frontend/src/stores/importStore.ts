import { create } from 'zustand'
import type { FieldSide, ImportBatchRecord, ImportStagingRecord, PackIssue } from '../types/offline-pack'
import {
  applyBatch as applyBatchService,
  discardBatch as discardBatchService,
  intakePack,
  listBatches,
  listStaging,
  pendingStagingCount,
  setChosenSide as setChosenSideService,
  setFieldChoice as setFieldChoiceService,
  type ApplySummary,
} from '../utils/import-service'

interface ImportStore {
  batches: ImportBatchRecord[]
  staging: ImportStagingRecord[]
  selectedBatchId: string | null
  issues: PackIssue[]
  isBusy: boolean
  error: string | null
  notice: string | null
  pendingCount: number
  loadBatches: () => Promise<void>
  selectBatch: (batchId: string) => Promise<void>
  importFile: (fileName: string, text: string) => Promise<boolean>
  applyBatch: (batchId: string) => Promise<ApplySummary | null>
  chooseSide: (key: string, side: FieldSide) => Promise<void>
  chooseField: (key: string, field: string, side: FieldSide) => Promise<void>
  discardBatch: (batchId: string) => Promise<void>
  clearNotice: () => void
}

export const useImportStore = create<ImportStore>((set, get) => ({
  batches: [],
  staging: [],
  selectedBatchId: null,
  issues: [],
  isBusy: false,
  error: null,
  notice: null,
  pendingCount: 0,

  loadBatches: async () => {
    try {
      const [batches, pendingCount] = await Promise.all([listBatches(), pendingStagingCount()])
      set({ batches, pendingCount, error: null })
    } catch {
      set({ error: '导入批次读取失败，请检查浏览器存储权限' })
    }
  },

  selectBatch: async (batchId) => {
    set({ selectedBatchId: batchId, isBusy: true, error: null, issues: [] })
    try {
      const staging = await listStaging(batchId)
      set({ staging, isBusy: false })
    } catch {
      set({ isBusy: false, error: '暂存区读取失败' })
    }
  },

  importFile: async (fileName, text) => {
    set({ isBusy: true, error: null, notice: null })
    try {
      const outcome = await intakePack(fileName, text)
      const batches = await listBatches()
      const pendingCount = await pendingStagingCount()
      set({
        batches,
        pendingCount,
        selectedBatchId: outcome.batch.batchId,
        issues: outcome.issues,
        isBusy: false,
        notice: outcome.created
          ? `已读入离线包「${outcome.batch.source}」，请核对 ${outcome.batch.stats.total} 条记录`
          : `该离线包已在批次列表中（重试不会重复建档），已为你打开原进度`,
      })
      await get().selectBatch(outcome.batch.batchId)
      return true
    } catch (error) {
      set({ isBusy: false, error: error instanceof Error ? error.message : '离线包读入失败' })
      return false
    }
  },

  applyBatch: async (batchId) => {
    set({ isBusy: true, error: null, notice: null })
    try {
      const summary = await applyBatchService(batchId)
      const [batches, staging, pendingCount] = await Promise.all([listBatches(), listStaging(batchId), pendingStagingCount()])
      set({ batches, staging, pendingCount, isBusy: false })
      const tail = summary.errors.length
        ? `，${summary.errors.length} 条写入失败`
        : summary.held > 0
          ? `，${summary.held} 条缺上游暂存待处理`
          : summary.awaitingChoice > 0
            ? `，${summary.awaitingChoice} 条冲突尚未选定`
            : ''
      set({ notice: `已写入 ${summary.applied} 条${tail}；重试同一包不重复建档` })
      return summary
    } catch (error) {
      set({ isBusy: false, error: error instanceof Error ? error.message : '整包写入失败，批次与进度已保留' })
      return null
    }
  },

  chooseSide: async (key, side) => {
    const batchId = get().selectedBatchId
    if (!batchId) return
    await setChosenSideService(batchId, key, side)
    const [staging, batches, pendingCount] = await Promise.all([listStaging(batchId), listBatches(), pendingStagingCount()])
    set({ staging, batches, pendingCount })
  },

  chooseField: async (key, field, side) => {
    const batchId = get().selectedBatchId
    if (!batchId) return
    await setFieldChoiceService(batchId, key, field, side)
    const [staging, batches, pendingCount] = await Promise.all([listStaging(batchId), listBatches(), pendingStagingCount()])
    set({ staging, batches, pendingCount })
  },

  discardBatch: async (batchId) => {
    set({ isBusy: true, error: null })
    try {
      await discardBatchService(batchId)
      const [batches, pendingCount] = await Promise.all([listBatches(), pendingStagingCount()])
      const next = batches[0]?.batchId ?? null
      const staging = next ? await listStaging(next) : []
      set({ batches, staging, pendingCount, selectedBatchId: next, isBusy: false, notice: '已丢弃该批次暂存（已写入台账的数据保留）' })
    } catch {
      set({ isBusy: false, error: '批次丢弃失败' })
    }
  },

  clearNotice: () => set({ notice: null, error: null, issues: [] }),
}))
