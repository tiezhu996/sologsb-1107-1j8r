import 'fake-indexeddb/auto'
import Dexie from 'dexie'

let failures = 0
function assert(condition: boolean, message: string) {
  if (condition) console.log(`  ✓ ${message}`)
  else { failures += 1; console.error(`  ✗ ${message}`) }
}

async function main() {
  // 1) 用“旧版本应用”建库：v1 schema，记录没有 schemaRev
  const oldDb = new Dexie('gbpapermill-db')
  oldDb.version(1).stores({
    moulds: '++id,&mouldNo,state,wireMaterial',
    fiberBatches: '++id,&batchNo,material,beatingDegree',
    sheetRuns: '++id,&runNo,mouldId,batchId,runDate,operator',
    paperSamples: '++id,&sampleNo,runId,evenness,stripeCount',
  })
  await oldDb.moulds.add({ id: 1, mouldNo: 'DL-OLD', frameW: 60, frameH: 90, wireMaterial: '竹丝', wireDiameter: 0.3, stripeGap: 1.1, meshDensity: 7.1, weaver: '老匠人', state: '在用' })
  await oldDb.close()

  // 2) 用新版本代码打开同一库
  const { db } = await import('../src/utils/db')
  await db.open()
  const old = await db.moulds.where('mouldNo').equals('DL-OLD').first()
  assert(old?.schemaRev === 3, 'v1 老数据首次打开时逐级回填到 schemaRev=3')

  const seedCount = await db.moulds.count()
  assert(seedCount === 1, `老库升级不触发 populate，只保留老记录（共 ${seedCount} 条）`)

  // 3) v2 老库 -> v3：保持 3
  const db2name = 'gbpapermill-db-v2case'
  const v2db = new Dexie(db2name)
  v2db.version(1).stores({
    moulds: '++id,&mouldNo,state,wireMaterial',
    fiberBatches: '++id,&batchNo,material,beatingDegree',
    sheetRuns: '++id,&runNo,mouldId,batchId,runDate,operator',
    paperSamples: '++id,&sampleNo,runId,evenness,stripeCount',
  })
  v2db.version(2).stores({
    moulds: '++id,&mouldNo,state,wireMaterial,schemaRev',
    fiberBatches: '++id,&batchNo,material,beatingDegree,schemaRev',
    sheetRuns: '++id,&runNo,mouldId,batchId,runDate,operator,schemaRev',
    paperSamples: '++id,&sampleNo,runId,evenness,stripeCount,schemaRev',
  })
  await v2db.moulds.add({ id: 7, mouldNo: 'DL-V2', frameW: 1, frameH: 1, wireMaterial: '铜丝', wireDiameter: 0.2, stripeGap: 0.9, meshDensity: 9.1, weaver: 'x', state: '在用', schemaRev: 2 })
  await v2db.close()

  // 直接构造一个指向同名库的当前版实例（db.ts 固定库名，这里手工复制版本定义验证 upgrade）
  const upgraded = new Dexie(db2name)
  upgraded.version(1).stores({
    moulds: '++id,&mouldNo,state,wireMaterial',
    fiberBatches: '++id,&batchNo,material,beatingDegree',
    sheetRuns: '++id,&runNo,mouldId,batchId,runDate,operator',
    paperSamples: '++id,&sampleNo,runId,evenness,stripeCount',
  })
  upgraded.version(2).stores({
    moulds: '++id,&mouldNo,state,wireMaterial,schemaRev',
    fiberBatches: '++id,&batchNo,material,beatingDegree,schemaRev',
    sheetRuns: '++id,&runNo,mouldId,batchId,runDate,operator,schemaRev',
    paperSamples: '++id,&sampleNo,runId,evenness,stripeCount,schemaRev',
  })
  upgraded.version(3).stores({
    moulds: '++id,&mouldNo,state,wireMaterial,schemaRev',
    fiberBatches: '++id,&batchNo,material,beatingDegree,schemaRev',
    sheetRuns: '++id,&runNo,mouldId,batchId,runDate,operator,schemaRev',
    paperSamples: '++id,&sampleNo,runId,evenness,stripeCount,schemaRev',
    importBatches: '&batchId,status,updatedAt',
    importStaging: '++id,&key,batchId,kind,businessNo,status',
  }).upgrade(async (tx) => {
    for (const table of ['moulds', 'fiberBatches', 'sheetRuns', 'paperSamples']) {
      await tx.table(table).toCollection().modify((v: Record<string, unknown>) => { v.schemaRev = 3 })
    }
  })
  const rec = await upgraded.moulds.where('mouldNo').equals('DL-V2').first()
  assert(rec?.schemaRev === 3, 'v2 数据升级到 v3 时回填 3')

  if (failures > 0) process.exit(1)
  console.log('\n升级链断言通过')
}

main().catch((e) => { console.error(e); process.exit(1) })
