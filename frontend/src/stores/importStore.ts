import { create } from 'zustand'
import type { FiberBatch } from '../types/fiber-batch'
import type { Mould } from '../types/mould'
import type {
  ConflictEntity,
  ConflictResolution,
  ImportBatch,
  ImportBatchStatus,
  ImportProgress,
  MergeConflict,
  OfflinePackage,
  PackageFiberBatch,
  PackageMould,
  PackagePaperSample,
  PackageSheetRun,
  PendingEntity,
  PendingLink,
  PhaseProgress,
} from '../types/offline-package'
import type { PaperSample } from '../types/paper-sample'
import type { SheetRun } from '../types/sheet-run'
import { CURRENT_SCHEMA_REV, db, plain } from '../utils/db'
import { buildSampleOfflinePackage, diffFiberFields, diffMouldFields, fingerprintPackage, parseOfflinePackage } from '../utils/merge'
import { calculateDeviation, calculateMeshDensity } from '../utils/stripe'
import { useFiberStore } from './fiberStore'
import { useMouldStore } from './mouldStore'
import { useRunStore } from './runStore'
import { useSampleStore } from './sampleStore'

function emptyPhase(): PhaseProgress {
  return { total: 0, created: 0, duplicates: 0, conflicts: 0, pending: 0 }
}

function emptyProgress(): ImportProgress {
  return { moulds: emptyPhase(), fiberBatches: emptyPhase(), sheetRuns: emptyPhase(), paperSamples: emptyPhase() }
}

export function summarizeProgress(progress: ImportProgress): string {
  const phases = [progress.moulds, progress.fiberBatches, progress.sheetRuns, progress.paperSamples]
  const sum = (pick: (phase: PhaseProgress) => number) => phases.reduce((total, phase) => total + pick(phase), 0)
  return `新增 ${sum((phase) => phase.created)} · 重复 ${sum((phase) => phase.duplicates)} · 分歧 ${sum((phase) => phase.conflicts)} · 暂存 ${sum((phase) => phase.pending)}`
}

