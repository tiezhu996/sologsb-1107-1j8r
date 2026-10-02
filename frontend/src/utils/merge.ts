import type { FiberBatch } from '../types/fiber-batch'
import type { Mould } from '../types/mould'
import type { PaperSample } from '../types/paper-sample'
import type { SheetRun } from '../types/sheet-run'
import type {
  ImportEntityKind,
  LocalSnapshots,
  MergeFieldView,
  MergeStatus,
  MergeView,
  OfflineBatch,
  OfflineMould,
  OfflineRun,
  OfflineSample,
} from '../types/offline-pack'

/**
 * 分歧判定与合并视图。
 *
 * 同一业务编号两边都有记录时逐字段比对：完全一致记 identical，
 * 任一字段不同记 conflict 并保留双方取值。meshDensity、deviation
 * 是由丝径/间距推算的派生值，导入时统一按公式重算，不参与分歧判定。
 * 工序与样本只比较业务字段，不比较本机 mouldId/batchId/runId，
 * 那些编号本就只在各自机器上有意义。
 */

type FieldDef<T> = {
  field: keyof T & string
  label: string
  derived?: boolean
}

const MOULD_FIELDS: FieldDef<OfflineMould>[] = [
  { field: 'frameW', label: '帘框宽 (cm)' },
  { field: 'frameH', label: '帘框高 (cm)' },
  { field: 'wireMaterial', label: '帘丝材质' },
  { field: 'wireDiameter', label: '丝径 (mm)' },
  { field: 'stripeGap', label: '帘纹间距 (mm)' },
  { field: 'weaver', label: '编帘匠人' },
  { field: 'state', label: '状态' },
]

const BATCH_FIELDS: FieldDef<OfflineBatch>[] = [
  { field: 'material', label: '纤维原料' },
  { field: 'origin', label: '采收地' },
  { field: 'cookAgent', label: '蒸煮剂' },
  { field: 'cookHours', label: '蒸煮时长 (小时)' },
  { field: 'bleachMethod', label: '漂白方式' },
  { field: 'beatingDegree', label: '打浆度 (°SR)' },
  { field: 'operator', label: '操作人' },
]

const RUN_FIELDS: FieldDef<OfflineRun>[] = [
  { field: 'mouldNo', label: '纸帘编号' },
  { field: 'batchNo', label: '料批编号' },
  { field: 'runDate', label: '抄纸日期' },
  { field: 'operator', label: '操作人' },
  { field: 'stripeDirection', label: '帘纹方向' },
  { field: 'dipCount', label: '荡料次数' },
  { field: 'stackHeight', label: '叠高 (张)' },
  { field: 'dryMethod', label: '干燥方式' },
  { field: 'grammage', label: '克重 (g/m²)' },
  { field: 'measuredGap', label: '实测帘纹间距 (mm)' },
]

const SAMPLE_FIELDS: FieldDef<OfflineSample>[] = [
  { field: 'runNo', label: '工序编号' },
  { field: 'sizeMm', label: '样本尺寸 (mm)' },
  { field: 'stripeCount', label: '帘纹条数' },
  { field: 'evenness', label: '匀度' },
  { field: 'archiveBin', label: '存档位' },
]

export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

/** 把本机纸帘记录投影成离线包字段，便于并排比对 */
export function projectLocalMould(mould: Mould): OfflineMould {
  return {
    mouldNo: mould.mouldNo,
    frameW: mould.frameW,
    frameH: mould.frameH,
    wireMaterial: mould.wireMaterial,
    wireDiameter: mould.wireDiameter,
    stripeGap: mould.stripeGap,
    weaver: mould.weaver,
    state: mould.state,
  }
}

export function projectLocalBatch(batch: FiberBatch): OfflineBatch {
  return {
    batchNo: batch.batchNo,
    material: batch.material,
    origin: batch.origin,
    cookAgent: batch.cookAgent,
    cookHours: batch.cookHours,
    bleachMethod: batch.bleachMethod,
    beatingDegree: batch.beatingDegree,
    operator: batch.operator,
  }
}

/**
 * 工序投影时把本机数字外键翻译回业务编号；上游记录缺失时给出空串，
 * 调用方据此判断“缺上游”。
 */
export function projectLocalRun(
  run: SheetRun,
  mouldByNo: Map<number, string>,
  batchByNo: Map<number, string>,
): OfflineRun {
  return {
    runNo: run.runNo,
    mouldNo: mouldByNo.get(run.mouldId) ?? '',
    batchNo: batchByNo.get(run.batchId) ?? '',
    runDate: run.runDate,
    operator: run.operator,
    stripeDirection: run.stripeDirection,
    dipCount: run.dipCount,
    stackHeight: run.stackHeight,
    dryMethod: run.dryMethod,
    grammage: run.grammage,
    measuredGap: run.measuredGap,
  }
}

