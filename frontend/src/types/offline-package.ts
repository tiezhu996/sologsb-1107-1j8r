import type { FiberBatchInput } from './fiber-batch'
import type { MouldInput } from './mould'
import type { EvennessLevel } from './paper-sample'
import type { DryMethod, StripeDirection } from './sheet-run'

/** 离线包元信息。packageId 是整包幂等键：重试同一包不重复建档。 */
export interface OfflinePackageMeta {
  packageId: string
  packageName: string
  exportedAt: string
}

/** 包内纸帘：不带本机 id；旧包可能缺 schemaRev，首次导入时回填当前版本。 */
export type PackageMould = MouldInput & { schemaRev?: number }

/** 包内料批：同上，按批次编号认关系。 */
export type PackageFiberBatch = FiberBatchInput & { schemaRev?: number }

/**
 * 包内抄纸工序：以纸帘、料批的业务编号认关系。
 * 源机的 mouldId / batchId 等数字编号一律不采信，解析时已丢弃。
 */
export interface PackageSheetRun {
  runNo: string
  mouldNo: string
  batchNo: string
  runDate: string
  operator: string
  stripeDirection: StripeDirection
  dipCount: number
  stackHeight: number
  dryMethod: DryMethod
  grammage: number
  measuredGap: number
  schemaRev?: number
}

/** 包内成纸样本：以工序业务编号 runNo 认关系。 */
export interface PackagePaperSample {
  sampleNo: string
  runNo: string
  sizeMm: number
  stripeCount: number
  evenness: EvennessLevel
  archiveBin: string
  schemaRev?: number
}

export interface OfflinePackage {
  meta: OfflinePackageMeta
  moulds: PackageMould[]
  fiberBatches: PackageFiberBatch[]
  sheetRuns: PackageSheetRun[]
  paperSamples: PackagePaperSample[]
}

export const IMPORT_BATCH_STATUSES = ['合并中', '待选定', '部分合并', '已合并', '写入失败'] as const
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number]

export interface PhaseProgress {
  total: number
  created: number
  duplicates: number
  conflicts: number
  pending: number
}

export interface ImportProgress {
  moulds: PhaseProgress
  fiberBatches: PhaseProgress
  sheetRuns: PhaseProgress
  paperSamples: PhaseProgress
}

/** 导入批次：整包写入失败后保留本行与进度，重试时按业务编号去重。 */
export interface ImportBatch {
  id?: number
  packageId: string
  packageName: string
  importedAt: string
  updatedAt: string
  status: ImportBatchStatus
  progress: ImportProgress
  error: string | null
  /** 包快照，供失败重试与暂存重挂使用，无需重新选择文件。 */
  snapshot: OfflinePackage
  schemaRev?: number
}

export type ConflictEntity = 'mould' | 'fiberBatch'

export const CONFLICT_RESOLUTIONS = ['保留本机', '采纳包内'] as const
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number]

/** 同号分歧：两边值都留底，选定后才写入台账。 */
export interface MergeConflict {
  id?: number
  batchId: number
  entity: ConflictEntity
  bizNo: string
  localRecord: Record<string, unknown>
  incomingRecord: Record<string, unknown>
  diffFields: string[]
  status: '待选定' | '已选定'
  resolution?: ConflictResolution
  resolvedAt?: string
  schemaRev?: number
}

export type PendingEntity = 'sheetRun' | 'paperSample'

/** 缺上游的工序 / 样本暂存：上游就位（选定分歧或补登记）后重新挂接。 */
export interface PendingLink {
  id?: number
  batchId: number
  entity: PendingEntity
  bizNo: string
  payload: PackageSheetRun | PackagePaperSample
  missing: string[]
  status: '待处理' | '已挂接'
  linkedAt?: string
  schemaRev?: number
}
