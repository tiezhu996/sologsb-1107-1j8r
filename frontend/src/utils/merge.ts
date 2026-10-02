import { BLEACH_METHODS, COOK_AGENTS, FIBER_MATERIALS } from '../types/fiber-batch'
import type { FiberBatch } from '../types/fiber-batch'
import { MOULD_STATES, WIRE_MATERIALS } from '../types/mould'
import type { Mould } from '../types/mould'
import type {
  OfflinePackage,
  PackageFiberBatch,
  PackageMould,
  PackagePaperSample,
  PackageSheetRun,
} from '../types/offline-package'
import { EVENNESS_LEVELS } from '../types/paper-sample'
import { DRY_METHODS, STRIPE_DIRECTIONS } from '../types/sheet-run'
import { calculateMeshDensity } from './stripe'

/** 分歧比对字段：业务编号相同为前提，派生字段（网目密度、偏差）不参与比对，写入时重算。 */
const MOULD_COMPARE_FIELDS = ['frameW', 'frameH', 'wireMaterial', 'wireDiameter', 'stripeGap', 'weaver', 'state'] as const
const FIBER_COMPARE_FIELDS = ['material', 'origin', 'cookAgent', 'cookHours', 'bleachMethod', 'beatingDegree', 'operator'] as const

export const FIELD_LABELS: Record<string, string> = {
  mouldNo: '纸帘编号',
  frameW: '帘框宽 (cm)',
  frameH: '帘框高 (cm)',
  wireMaterial: '帘丝材质',
  wireDiameter: '丝径 (mm)',
  stripeGap: '帘纹间距 (mm)',
  meshDensity: '网目密度 (根/cm)',
  weaver: '编帘匠人',
  state: '状态',
  batchNo: '批次编号',
  material: '纤维原料',
  origin: '采收地',
  cookAgent: '蒸煮剂',
  cookHours: '蒸煮时长 (小时)',
  bleachMethod: '漂白方式',
  beatingDegree: '打浆度 (°SR)',
  operator: '操作人',
}

function fieldsDiffer(local: unknown, incoming: unknown): boolean {
  if (typeof local === 'number' && typeof incoming === 'number') {
    return Math.abs(local - incoming) > 1e-9
  }
  return local !== incoming
}

/** 返回本机与包内同号纸帘存在分歧的字段名；空数组表示两边一致。 */
export function diffMouldFields(local: Mould, incoming: PackageMould): string[] {
  return MOULD_COMPARE_FIELDS.filter((field) => fieldsDiffer(local[field], incoming[field]))
}