export function projectLocalSample(sample: PaperSample, runByNo: Map<number, string>): OfflineSample {
  return {
    sampleNo: sample.sampleNo,
    runNo: runByNo.get(sample.runId) ?? '',
    sizeMm: sample.sizeMm,
    stripeCount: sample.stripeCount,
    evenness: sample.evenness,
    archiveBin: sample.archiveBin,
  }
}

function buildFields<T>(defs: FieldDef<T>[], local: T | undefined, remote: T): MergeFieldView[] {
  return defs.map((def) => ({
    field: def.field,
    label: def.label,
    local: local ? displayValue(local[def.field]) : '',
    remote: displayValue(remote[def.field]),
    derived: def.derived,
  }))
}

export function buildMouldView(remote: OfflineMould, local: Mould | undefined): MergeView {
  const localProjection = local ? projectLocalMould(local) : undefined
  return finalizeView('mould', remote.mouldNo, buildFields(MOULD_FIELDS, localProjection, remote), Boolean(local))
}

export function buildBatchView(remote: OfflineBatch, local: FiberBatch | undefined): MergeView {
  const localProjection = local ? projectLocalBatch(local) : undefined
  return finalizeView('fiberBatch', remote.batchNo, buildFields(BATCH_FIELDS, localProjection, remote), Boolean(local))
}

export function buildRunView(remote: OfflineRun, localProjected: OfflineRun | undefined, missingUpstreams: string[] = []): MergeView {
  return finalizeView('sheetRun', remote.runNo, buildFields(RUN_FIELDS, localProjected, remote), Boolean(localProjected), missingUpstreams)
}

export function buildSampleView(remote: OfflineSample, localProjected: OfflineSample | undefined, missingUpstreams: string[] = []): MergeView {
  return finalizeView('paperSample', remote.sampleNo, buildFields(SAMPLE_FIELDS, localProjected, remote), Boolean(localProjected), missingUpstreams)
}

function finalizeView(
  kind: ImportEntityKind,
  businessNo: string,
  fields: MergeFieldView[],
  existsLocally: boolean,
  missingUpstreams: string[] = [],
): MergeView {
  let status: MergeStatus = 'new'
  if (existsLocally) {
    const hasConflict = fields.some((field) => !field.derived && field.local !== field.remote)
    status = hasConflict ? 'conflict' : 'identical'
  }
  return { kind, businessNo, status, fields, missingUpstreams }
}

export function kindLabel(kind: ImportEntityKind): string {
  switch (kind) {
    case 'mould':
      return '纸帘'
    case 'fiberBatch':
      return '纤维料批'
    case 'sheetRun':
      return '抄纸工序'
    case 'paperSample':
      return '成纸样本'
  }
}

/** 按字段级选择合成一条纸帘：未覆盖的字段沿用对方取值 */
export function mergeMouldFields(
  local: OfflineMould,
  remote: OfflineMould,
  chosen: Record<string, 'local' | 'remote'>,
): OfflineMould {
  const result = { ...remote }
  for (const def of MOULD_FIELDS) {
    if (chosen[def.field] === 'local') {
      ;(result as Record<string, unknown>)[def.field] = local[def.field]
    }
  }
  return result
}

export function mergeBatchFields(
  local: OfflineBatch,
  remote: OfflineBatch,
  chosen: Record<string, 'local' | 'remote'>,
): OfflineBatch {
  const result = { ...remote }
  for (const def of BATCH_FIELDS) {
    if (chosen[def.field] === 'local') {
      ;(result as Record<string, unknown>)[def.field] = local[def.field]
    }
  }
  return result
}

export function mergeRunFields(
  local: OfflineRun,
  remote: OfflineRun,
  chosen: Record<string, 'local' | 'remote'>,
): OfflineRun {
  const result = { ...remote }
  for (const def of RUN_FIELDS) {
    if (chosen[def.field] === 'local') {
      ;(result as Record<string, unknown>)[def.field] = local[def.field]
    }
  }
  return result
}

export function mergeSampleFields(
  local: OfflineSample,
  remote: OfflineSample,
  chosen: Record<string, 'local' | 'remote'>,
): OfflineSample {
  const result = { ...remote }
  for (const def of SAMPLE_FIELDS) {
    if (chosen[def.field] === 'local') {
      ;(result as Record<string, unknown>)[def.field] = local[def.field]
    }
  }
  return result
}

export const MERGE_FIELDS = {
  mould: MOULD_FIELDS,
  fiberBatch: BATCH_FIELDS,
  sheetRun: RUN_FIELDS,
  paperSample: SAMPLE_FIELDS,
}

export type StagingSnapshots = LocalSnapshots
