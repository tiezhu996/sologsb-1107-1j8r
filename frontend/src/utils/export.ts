import { db, plain } from './db'

export async function exportDatabaseJson(): Promise<string> {
  const [moulds, fiberBatches, sheetRuns, paperSamples, importBatches, importStaging] = await Promise.all([
    db.moulds.toArray(),
    db.fiberBatches.toArray(),
    db.sheetRuns.toArray(),
    db.paperSamples.toArray(),
    db.importBatches.toArray(),
    db.importStaging.toArray(),
  ])
  const filename = `gbpapermill-backup-${new Date().toISOString().slice(0, 10)}.json`
  // 四张业务表即合并后的台账结果；另附离线包批次与暂存进度，备份后仍可继续处理
  const backup = plain({
    database: 'gbpapermill-db',
    version: 3,
    exportedAt: new Date().toISOString(),
    moulds,
    fiberBatches,
    sheetRuns,
    paperSamples,
    importBatches,
    importStaging,
  })
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
  return filename
}