/** 返回本机与包内同号料批存在分歧的字段名；空数组表示两边一致。 */
export function diffFiberFields(local: FiberBatch, incoming: PackageFiberBatch): string[] {
  return FIBER_COMPARE_FIELDS.filter((field) => fieldsDiffer(local[field], incoming[field]))
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? ''
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

/** 包内容指纹：包内未标注 packageId 时用作幂等键。 */
export function fingerprintPackage(pkg: OfflinePackage): string {
  const text = stableStringify(pkg)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0').toUpperCase()
}

type RawRecord = Record<string, unknown>

function asRecord(value: unknown, context: string, errors: string[]): RawRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${context} 不是有效记录`)
    return {}
  }
  return value as RawRecord
}

function readString(record: RawRecord, key: string, context: string, errors: string[], required = true): string {
  const value = record[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (required) errors.push(`${context} 缺少 ${key}`)
  return ''
}

function readNumber(record: RawRecord, key: string, context: string, errors: string[]): number {
  const value = Number(record[key])
  if (!Number.isFinite(value)) {
    errors.push(`${context} 的 ${key} 不是有效数值`)
    return 0
  }
  return value
}

function readEnum<T extends string>(record: RawRecord, key: string, options: readonly T[], context: string, errors: string[]): T | '' {
  const value = record[key]
  if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T
  errors.push(`${context} 的 ${key} 取值无效（${String(value)}）`)
  return ''
}

function readArray(raw: RawRecord, key: string): unknown[] {
  const value = raw[key]
  return Array.isArray(value) ? value : []
}

/**
 * 解析并校验离线包。包内以业务编号认关系：
 * 源机的 id、mouldId、batchId、runId 等数字编号一律丢弃，不参与挂接。
 * 校验失败抛出中文错误信息。
 */
export function parseOfflinePackage(raw: unknown): OfflinePackage {
  const errors: string[] = []
  const root = asRecord(raw, '离线包', errors)
  const metaRaw = asRecord(root.meta ?? root, '离线包元信息', errors)

  const meta = {
    packageId: readString(metaRaw, 'packageId', '元信息', errors, false),
    packageName: readString(metaRaw, 'packageName', '元信息', errors, false) || '未命名离线包',
    exportedAt: readString(metaRaw, 'exportedAt', '元信息', errors, false) || new Date().toISOString(),
  }

  const moulds: PackageMould[] = readArray(root, 'moulds').map((item, index) => {
    const context = `纸帘[${index + 1}]`
    const record = asRecord(item, context, errors)
    const wireDiameter = readNumber(record, 'wireDiameter', context, errors)
    const stripeGap = readNumber(record, 'stripeGap', context, errors)
    return {
      mouldNo: readString(record, 'mouldNo', context, errors),
      frameW: readNumber(record, 'frameW', context, errors),
      frameH: readNumber(record, 'frameH', context, errors),
      wireMaterial: readEnum(record, 'wireMaterial', WIRE_MATERIALS, context, errors) || '竹丝',
      wireDiameter,
      stripeGap,
      meshDensity: calculateMeshDensity(wireDiameter, stripeGap),
      weaver: readString(record, 'weaver', context, errors),
      state: readEnum(record, 'state', MOULD_STATES, context, errors) || '在用',
      ...(typeof record.schemaRev === 'number' ? { schemaRev: record.schemaRev } : {}),
    }
  })

  const fiberBatches: PackageFiberBatch[] = readArray(root, 'fiberBatches').map((item, index) => {
    const context = `料批[${index + 1}]`
    const record = asRecord(item, context, errors)
    return {
      batchNo: readString(record, 'batchNo', context, errors),
      material: readEnum(record, 'material', FIBER_MATERIALS, context, errors) || '构皮',
      origin: readString(record, 'origin', context, errors),
      cookAgent: readEnum(record, 'cookAgent', COOK_AGENTS, context, errors) || '石灰',
      cookHours: readNumber(record, 'cookHours', context, errors),
      bleachMethod: readEnum(record, 'bleachMethod', BLEACH_METHODS, context, errors) || '日晒',
      beatingDegree: readNumber(record, 'beatingDegree', context, errors),
      operator: readString(record, 'operator', context, errors),
      ...(typeof record.schemaRev === 'number' ? { schemaRev: record.schemaRev } : {}),
    }
  })

  const sheetRuns: PackageSheetRun[] = readArray(root, 'sheetRuns').map((item, index) => {
    const context = `工序[${index + 1}]`
    const record = asRecord(item, context, errors)
    return {
      runNo: readString(record, 'runNo', context, errors),
      mouldNo: readString(record, 'mouldNo', context, errors, false),
      batchNo: readString(record, 'batchNo', context, errors, false),
      runDate: readString(record, 'runDate', context, errors),
      operator: readString(record, 'operator', context, errors),
      stripeDirection: readEnum(record, 'stripeDirection', STRIPE_DIRECTIONS, context, errors) || '竖帘纹',
      dipCount: readNumber(record, 'dipCount', context, errors),
      stackHeight: readNumber(record, 'stackHeight', context, errors),
      dryMethod: readEnum(record, 'dryMethod', DRY_METHODS, context, errors) || '火墙',
      grammage: readNumber(record, 'grammage', context, errors),
      measuredGap: readNumber(record, 'measuredGap', context, errors),
      ...(typeof record.schemaRev === 'number' ? { schemaRev: record.schemaRev } : {}),
    }
  })

  const paperSamples: PackagePaperSample[] = readArray(root, 'paperSamples').map((item, index) => {
    const context = `样本[${index + 1}]`
    const record = asRecord(item, context, errors)
    return {
      sampleNo: readString(record, 'sampleNo', context, errors),
      runNo: readString(record, 'runNo', context, errors, false),
      sizeMm: readNumber(record, 'sizeMm', context, errors),
      stripeCount: readNumber(record, 'stripeCount', context, errors),
      evenness: readEnum(record, 'evenness', EVENNESS_LEVELS, context, errors) || '均匀',
      archiveBin: readString(record, 'archiveBin', context, errors),
      ...(typeof record.schemaRev === 'number' ? { schemaRev: record.schemaRev } : {}),
    }
  })

  if (moulds.length + fiberBatches.length + sheetRuns.length + paperSamples.length === 0) {
    errors.push('包内没有可合并的纸帘、料批、工序或样本记录')
  }
  if (errors.length > 0) {
    const preview = errors.slice(0, 3).join('；')
    throw new Error(`离线包校验失败：${preview}${errors.length > 3 ? ` 等 ${errors.length} 处问题` : ''}`)
  }
  return { meta, moulds, fiberBatches, sheetRuns, paperSamples }
}

function daysAgoIso(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return date.toISOString().slice(0, 10)
}

/**
 * 构造示例离线包，覆盖全部合并路径：
 * 同号一致（重复）、同号分歧（待选定）、全新编号（直接建档）、
 * 上游待选定 / 上游缺失（暂存待处理），以及缺 schemaRev 的旧数据回填。
 */
export function buildSampleOfflinePackage(): OfflinePackage {
  return {
    meta: {
      packageId: 'PKG-SAMPLE-20261002',
      packageName: '石桥村作坊示例离线包',
      exportedAt: new Date().toISOString(),
    },
    moulds: [
      { mouldNo: 'DL-01', frameW: 60, frameH: 90, wireMaterial: '竹丝', wireDiameter: 0.3, stripeGap: 1.1, meshDensity: calculateMeshDensity(0.3, 1.1), weaver: '周守良', state: '在用', schemaRev: 2 },
      { mouldNo: 'DL-03', frameW: 72, frameH: 105, wireMaterial: '竹丝', wireDiameter: 0.28, stripeGap: 1.05, meshDensity: calculateMeshDensity(0.28, 1.05), weaver: '周守良', state: '在用' },
      { mouldNo: 'DL-11', frameW: 58, frameH: 88, wireMaterial: '铜丝', wireDiameter: 0.22, stripeGap: 0.9, meshDensity: calculateMeshDensity(0.22, 0.9), weaver: '沈云舟', state: '在用' },
    ],
    fiberBatches: [
      { batchNo: 'XW-2601', material: '构皮', origin: '陕西洋县华阳镇', cookAgent: '石灰', cookHours: 9, bleachMethod: '日晒', beatingDegree: 32, operator: '罗青禾', schemaRev: 2 },
      { batchNo: 'XW-2603', material: '竹麻', origin: '四川夹江马村镇', cookAgent: '石灰', cookHours: 11, bleachMethod: '漂白粉', beatingDegree: 29, operator: '郭文山' },
      { batchNo: 'XW-2611', material: '构皮', origin: '贵州丹寨石桥村', cookAgent: '石灰', cookHours: 8, bleachMethod: '日晒', beatingDegree: 33, operator: '罗青禾' },
    ],
    sheetRuns: [
      { runNo: 'CB-260801', mouldNo: 'DL-11', batchNo: 'XW-2611', runDate: daysAgoIso(2), operator: '罗青禾', stripeDirection: '竖帘纹', dipCount: 2, stackHeight: 40, dryMethod: '火墙', grammage: 33, measuredGap: 0.88 },
      { runNo: 'CB-260802', mouldNo: 'DL-03', batchNo: 'XW-2603', runDate: daysAgoIso(1), operator: '郭文山', stripeDirection: '横帘纹', dipCount: 2, stackHeight: 46, dryMethod: '日晒', grammage: 39, measuredGap: 1.04, schemaRev: 1 },
      { runNo: 'CB-260803', mouldNo: 'DL-99', batchNo: 'XW-2611', runDate: daysAgoIso(1), operator: '罗青禾', stripeDirection: '竖帘纹', dipCount: 1, stackHeight: 35, dryMethod: '火墙', grammage: 30, measuredGap: 0.95 },
    ],
    paperSamples: [
      { sampleNo: 'YZ-11', runNo: 'CB-260801', sizeMm: 210, stripeCount: 47, evenness: '均匀', archiveBin: '甲柜-15' },
      { sampleNo: 'YZ-12', runNo: 'CB-260802', sizeMm: 200, stripeCount: 41, evenness: '略花', archiveBin: '乙柜-08', schemaRev: 1 },
      { sampleNo: 'YZ-13', runNo: 'CB-260899', sizeMm: 220, stripeCount: 44, evenness: '均匀', archiveBin: '丙柜-04' },
    ],
  }
}