function nowIso(): string {
  return new Date().toISOString()
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function saveProgress(batchId: number, progress: ImportProgress): Promise<void> {
  await db.importBatches.update(batchId, { progress: plain(progress), updatedAt: nowIso() })
}

/** 同号分歧留底：双方各留一份，状态保持“待选定”，选定前不写入台账。 */
async function ensureConflict(
  batchId: number,
  entity: ConflictEntity,
  bizNo: string,
  localRecord: unknown,
  incomingRecord: unknown,
  diffFields: string[],
): Promise<'open' | 'resolved'> {
  const localSnapshot = plain(localRecord) as Record<string, unknown>
  const incomingSnapshot = plain(incomingRecord) as Record<string, unknown>
  const existing = await db.mergeConflicts.where('[batchId+entity+bizNo]').equals([batchId, entity, bizNo]).first()
  if (existing?.status === '已选定') return 'resolved'
  if (existing?.id !== undefined) {
    await db.mergeConflicts.update(existing.id, { localRecord: localSnapshot, incomingRecord: incomingSnapshot, diffFields: plain(diffFields) })
    return 'open'
  }
  await db.mergeConflicts.add(plain({
    batchId,
    entity,
    bizNo,
    localRecord: localSnapshot,
    incomingRecord: incomingSnapshot,
    diffFields,
    status: '待选定' as const,
    schemaRev: CURRENT_SCHEMA_REV,
  }))
  return 'open'
}

/** 缺上游的工序 / 样本暂存：同一批次同一编号只留一条，重试不重复。 */
async function ensurePendingLink(
  batchId: number,
  entity: PendingEntity,
  bizNo: string,
  payload: PackageSheetRun | PackagePaperSample,
  missing: string[],
): Promise<'open' | 'linked'> {
  const existing = await db.pendingLinks.where('[batchId+entity+bizNo]').equals([batchId, entity, bizNo]).first()
  if (existing?.status === '已挂接') return 'linked'
  if (existing?.id !== undefined) {
    await db.pendingLinks.update(existing.id, { payload: plain(payload), missing: plain(missing) })
    return 'open'
  }
  await db.pendingLinks.add(plain({ batchId, entity, bizNo, payload, missing, status: '待处理' as const, schemaRev: CURRENT_SCHEMA_REV }))
  return 'open'
}

async function hasOpenConflict(entity: ConflictEntity, bizNo: string): Promise<boolean> {
  const found = await db.mergeConflicts
    .filter((conflict) => conflict.entity === entity && conflict.bizNo === bizNo && conflict.status === '待选定')
    .first()
  return found !== undefined
}

async function missingUpstreamReason(entity: ConflictEntity, bizNo: string): Promise<string> {
  const label = entity === 'mould' ? '纸帘' : '料批'
  if (!bizNo) return `${label}编号缺失`
  return (await hasOpenConflict(entity, bizNo)) ? `${label} ${bizNo} 待选定` : `${label} ${bizNo} 缺失`
}

async function missingRunReason(runNo: string): Promise<string> {
  if (!runNo) return '工序编号缺失'
  const pending = await db.pendingLinks
    .filter((link) => link.entity === 'sheetRun' && link.bizNo === runNo && link.status === '待处理')
    .first()
  return pending ? `工序 ${runNo} 待挂接` : `工序 ${runNo} 缺失`
}

interface ArchiveMaps {
  mouldByNo: Map<string, Mould>
  batchByNo: Map<string, FiberBatch>
  runByNo: Map<string, SheetRun>
  sampleNos: Set<string>
}

async function loadArchiveMaps(): Promise<ArchiveMaps> {
  const [moulds, fiberBatches, sheetRuns, paperSamples] = await Promise.all([
    db.moulds.toArray(),
    db.fiberBatches.toArray(),
    db.sheetRuns.toArray(),
    db.paperSamples.toArray(),
  ])
  return {
    mouldByNo: new Map(moulds.map((mould) => [mould.mouldNo, mould])),
    batchByNo: new Map(fiberBatches.map((batch) => [batch.batchNo, batch])),
    runByNo: new Map(sheetRuns.map((run) => [run.runNo, run])),
    sampleNos: new Set(paperSamples.map((sample) => sample.sampleNo)),
  }
}

function buildRunRecord(incoming: PackageSheetRun, mouldId: number, batchId: number, standardGap: number): SheetRun {
  return {
    runNo: incoming.runNo,
    mouldId,
    batchId,
    runDate: incoming.runDate,
    operator: incoming.operator,
    stripeDirection: incoming.stripeDirection,
    dipCount: incoming.dipCount,
    stackHeight: incoming.stackHeight,
    dryMethod: incoming.dryMethod,
    grammage: incoming.grammage,
    measuredGap: incoming.measuredGap,
    deviation: calculateDeviation(incoming.measuredGap, standardGap),
    schemaRev: CURRENT_SCHEMA_REV,
  }
}

function buildSampleRecord(incoming: PackagePaperSample, runId: number): PaperSample {
  return {
    sampleNo: incoming.sampleNo,
    runId,
    sizeMm: incoming.sizeMm,
    stripeCount: incoming.stripeCount,
    evenness: incoming.evenness,
    archiveBin: incoming.archiveBin,
    schemaRev: CURRENT_SCHEMA_REV,
  }
}

/**
 * 整包合并：按 纸帘 → 料批 → 工序 → 样本 的顺序处理。
 * 每条记录按业务编号去重，因此任何一步失败后重试同一包都不会重复建档；
 * 每阶段结束后把进度写回批次行，失败时批次与进度都保留。
 */
async function runMerge(batchId: number, pkg: OfflinePackage): Promise<void> {
  const progress = emptyProgress()
  await saveProgress(batchId, progress)
  const maps = await loadArchiveMaps()

  for (const incoming of pkg.moulds) {
    progress.moulds.total += 1
    const local = maps.mouldByNo.get(incoming.mouldNo)
    if (!local) {
      const record: Mould = { ...incoming, schemaRev: CURRENT_SCHEMA_REV }
      const id = Number(await db.moulds.add(plain(record)))
      maps.mouldByNo.set(incoming.mouldNo, { ...record, id })
      progress.moulds.created += 1
      continue
    }
    const diffs = diffMouldFields(local, incoming)
    if (diffs.length === 0) {
      progress.moulds.duplicates += 1
      continue
    }
    const result = await ensureConflict(batchId, 'mould', incoming.mouldNo, local, incoming, diffs)
    if (result === 'resolved') progress.moulds.duplicates += 1
    else progress.moulds.conflicts += 1
  }
  await saveProgress(batchId, progress)

  for (const incoming of pkg.fiberBatches) {
    progress.fiberBatches.total += 1
    const local = maps.batchByNo.get(incoming.batchNo)
    if (!local) {
      const record: FiberBatch = { ...incoming, schemaRev: CURRENT_SCHEMA_REV }
      const id = Number(await db.fiberBatches.add(plain(record)))
      maps.batchByNo.set(incoming.batchNo, { ...record, id })
      progress.fiberBatches.created += 1
      continue
    }
    const diffs = diffFiberFields(local, incoming)
    if (diffs.length === 0) {
      progress.fiberBatches.duplicates += 1
      continue
    }
    const result = await ensureConflict(batchId, 'fiberBatch', incoming.batchNo, local, incoming, diffs)
    if (result === 'resolved') progress.fiberBatches.duplicates += 1
    else progress.fiberBatches.conflicts += 1
  }
  await saveProgress(batchId, progress)

  for (const incoming of pkg.sheetRuns) {
    progress.sheetRuns.total += 1
    if (maps.runByNo.has(incoming.runNo)) {
      progress.sheetRuns.duplicates += 1
      continue
    }
    const missing: string[] = []
    const mould = incoming.mouldNo ? maps.mouldByNo.get(incoming.mouldNo) : undefined
    const mouldId = mould?.id
    if (mouldId === undefined) missing.push(await missingUpstreamReason('mould', incoming.mouldNo))
    else if (await hasOpenConflict('mould', incoming.mouldNo)) missing.push(`纸帘 ${incoming.mouldNo} 待选定`)
    const fiber = incoming.batchNo ? maps.batchByNo.get(incoming.batchNo) : undefined
    const fiberId = fiber?.id
    if (fiberId === undefined) missing.push(await missingUpstreamReason('fiberBatch', incoming.batchNo))
    else if (await hasOpenConflict('fiberBatch', incoming.batchNo)) missing.push(`料批 ${incoming.batchNo} 待选定`)
    if (missing.length > 0 || mouldId === undefined || fiberId === undefined || mould === undefined) {
      const result = await ensurePendingLink(batchId, 'sheetRun', incoming.runNo, incoming, missing)
      if (result === 'linked') progress.sheetRuns.duplicates += 1
      else progress.sheetRuns.pending += 1
      continue
    }
    const record = buildRunRecord(incoming, mouldId, fiberId, mould.stripeGap)
    const id = Number(await db.sheetRuns.add(plain(record)))
    maps.runByNo.set(record.runNo, { ...record, id })
    progress.sheetRuns.created += 1
  }
  await saveProgress(batchId, progress)

  for (const incoming of pkg.paperSamples) {
    progress.paperSamples.total += 1
    if (maps.sampleNos.has(incoming.sampleNo)) {
      progress.paperSamples.duplicates += 1
      continue
    }
    const run = incoming.runNo ? maps.runByNo.get(incoming.runNo) : undefined
    const runId = run?.id
    if (runId === undefined) {
      const result = await ensurePendingLink(batchId, 'paperSample', incoming.sampleNo, incoming, [await missingRunReason(incoming.runNo)])
      if (result === 'linked') progress.paperSamples.duplicates += 1
      else progress.paperSamples.pending += 1
      continue
    }
    const record = buildSampleRecord(incoming, runId)
    await db.paperSamples.add(plain(record))
    maps.sampleNos.add(record.sampleNo)
    progress.paperSamples.created += 1
  }
  await saveProgress(batchId, progress)

  await finalizeBatchStatus(batchId)
}

async function markLinked(link: PendingLink): Promise<void> {
  if (link.id !== undefined) {
    await db.pendingLinks.update(link.id, { status: '已挂接', missing: [], linkedAt: nowIso() })
  }
}

/**
 * 暂存重挂：分歧选定或上游补登记后，把仍缺上游的工序 / 样本重新挂接到当前台账。
 * 先挂工序再挂样本，样本可以跟上同一次新挂接的工序。
 */
async function drainPendingLinksInternal(): Promise<{ linked: number; remaining: number }> {
  const maps = await loadArchiveMaps()
  const openConflicts = await db.mergeConflicts.filter((conflict) => conflict.status === '待选定').toArray()
  const conflictedMoulds = new Set(openConflicts.filter((conflict) => conflict.entity === 'mould').map((conflict) => conflict.bizNo))
  const conflictedBatches = new Set(openConflicts.filter((conflict) => conflict.entity === 'fiberBatch').map((conflict) => conflict.bizNo))
  const openLinks = await db.pendingLinks.filter((link) => link.status === '待处理').toArray()
  let linked = 0

  const describeMould = (mouldNo: string): string => {
    if (!mouldNo) return '纸帘编号缺失'
    return conflictedMoulds.has(mouldNo) ? `纸帘 ${mouldNo} 待选定` : `纸帘 ${mouldNo} 缺失`
  }
  const describeBatch = (batchNo: string): string => {
    if (!batchNo) return '料批编号缺失'
    return conflictedBatches.has(batchNo) ? `料批 ${batchNo} 待选定` : `料批 ${batchNo} 缺失`
  }

  for (const link of openLinks.filter((item) => item.entity === 'sheetRun')) {
    const payload = link.payload as PackageSheetRun
    if (maps.runByNo.has(payload.runNo)) {
      await markLinked(link)
      linked += 1
      continue
    }
    const missing: string[] = []
    const mould = payload.mouldNo ? maps.mouldByNo.get(payload.mouldNo) : undefined
    const mouldId = mould?.id
    if (mouldId === undefined) missing.push(describeMould(payload.mouldNo))
    else if (conflictedMoulds.has(payload.mouldNo)) missing.push(`纸帘 ${payload.mouldNo} 待选定`)
    const fiber = payload.batchNo ? maps.batchByNo.get(payload.batchNo) : undefined
    const fiberId = fiber?.id
    if (fiberId === undefined) missing.push(describeBatch(payload.batchNo))
    else if (conflictedBatches.has(payload.batchNo)) missing.push(`料批 ${payload.batchNo} 待选定`)
    if (missing.length > 0 || mouldId === undefined || fiberId === undefined || mould === undefined) {
      if (link.id !== undefined) await db.pendingLinks.update(link.id, { missing: plain(missing) })
      continue
    }
    const record = buildRunRecord(payload, mouldId, fiberId, mould.stripeGap)
    const id = Number(await db.sheetRuns.add(plain(record)))
    maps.runByNo.set(record.runNo, { ...record, id })
    await markLinked(link)
    linked += 1
  }

  for (const link of openLinks.filter((item) => item.entity === 'paperSample')) {
    const payload = link.payload as PackagePaperSample
    if (maps.sampleNos.has(payload.sampleNo)) {
      await markLinked(link)
      linked += 1
      continue
    }
    const run = payload.runNo ? maps.runByNo.get(payload.runNo) : undefined
    const runId = run?.id
    if (runId === undefined) {
      const reason = await missingRunReason(payload.runNo)
      if (link.id !== undefined) await db.pendingLinks.update(link.id, { missing: [reason] })
      continue
    }
    const record = buildSampleRecord(payload, runId)
    await db.paperSamples.add(plain(record))
    maps.sampleNos.add(record.sampleNo)
    await markLinked(link)
    linked += 1
  }

  const remaining = await db.pendingLinks.filter((link) => link.status === '待处理').count()
  return { linked, remaining }
}

async function computeBatchStatus(batchId: number): Promise<ImportBatchStatus> {
  const openConflicts = await db.mergeConflicts
    .where('batchId')
    .equals(batchId)
    .filter((conflict) => conflict.status === '待选定')
    .count()
  if (openConflicts > 0) return '待选定'
  const openPending = await db.pendingLinks
    .where('batchId')
    .equals(batchId)
    .filter((link) => link.status === '待处理')
    .count()
  return openPending > 0 ? '部分合并' : '已合并'
}

async function finalizeBatchStatus(batchId: number): Promise<void> {
  await db.importBatches.update(batchId, { status: await computeBatchStatus(batchId), updatedAt: nowIso() })
}

async function recomputeBatchStatuses(): Promise<void> {
  const batches = await db.importBatches.toArray()
  for (const batch of batches) {
    if (batch.id === undefined || batch.status === '合并中' || batch.status === '写入失败') continue
    const status = await computeBatchStatus(batch.id)
    if (status !== batch.status) {
      await db.importBatches.update(batch.id, { status, updatedAt: nowIso() })
    }
  }
}

/** 选定分歧：采纳包内时把包内值写回本机记录（保留本机 id），随后暂存记录尝试重挂。 */
async function applyConflictResolution(conflict: MergeConflict, side: ConflictResolution): Promise<void> {
  if (side === '采纳包内') {
    const localId = (conflict.localRecord as { id?: number }).id
    if (localId !== undefined && conflict.entity === 'mould') {
      const incoming = conflict.incomingRecord as unknown as PackageMould
      await db.moulds.update(localId, plain({
        frameW: incoming.frameW,
        frameH: incoming.frameH,
        wireMaterial: incoming.wireMaterial,
        wireDiameter: incoming.wireDiameter,
        stripeGap: incoming.stripeGap,
        meshDensity: calculateMeshDensity(incoming.wireDiameter, incoming.stripeGap),
        weaver: incoming.weaver,
        state: incoming.state,
        schemaRev: CURRENT_SCHEMA_REV,
      }))
    }
    if (localId !== undefined && conflict.entity === 'fiberBatch') {
      const incoming = conflict.incomingRecord as unknown as PackageFiberBatch
      await db.fiberBatches.update(localId, plain({
        material: incoming.material,
        origin: incoming.origin,
        cookAgent: incoming.cookAgent,
        cookHours: incoming.cookHours,
        bleachMethod: incoming.bleachMethod,
        beatingDegree: incoming.beatingDegree,
        operator: incoming.operator,
        schemaRev: CURRENT_SCHEMA_REV,
      }))
    }
  }
  if (conflict.id !== undefined) {
    await db.mergeConflicts.update(conflict.id, { status: '已选定', resolution: side, resolvedAt: nowIso() })
  }
}

async function refreshBusinessStores(): Promise<void> {
  useMouldStore.setState({ loaded: false })
  useFiberStore.setState({ loaded: false })
  useRunStore.setState({ loaded: false })
  useSampleStore.setState({ loaded: false })
  await Promise.all([
    useMouldStore.getState().loadMoulds(),
    useFiberStore.getState().loadFiberBatches(),
    useRunStore.getState().loadRuns(),
    useSampleStore.getState().loadSamples(),
  ])
}

interface ImportStore {
  batches: ImportBatch[]
  conflicts: MergeConflict[]
  pendingLinks: PendingLink[]
  isLoading: boolean
  isMerging: boolean
  error: string | null
  notice: string | null
  loadImportState: () => Promise<void>
  importPackage: (raw: unknown) => Promise<boolean>
  importPackageFile: (file: File) => Promise<boolean>
  importSamplePackage: () => Promise<boolean>
  retryBatch: (batchId: number) => Promise<boolean>
  resolveConflict: (conflictId: number, side: ConflictResolution) => Promise<void>
  resolveAllConflicts: (side: ConflictResolution) => Promise<void>
  drainPendingLinks: () => Promise<void>
  clearFeedback: () => void
}

export const useImportStore = create<ImportStore>((set, get) => {
  /** 合并执行与批次跟踪：失败时保留批次与进度，状态落为“写入失败”。 */
  const runAndTrack = async (batchId: number, pkg: OfflinePackage): Promise<boolean> => {
    try {
      await runMerge(batchId, pkg)
    } catch (cause) {
      await db.importBatches.update(batchId, { status: '写入失败', error: errorMessage(cause), updatedAt: nowIso() })
      set({ error: `离线包写入失败：${errorMessage(cause)}。批次与进度已保留，可重试同一包，不会重复建档。` })
      await get().loadImportState()
      return false
    }
    await refreshBusinessStores()
    await get().loadImportState()
    const batch = await db.importBatches.get(batchId)
    if (batch) {
      set({ notice: `离线包「${batch.packageName}」处理完成：${summarizeProgress(batch.progress)}，状态「${batch.status}」` })
    }
    return true
  }

  const finalizeResolution = async (notice: string): Promise<void> => {
    await drainPendingLinksInternal()
    await recomputeBatchStatuses()
    await refreshBusinessStores()
    await get().loadImportState()
    set({ notice })
  }

  return {
    batches: [],
    conflicts: [],
    pendingLinks: [],
    isLoading: false,
    isMerging: false,
    error: null,
    notice: null,

    loadImportState: async () => {
      set({ isLoading: true })
      try {
        const [batches, conflicts, pendingLinks] = await Promise.all([
          db.importBatches.orderBy('importedAt').reverse().toArray(),
          db.mergeConflicts.toArray(),
          db.pendingLinks.toArray(),
        ])
        set({ batches, conflicts, pendingLinks, isLoading: false })
      } catch {
        set({ isLoading: false, error: '导入批次读取失败，请检查浏览器存储权限' })
      }
    },

    importPackage: async (raw) => {
      set({ isMerging: true, error: null, notice: null })
      let pkg: OfflinePackage
      try {
        pkg = parseOfflinePackage(raw)
      } catch (cause) {
        set({ isMerging: false, error: errorMessage(cause) })
        return false
      }
      const packageId = pkg.meta.packageId || `PKG-${fingerprintPackage(pkg)}`
      const normalized: OfflinePackage = { ...pkg, meta: { ...pkg.meta, packageId } }
      try {
        const existing = await db.importBatches.where('packageId').equals(packageId).first()
        if (existing?.status === '已合并') {
          set({ isMerging: false, notice: `离线包 ${packageId} 已合并过，同一包重复导入不会重复建档` })
          return true
        }
        let batchId: number
        if (existing?.id !== undefined) {
          batchId = existing.id
          await db.importBatches.update(batchId, {
            packageName: normalized.meta.packageName,
            snapshot: plain(normalized),
            status: '合并中',
            error: null,
            updatedAt: nowIso(),
          })
        } else {
          const batch: ImportBatch = {
            packageId,
            packageName: normalized.meta.packageName,
            importedAt: nowIso(),
            updatedAt: nowIso(),
            status: '合并中',
            progress: emptyProgress(),
            error: null,
            snapshot: plain(normalized),
            schemaRev: CURRENT_SCHEMA_REV,
          }
          batchId = Number(await db.importBatches.add(plain(batch)))
        }
        const ok = await runAndTrack(batchId, normalized)
        set({ isMerging: false })
        return ok
      } catch (cause) {
        set({ isMerging: false, error: `离线包登记失败：${errorMessage(cause)}` })
        return false
      }
    },

    importPackageFile: async (file) => {
      let raw: unknown
      try {
        raw = JSON.parse(await file.text())
      } catch {
        set({ error: '离线包文件不是有效的 JSON，请重新选择', notice: null })
        return false
      }
      return get().importPackage(raw)
    },

    importSamplePackage: async () => get().importPackage(buildSampleOfflinePackage()),

    retryBatch: async (batchId) => {
      const batch = await db.importBatches.get(batchId)
      if (!batch) {
        set({ error: '未找到该导入批次，无法重试' })
        return false
      }
      set({ isMerging: true, error: null, notice: null })
      await db.importBatches.update(batchId, { status: '合并中', error: null, updatedAt: nowIso() })
      const ok = await runAndTrack(batchId, batch.snapshot)
      set({ isMerging: false })
      return ok
    },

    resolveConflict: async (conflictId, side) => {
      const conflict = await db.mergeConflicts.get(conflictId)
      if (!conflict || conflict.status === '已选定') return
      set({ error: null, notice: null })
      try {
        await applyConflictResolution(conflict, side)
        await finalizeResolution(`已选定「${side}」：${conflict.bizNo}，相关暂存记录已尝试重新挂接`)
      } catch (cause) {
        set({ error: `分歧选定失败：${errorMessage(cause)}` })
      }
    },

    resolveAllConflicts: async (side) => {
      set({ error: null, notice: null })
      try {
        const open = await db.mergeConflicts.filter((conflict) => conflict.status === '待选定').toArray()
        for (const conflict of open) {
          await applyConflictResolution(conflict, side)
        }
        await finalizeResolution(`已批量选定「${side}」共 ${open.length} 条分歧，相关暂存记录已尝试重新挂接`)
      } catch (cause) {
        set({ error: `批量选定失败：${errorMessage(cause)}` })
      }
    },

    drainPendingLinks: async () => {
      set({ error: null, notice: null })
      try {
        const { linked, remaining } = await drainPendingLinksInternal()
        await recomputeBatchStatuses()
        await refreshBusinessStores()
        await get().loadImportState()
        set({ notice: `重新挂接完成：新挂接 ${linked} 条，仍暂存 ${remaining} 条` })
      } catch (cause) {
        set({ error: `重新挂接失败：${errorMessage(cause)}` })
      }
    },

    clearFeedback: () => set({ error: null, notice: null }),
  }
})
