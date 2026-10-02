import type { FiberBatch } from '../types/fiber-batch'
import type {
  FieldSide,
  ImportBatchRecord,
  ImportBatchStats,
  ImportStagingRecord,
  NormalizedPack,
  OfflineBatch,
  OfflineMould,
  OfflineRun,
  OfflineSample,
  PackIssue,
} from '../types/offline-pack'
import { db, plain } from './db'
import {
  buildBatchView,
  buildMouldView,
  buildRunView,
  buildSampleView,
  mergeBatchFields,
  mergeMouldFields,
  mergeRunFields,
  mergeSampleFields,
  projectLocalBatch,
  projectLocalMould,
  projectLocalRun,
  projectLocalSample,
} from './merge'
import { computePackId, parseOfflinePack } from './offline-pack'
import { calculateDeviation, calculateMeshDensity } from './stripe'

/**
 * 离线包合并服务。
 *
 * 关系一律按业务编号解析，绝不使用包内的本机数字编号：
 * 工序写入时用 mouldNo/batchNo 现查纸帘与料批的本机 id，
 * 样本写入时用 runNo 现查工序 id。上游换成选中的版本后，
 * 下游在写入/重试时自然重新挂接；上游还没有着落的记录暂存待处理。
 *
 * 写入按实体逐条事务提交并以业务编号 upsert：整包中途失败时
 * 已写入的进度保留，重试同一包跳过 applied 记录、不重复建档。
 */

const SCHEMA_REV = 3
const KIND_ORDER = { mould: 0, fiberBatch: 1, sheetRun: 2, paperSample: 3 } as const

