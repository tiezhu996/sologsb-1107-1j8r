import type { OfflinePackage } from '../types/offline-package'
import { db, plain } from './db'

function downloadJson(payload: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function exportDatabaseJson(): Promise<string> {
  const [moulds, fiberBatches, sheetRuns, paperSamples, importBatches] = await Promise.all([
    db.moulds.toArray(),
    db.fiberBatches.toArray(),
    db.sheetRuns.toArray(),
    db.paperSamples.toArray(),
    db.importBatches.toArray(),
  ])
  const filename = `gbpapermill-backup-${new Date().toISOString().slice(0, 10)}.json`
  const backup = plain({
    database: 'gbpapermill-db',
    version: 3,
    exportedAt: new Date().toISOString(),
    moulds,
    fiberBatches,
    sheetRuns,
    paperSamples,
    importBatches,
  })
  downloadJson(backup, filename)
  return filename
}

/** 下载一个离线包 JSON（如示例包），供作坊侧或联调使用。 */
export function exportOfflinePackageJson(pkg: OfflinePackage): string {
  const filename = `${pkg.meta.packageId || 'offline-package'}.json`
  downloadJson(plain(pkg), filename)
  return filename
}
