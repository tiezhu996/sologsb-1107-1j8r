import { BLEACH_METHODS, COOK_AGENTS, FIBER_MATERIALS } from '../types/fiber-batch'
import { MOULD_STATES, WIRE_MATERIALS } from '../types/mould'
import { EVENNESS_LEVELS } from '../types/paper-sample'
import { DRY_METHODS, STRIPE_DIRECTIONS } from '../types/sheet-run'
import {
  OFFLINE_PACK_FORMAT,
  type ImportEntityKind,
  type NormalizedPack,
  type OfflineBatch,
  type OfflineMould,
  type OfflinePack,
  type OfflineRun,
  type OfflineSample,
  type PackIssue,
} from '../types/offline-pack'

/**
 * 离线包解析与校验。包内只承认业务编号，解析阶段不接触本机 id。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function asEnum<T extends readonly string[]>(value: unknown, options: T): T[number] | undefined {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? value : undefined
}

function asDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const time = Date.parse(`${value}T00:00:00`)
  return Number.isNaN(time) ? undefined : value
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

interface FieldRule<T> {
  field: keyof T & string
  read: (raw: Record<string, unknown>) => unknown
}

function validateEntity<T>(
  kind: ImportEntityKind,
  businessNo: string,
  raw: Record<string, unknown>,
  rules: FieldRule<T>[],
  issues: PackIssue[],
): T | undefined {
  const entity: Record<string, unknown> = {}
  for (const rule of rules) {
    const value = rule.read(raw)
    if (value === undefined) {
      issues.push({ kind, businessNo: businessNo || '?', reason: `字段 ${rule.field} 缺失或不合法` })
      return undefined
    }
    entity[rule.field] = value
  }
  return entity as T
}

function dedupe<T extends { [K in N]: string }, N extends keyof T>(
  kind: ImportEntityKind,
  keyName: N,
  list: T[],
  issues: PackIssue[],
): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const item of list) {
    const key = item[keyName]
    if (seen.has(key)) {
      issues.push({ kind, businessNo: key, reason: '包内业务编号重复，已保留第一条' })
      continue
    }
    seen.add(key)
    result.push(item)
  }
  return result
}

export function parseOfflinePack(text: string): { pack: NormalizedPack; issues: PackIssue[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('文件不是合法 JSON，请确认离线包未损坏')
  }
  if (!isRecord(parsed)) throw new Error('离线包结构不合法：根节点应为对象')
  const raw = parsed as OfflinePack & Record<string, unknown>
  if (raw.format !== OFFLINE_PACK_FORMAT) {
    throw new Error(`离线包格式不符：期望 ${OFFLINE_PACK_FORMAT}，收到 ${String(raw.format ?? '缺失')}`)
  }

  const issues: PackIssue[] = []

  const moulds: OfflineMould[] = []
  for (const item of arrayOfRecords(raw.moulds)) {
    const mouldNo = asString(item.mouldNo)
    if (!mouldNo) {
      issues.push({ kind: 'mould', businessNo: '?', reason: '缺少纸帘编号 mouldNo' })
      continue
    }
    const entity = validateEntity<Omit<OfflineMould, 'mouldNo'>>('mould', mouldNo, item, [
      { field: 'frameW', read: (v) => asNumber(v.frameW) },
      { field: 'frameH', read: (v) => asNumber(v.frameH) },
      { field: 'wireMaterial', read: (v) => asEnum(v.wireMaterial, WIRE_MATERIALS) },
      { field: 'wireDiameter', read: (v) => asNumber(v.wireDiameter) },
      { field: 'stripeGap', read: (v) => asNumber(v.stripeGap) },
      { field: 'weaver', read: (v) => asString(v.weaver) },
      { field: 'state', read: (v) => asEnum(v.state, MOULD_STATES) },
    ], issues)
    if (entity) moulds.push({ mouldNo, ...entity })
  }

  const fiberBatches: OfflineBatch[] = []
  for (const item of arrayOfRecords(raw.fiberBatches)) {
    const batchNo = asString(item.batchNo)
    if (!batchNo) {
      issues.push({ kind: 'fiberBatch', businessNo: '?', reason: '缺少料批编号 batchNo' })
      continue
    }
    const entity = validateEntity<Omit<OfflineBatch, 'batchNo'>>('fiberBatch', batchNo, item, [
      { field: 'material', read: (v) => asEnum(v.material, FIBER_MATERIALS) },
      { field: 'origin', read: (v) => asString(v.origin) },
      { field: 'cookAgent', read: (v) => asEnum(v.cookAgent, COOK_AGENTS) },
      { field: 'cookHours', read: (v) => asNumber(v.cookHours) },
      { field: 'bleachMethod', read: (v) => asEnum(v.bleachMethod, BLEACH_METHODS) },
      { field: 'beatingDegree', read: (v) => asNumber(v.beatingDegree) },
      { field: 'operator', read: (v) => asString(v.operator) },
    ], issues)
    if (entity) fiberBatches.push({ batchNo, ...entity })
  }

  const sheetRuns: OfflineRun[] = []
  for (const item of arrayOfRecords(raw.sheetRuns)) {
    const runNo = asString(item.runNo)
    if (!runNo) {
      issues.push({ kind: 'sheetRun', businessNo: '?', reason: '缺少工序编号 runNo' })
      continue
    }
    const entity = validateEntity<Omit<OfflineRun, 'runNo'>>('sheetRun', runNo, item, [
      { field: 'mouldNo', read: (v) => asString(v.mouldNo) },
      { field: 'batchNo', read: (v) => asString(v.batchNo) },
      { field: 'runDate', read: (v) => asDate(v.runDate) },
      { field: 'operator', read: (v) => asString(v.operator) },
      { field: 'stripeDirection', read: (v) => asEnum(v.stripeDirection, STRIPE_DIRECTIONS) },
      { field: 'dipCount', read: (v) => asNumber(v.dipCount) },
      { field: 'stackHeight', read: (v) => asNumber(v.stackHeight) },
      { field: 'dryMethod', read: (v) => asEnum(v.dryMethod, DRY_METHODS) },
      { field: 'grammage', read: (v) => asNumber(v.grammage) },
      { field: 'measuredGap', read: (v) => asNumber(v.measuredGap) },
    ], issues)
    if (entity) sheetRuns.push({ runNo, ...entity })
  }

  const paperSamples: OfflineSample[] = []
  for (const item of arrayOfRecords(raw.paperSamples)) {
    const sampleNo = asString(item.sampleNo)
    if (!sampleNo) {
      issues.push({ kind: 'paperSample', businessNo: '?', reason: '缺少样本编号 sampleNo' })
      continue
    }
    const entity = validateEntity<Omit<OfflineSample, 'sampleNo'>>('paperSample', sampleNo, item, [
      { field: 'runNo', read: (v) => asString(v.runNo) },
      { field: 'sizeMm', read: (v) => asNumber(v.sizeMm) },
      { field: 'stripeCount', read: (v) => asNumber(v.stripeCount) },
      { field: 'evenness', read: (v) => asEnum(v.evenness, EVENNESS_LEVELS) },
      { field: 'archiveBin', read: (v) => asString(v.archiveBin) },
    ], issues)
    if (entity) paperSamples.push({ sampleNo, ...entity })
  }

  const dedupedMoulds = dedupe('mould', 'mouldNo', moulds, issues)
  const dedupedBatches = dedupe('fiberBatch', 'batchNo', fiberBatches, issues)
  const dedupedRuns = dedupe('sheetRun', 'runNo', sheetRuns, issues)
  const dedupedSamples = dedupe('paperSample', 'sampleNo', paperSamples, issues)

  return {
    pack: {
      source: asString(raw.source) ?? '外作坊离线包',
      packedAt: asString(raw.packedAt) ?? '',
      moulds: dedupedMoulds,
      fiberBatches: dedupedBatches,
      sheetRuns: dedupedRuns,
      paperSamples: dedupedSamples,
    },
    issues,
  }
}

/** 稳定序列化：键排序，保证同一包内容算出同一身份 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function fallbackHash(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  }
  return `local-${hash.toString(16).padStart(8, '0')}`
}

/** 以归一化后的包内容计算稳定身份，重试同一包不会另建批次 */
export async function computePackId(pack: NormalizedPack): Promise<string> {
  const canonical = stableStringify(pack)
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  }
  return fallbackHash(canonical)
}