export interface IntakeOutcome {
  batch: ImportBatchRecord
  created: boolean
  issues: PackIssue[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function upstreamLabels(run: { mouldNo: string; batchNo: string }, hasMould: boolean, hasBatch: boolean): string[] {
  const labels: string[] = []
  if (!hasMould) labels.push(`纸帘 ${run.mouldNo} 既不在包内也不在本机台账`)
  if (!hasBatch) labels.push(`料批 ${run.batchNo} 既不在包内也不在本机台账`)
  return labels
}

function buildStats(staging: ImportStagingRecord[]): ImportBatchStats {
  const stats: ImportBatchStats = { new: 0, identical: 0, conflict: 0, held: 0, applied: 0, total: staging.length }
  for (const record of staging) {
    stats[record.status] += 1
    if (record.applied) stats.applied += 1
    if (!record.applied && record.missingUpstreams.length > 0) stats.held += 1
  }
  return stats
}

/** 读入离线包，逐条与本机台账比对并落入暂存区；同一包内容只建一个批次 */
export async function intakePack(fileName: string, text: string): Promise<IntakeOutcome> {
  const { pack, issues } = parseOfflinePack(text)
  const batchId = await computePackId(pack)

  const existing = await db.importBatches.get(batchId)
  if (existing) {
    return { batch: existing, created: false, issues }
  }

  const [localMoulds, localBatches, localRuns, localSamples] = await Promise.all([
    db.moulds.toArray(),
    db.fiberBatches.toArray(),
    db.sheetRuns.toArray(),
    db.paperSamples.toArray(),
  ])

  const mouldByNo = new Map(localMoulds.map((mould) => [mould.mouldNo, mould]))
  const batchByNo = new Map(localBatches.map((batch) => [batch.batchNo, batch]))
  const runByNo = new Map(localRuns.map((run) => [run.runNo, run]))

  const mouldIdToNo = new Map(localMoulds.filter((mould) => mould.id !== undefined).map((mould) => [mould.id as number, mould.mouldNo]))
  const batchIdToNo = new Map(localBatches.filter((batch) => batch.id !== undefined).map((batch) => [batch.id as number, batch.batchNo]))
  const runIdToNo = new Map(localRuns.filter((run) => run.id !== undefined).map((run) => [run.id as number, run.runNo]))

  const packMouldNos = new Set(pack.moulds.map((mould) => mould.mouldNo))
  const packBatchNos = new Set(pack.fiberBatches.map((batch) => batch.batchNo))
  const packRunNos = new Set(pack.sheetRuns.map((run) => run.runNo))

  const timestamp = nowIso()
  const staging: ImportStagingRecord[] = []
  const pushStaging = (
    kind: ImportStagingRecord['kind'],
    businessNo: string,
    status: ImportStagingRecord['status'],
    fields: ImportStagingRecord['fields'],
    payloads: ImportStagingRecord['payloads'],
    local: ImportStagingRecord['local'],
    localProjected: ImportStagingRecord['localProjected'],
    missingUpstreams: string[] = [],
  ) => {
    staging.push({
      key: `${batchId}:${kind}:${businessNo}`,
      batchId,
      kind,
      businessNo,
      status,
      payloads: plain(payloads),
      local: plain(local),
      localProjected: plain(localProjected),
      fields,
      missingUpstreams,
      applied: false,
      held: missingUpstreams.length > 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  }

  for (const remote of pack.moulds) {
    const local = mouldByNo.get(remote.mouldNo)
    const view = buildMouldView(remote, local)
    pushStaging(
      'mould',
      remote.mouldNo,
      view.status,
      view.fields,
      { mould: remote },
      local ? { mould: local } : {},
      local ? { mould: projectLocalMould(local) } : {},
    )
  }

  for (const remote of pack.fiberBatches) {
    const local = batchByNo.get(remote.batchNo)
    const view = buildBatchView(remote, local)
    pushStaging(
      'fiberBatch',
      remote.batchNo,
      view.status,
      view.fields,
      { fiberBatch: remote },
      local ? { fiberBatch: local } : {},
      local ? { fiberBatch: projectLocalBatch(local) } : {},
    )
  }

  for (const remote of pack.sheetRuns) {
    const local = runByNo.get(remote.runNo)
    const localProjected = local ? projectLocalRun(local, mouldIdToNo, batchIdToNo) : undefined
    const hasMould = mouldByNo.has(remote.mouldNo) || packMouldNos.has(remote.mouldNo)
    const hasBatch = batchByNo.has(remote.batchNo) || packBatchNos.has(remote.batchNo)
    const missing = upstreamLabels(remote, hasMould, hasBatch)
    const view = buildRunView(remote, localProjected, missing)
    pushStaging(
      'sheetRun',
      remote.runNo,
      view.status,
      view.fields,
      { sheetRun: remote },
      local ? { sheetRun: local } : {},
      localProjected ? { sheetRun: localProjected } : {},
      missing,
    )
  }

  for (const remote of pack.paperSamples) {
    const local = localSamples.find((sample) => sample.sampleNo === remote.sampleNo)
    const localProjected = local ? projectLocalSample(local, runIdToNo) : undefined
    const missing = runByNo.has(remote.runNo) || packRunNos.has(remote.runNo)
      ? []
      : [`工序 ${remote.runNo} 既不在包内也不在本机台账`]
    const view = buildSampleView(remote, localProjected, missing)
    pushStaging(
      'paperSample',
      remote.sampleNo,
      view.status,
      view.fields,
      { paperSample: remote },
      local ? { paperSample: local } : {},
      localProjected ? { paperSample: localProjected } : {},
      missing,
    )
  }

  staging.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.businessNo.localeCompare(b.businessNo))

  const batch: ImportBatchRecord = {
    batchId,
    source: pack.source,
    packedAt: pack.packedAt,
    fileName,
    status: 'review',
    stats: buildStats(staging),
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  await db.transaction('rw', db.importBatches, db.importStaging, async () => {
    // 并发重复导入同一包时，唯一键会让其中一方整笔回滚
    await db.importBatches.add(plain(batch))
    await db.importStaging.bulkAdd(plain(staging))
  })

  return { batch, created: true, issues }
}

export async function listBatches(): Promise<ImportBatchRecord[]> {
  return db.importBatches.orderBy('updatedAt').reverse().toArray()
}

export async function listStaging(batchId: string): Promise<ImportStagingRecord[]> {
  const rows = await db.importStaging.where('batchId').equals(batchId).toArray()
  return rows.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.businessNo.localeCompare(b.businessNo))
}

export async function setChosenSide(batchId: string, key: string, side: FieldSide): Promise<void> {
  await db.transaction('rw', db.importStaging, db.importBatches, async () => {
    const record = await db.importStaging.where('key').equals(key).first()
    if (!record || record.batchId !== batchId || record.applied) return
    record.chosenSide = side
    // 整侧选择覆盖此前的逐字段挑选
    record.fieldChoices = undefined
    record.updatedAt = nowIso()
    await db.importStaging.put(record)
    await touchBatch(batchId)
  })
}

export async function setFieldChoice(batchId: string, key: string, field: string, side: FieldSide): Promise<void> {
  await db.transaction('rw', db.importStaging, db.importBatches, async () => {
    const record = await db.importStaging.where('key').equals(key).first()
    if (!record || record.batchId !== batchId || record.applied) return
    record.fieldChoices = { ...(record.fieldChoices ?? {}), [field]: side }
    record.chosenSide = 'remote'
    record.updatedAt = nowIso()
    await db.importStaging.put(record)
    await touchBatch(batchId)
  })
}

async function touchBatch(batchId: string): Promise<void> {
  const batch = await db.importBatches.get(batchId)
  if (batch) {
    batch.updatedAt = nowIso()
    if (batch.status === 'applied' || batch.status === 'applying') batch.status = 'partial'
    await db.importBatches.put(batch)
  }
}

function effectiveChoices(record: ImportStagingRecord): Record<string, FieldSide> {
  const base = record.chosenSide ?? 'remote'
  const result: Record<string, FieldSide> = {}
  for (const field of record.fields) {
    result[field.field] = record.fieldChoices?.[field.field] ?? base
  }
  return result
}

function effectiveMould(record: ImportStagingRecord): OfflineMould {
  const remote = record.payloads.mould!
  if (record.status === 'conflict' && record.localProjected?.mould) {
    return mergeMouldFields(record.localProjected.mould, remote, effectiveChoices(record))
  }
  return remote
}

function effectiveBatch(record: ImportStagingRecord): OfflineBatch {
  const remote = record.payloads.fiberBatch!
  if (record.status === 'conflict' && record.localProjected?.fiberBatch) {
    return mergeBatchFields(record.localProjected.fiberBatch, remote, effectiveChoices(record))
  }
  return remote
}

function effectiveRun(record: ImportStagingRecord): OfflineRun {
  const remote = record.payloads.sheetRun!
  if (record.status === 'conflict' && record.localProjected?.sheetRun) {
    return mergeRunFields(record.localProjected.sheetRun, remote, effectiveChoices(record))
  }
  return remote
}

function effectiveSample(record: ImportStagingRecord): OfflineSample {
  const remote = record.payloads.paperSample!
  if (record.status === 'conflict' && record.localProjected?.paperSample) {
    return mergeSampleFields(record.localProjected.paperSample, remote, effectiveChoices(record))
  }
  return remote
}

/** 单条实体一个事务：失败只回滚这一条，其余已写入进度保留 */
async function writeOne(record: ImportStagingRecord): Promise<'applied' | 'held' | 'awaiting-choice'> {
  return db.transaction('rw', db.moulds, db.fiberBatches, db.sheetRuns, db.paperSamples, db.importStaging, async () => {
    const [moulds, batches, runs, samples] = await Promise.all([
      db.moulds.toArray(),
      db.fiberBatches.toArray(),
      db.sheetRuns.toArray(),
      db.paperSamples.toArray(),
    ])
    const mouldByNo = new Map(moulds.map((mould) => [mould.mouldNo, mould]))
    const batchByNo = new Map(batches.map((batch) => [batch.batchNo, batch]))
    const runByNo = new Map(runs.map((run) => [run.runNo, run]))
    const sampleByNo = new Map(samples.map((sample) => [sample.sampleNo, sample]))

    if (record.kind === 'mould') {
      if (record.status === 'conflict' && !record.chosenSide && !record.fieldChoices) return 'awaiting-choice'
      const merged = effectiveMould(record)
      const meshDensity = calculateMeshDensity(merged.wireDiameter, merged.stripeGap)
      const existing = mouldByNo.get(merged.mouldNo)
      if (existing?.id !== undefined) {
        await db.moulds.update(existing.id, { ...merged, meshDensity, schemaRev: SCHEMA_REV })
      } else {
        await db.moulds.add({ ...merged, meshDensity, schemaRev: SCHEMA_REV })
      }
      await markApplied(record)
      return 'applied'
    }

    if (record.kind === 'fiberBatch') {
      if (record.status === 'conflict' && !record.chosenSide && !record.fieldChoices) return 'awaiting-choice'
      const merged = effectiveBatch(record)
      const existing = batchByNo.get(merged.batchNo)
      if (existing?.id !== undefined) {
        await db.fiberBatches.update(existing.id, { ...merged, schemaRev: SCHEMA_REV })
      } else {
        await db.fiberBatches.add({ ...merged, schemaRev: SCHEMA_REV })
      }
      await markApplied(record)
      return 'applied'
    }

    if (record.kind === 'sheetRun') {
      if (record.status === 'conflict' && !record.chosenSide && !record.fieldChoices) return 'awaiting-choice'
      const merged = effectiveRun(record)
      const mould = mouldByNo.get(merged.mouldNo)
      const batch = batchByNo.get(merged.batchNo)
      const missing = upstreamLabels(merged, Boolean(mould), Boolean(batch))
      if (missing.length > 0) {
        record.missingUpstreams = missing
        record.held = true
        record.updatedAt = nowIso()
        await db.importStaging.put(record)
        return 'held'
      }
      const deviation = calculateDeviation(merged.measuredGap, mould!.stripeGap)
      const values = {
        mouldId: mould!.id!,
        batchId: batch!.id!,
        runDate: merged.runDate,
        operator: merged.operator,
        stripeDirection: merged.stripeDirection,
        dipCount: merged.dipCount,
        stackHeight: merged.stackHeight,
        dryMethod: merged.dryMethod,
        grammage: merged.grammage,
        measuredGap: merged.measuredGap,
        deviation,
        schemaRev: SCHEMA_REV,
      }
      const existing = runByNo.get(merged.runNo)
      if (existing?.id !== undefined) {
        // 跟着选中的纸帘/料批重新挂接
        await db.sheetRuns.update(existing.id, values)
      } else {
        await db.sheetRuns.add({ runNo: merged.runNo, ...values })
      }
      await markApplied(record)
      return 'applied'
    }

    // paperSample
    if (record.status === 'conflict' && !record.chosenSide && !record.fieldChoices) return 'awaiting-choice'
    const merged = effectiveSample(record)
    const upstreamRun = runByNo.get(merged.runNo)
    if (!upstreamRun) {
      record.missingUpstreams = [`工序 ${merged.runNo} 既不在包内也不在本机台账`]
      record.held = true
      record.updatedAt = nowIso()
      await db.importStaging.put(record)
      return 'held'
    }
    const values = {
      runId: upstreamRun.id!,
      sizeMm: merged.sizeMm,
      stripeCount: merged.stripeCount,
      evenness: merged.evenness,
      archiveBin: merged.archiveBin,
      schemaRev: SCHEMA_REV,
    }
    const existing = sampleByNo.get(merged.sampleNo)
    if (existing?.id !== undefined) {
      await db.paperSamples.update(existing.id, values)
    } else {
      await db.paperSamples.add({ sampleNo: merged.sampleNo, ...values })
    }
    await markApplied(record)
    return 'applied'
  })
}

async function markApplied(record: ImportStagingRecord): Promise<void> {
  record.applied = true
  record.appliedAt = nowIso()
  record.held = false
  record.missingUpstreams = []
  record.updatedAt = record.appliedAt
  await db.importStaging.put(record)
}

export interface ApplySummary {
  status: ImportBatchRecord['status']
  applied: number
  held: number
  awaitingChoice: number
  errors: string[]
  batch: ImportBatchRecord
}

/**
 * 写入整包：按纸帘 → 料批 → 工序 → 样本顺序逐条提交，
 * 后写的下游总能拿到本轮刚写入的上游 id。失败后批次与进度保留，
 * 重试时 applied 记录直接跳过。
 */
export async function applyBatch(batchId: string): Promise<ApplySummary> {
  const batch = await db.importBatches.get(batchId)
  if (!batch) throw new Error('导入批次不存在')

  await db.importBatches.update(batchId, { status: 'applying', updatedAt: nowIso() })

  const staging = await listStaging(batchId)
  const errors: string[] = []
  let applied = 0
  let held = 0
  let awaitingChoice = 0

  for (const record of staging) {
    if (record.applied) {
      applied += 1
      continue
    }
    try {
      const outcome = await writeOne(record)
      if (outcome === 'applied') applied += 1
      else if (outcome === 'held') held += 1
      else awaitingChoice += 1
    } catch (error) {
      errors.push(`${record.businessNo}：${error instanceof Error ? error.message : '写入失败'}`)
    }
  }

  const finalStaging = await listStaging(batchId)
  const stats = buildStats(finalStaging)
  const stillPending = stats.total - stats.applied
  const updated = await db.transaction('rw', db.importBatches, async () => {
    const current = await db.importBatches.get(batchId)
    if (!current) throw new Error('导入批次不存在')
    current.stats = stats
    current.updatedAt = nowIso()
    current.error = errors.length ? errors.join('；') : undefined
    if (stillPending === 0 && errors.length === 0) {
      current.status = 'applied'
    } else if (stats.applied === 0 && errors.length > 0) {
      current.status = 'failed'
    } else {
      current.status = 'partial'
    }
    await db.importBatches.put(current)
    return current
  })

  held = stats.held
  return { status: updated.status, applied: stats.applied, held, awaitingChoice, errors, batch: updated }
}

/** 丢弃批次只清理暂存区与批次记录，已写入业务台账的数据保留 */
export async function discardBatch(batchId: string): Promise<void> {
  await db.transaction('rw', db.importBatches, db.importStaging, async () => {
    await db.importStaging.where('batchId').equals(batchId).delete()
    await db.importBatches.delete(batchId)
  })
}

/** 待处理记录数：未写入且（缺上游暂存或冲突未选定）的记录 */
export async function pendingStagingCount(): Promise<number> {
  const rows = await db.importStaging.toCollection().filter((record) => !record.applied).toArray()
  return rows.filter((record) => record.held || record.status === 'conflict').length
}
