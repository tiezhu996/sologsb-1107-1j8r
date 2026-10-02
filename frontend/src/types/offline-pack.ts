import type { FiberMaterial, CookAgent, BleachMethod } from './fiber-batch'
import type { MouldStateValue, WireMaterial } from './mould'
import type { PaperSample } from './paper-sample'
import type { SheetRun } from './sheet-run'
import type { DryMethod, StripeDirection } from './sheet-run'
import type { EvennessLevel } from './paper-sample'
import type { FiberBatch } from './fiber-batch'
import type { Mould } from './mould'

/**
 * 离线包数据契约（format: 'gbpapermill-offline-pack/1'）。
 *
 * 作坊带回的离线包一律以业务编号描述关系：
 * 抄纸工序用 mouldNo / batchNo 指向纸帘与料批，
 * 成纸样本用 runNo 指向工序。包内的本机数字编号仅作溯源，
 * 不参与本机挂接，避免两机 id 不同而硬套关系。
 */

export const OFFLINE_PACK_FORMAT = 'gbpapermill-offline-pack/1'

export interface OfflineMould {
  mouldNo: string
  frameW: number
  frameH: number
  wireMaterial: WireMaterial
  wireDiameter: number
  stripeGap: number
  weaver: string
  state: MouldStateValue
}

export interface OfflineBatch {
  batchNo: string
  material: FiberMaterial
  origin: string
  cookAgent: CookAgent
  cookHours: number
  bleachMethod: BleachMethod
  beatingDegree: number
  operator: string
}

export interface OfflineRun {
  runNo: string
  /** 以业务编号挂接纸帘；不使用本机 mouldId */
  mouldNo: string
  /** 以业务编号挂接料批；不使用本机 batchId */
  batchNo: string
  runDate: string
  operator: string
  stripeDirection: StripeDirection
  dipCount: number
  stackHeight: number
  dryMethod: DryMethod
  grammage: number
  measuredGap: number
}

export interface OfflineSample {
  sampleNo: string
  /** 以业务编号挂接工序；不使用本机 runId */
  runNo: string
  sizeMm: number
  stripeCount: number
  evenness: EvennessLevel
  archiveBin: string
}

export interface OfflinePack {
  format: string
  source?: string
  packedAt?: string
  moulds?: OfflineMould[]
  fiberBatches?: OfflineBatch[]
  sheetRuns?: OfflineRun[]
  paperSamples?: OfflineSample[]
}

/** 归一化后的离线包实体集合 */
export interface NormalizedPack {
  source: string
  packedAt: string
  moulds: OfflineMould[]
  fiberBatches: OfflineBatch[]
  sheetRuns: OfflineRun[]
  paperSamples: OfflineSample[]
}

export type ImportEntityKind = 'mould' | 'fiberBatch' | 'sheetRun' | 'paperSample'

export type MergeStatus = 'new' | 'identical' | 'conflict'

/** 校验失败时返回的问题清单 */
export interface PackIssue {
  kind: ImportEntityKind
  businessNo: string
  reason: string
}

export interface NormalizeResult {
  pack: NormalizedPack
  issues: PackIssue[]
}

/** 暂存区里保存的双方快照：冲突时先留双方，选定后才写入 */
export interface ImportPayloads {
  mould?: OfflineMould
  fiberBatch?: OfflineBatch
  sheetRun?: OfflineRun
  paperSample?: OfflineSample
}

/** 本机台账对应记录的快照 */
export interface LocalSnapshots {
  mould?: Mould
  fiberBatch?: FiberBatch
  sheetRun?: SheetRun
  paperSample?: PaperSample
}

/** 合并视图：把业务引用翻译成人类可读的双方字段值 */
export interface MergeFieldView {
  field: string
  label: string
  local: string
  remote: string
  /** 派生字段（密度、偏差）由写入时重算，不参与分歧判定 */
  derived?: boolean
}

export interface MergeView {
  kind: ImportEntityKind
  businessNo: string
  status: MergeStatus
  fields: MergeFieldView[]
  /** 工序/样本上游缺失原因，如“纸帘 DL-09 不在包内也不在本机台账” */
  missingUpstreams: string[]
}

export type FieldSide = 'local' | 'remote'

/** 整包的处理阶段；写入失败保留 failed 批次，重试同一包继续原进度 */
export type ImportBatchStatus = 'review' | 'applying' | 'applied' | 'partial' | 'failed'

export interface ImportBatchStats {
  new: number
  identical: number
  conflict: number
  held: number
  applied: number
  total: number
}

export interface ImportBatchRecord {
  /** 归一化包内容的 SHA-256，用作包的稳定身份；同包重试不会另建批次 */
  batchId: string
  source: string
  packedAt: string
  fileName?: string
  status: ImportBatchStatus
  stats: ImportBatchStats
  error?: string
  createdAt: string
  updatedAt: string
}

/**
 * 暂存记录：每条包内实体一行。冲突时双方快照都留在这里，
 * 选定并写入后 applied=true；缺上游的工序/样本 held=true 暂存待处理。
 */
export interface ImportStagingRecord {
  id?: number
  /** `${kind}:${businessNo}`，同包内唯一 */
  key: string
  batchId: string
  kind: ImportEntityKind
  businessNo: string
  status: MergeStatus
  payloads: ImportPayloads
  local: LocalSnapshots
  /** 本机记录投影成业务编号形态后的快照，供双方并排比对 */
  localProjected?: ImportPayloads
  fields: MergeFieldView[]
  missingUpstreams: string[]
  /** 冲突记录的整侧选择；未选定前不允许写入 */
  chosenSide?: FieldSide
  /** 字段级选择，缺省跟随 chosenSide */
  fieldChoices?: Record<string, FieldSide>
  applied: boolean
  appliedAt?: string
  /** 缺上游暂存待处理 */
  held: boolean
  createdAt: string
  updatedAt: string
}

