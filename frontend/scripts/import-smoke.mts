import 'fake-indexeddb/auto'
import { db } from '../src/utils/db'
import {
  applyBatch,
  discardBatch,
  intakePack,
  listStaging,
  setChosenSide,
} from '../src/utils/import-service'

let failures = 0
function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`)
  } else {
    failures += 1
    console.error(`  ✗ ${message}`)
  }
}

const FORMAT = 'gbpapermill-offline-pack/1'

function packFile(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    format: FORMAT,
    source: '第二作坊',
    packedAt: '2026-09-30',
    moulds: [],
    fiberBatches: [],
    sheetRuns: [],
    paperSamples: [],
    ...overrides,
  })
}

async function main() {
  await db.open()

  console.log('基线种子')
  const seedMouldCount = await db.moulds.count()
  assert(seedMouldCount === 5, `种子纸帘 5 条（实际 ${seedMouldCount}）`)
  assert((await db.moulds.get(1))?.schemaRev === 3, '首次打开旧库 schemaRev 回填为 3')

  console.log('场景 1：同包重试不重复建档')
  const text1 = packFile({
    moulds: [
      { mouldNo: 'DL-09', frameW: 62, frameH: 92, wireMaterial: '竹丝', wireDiameter: 0.3, stripeGap: 1.1, weaver: '周守良', state: '在用' },
    ],
  })
  const first = await intakePack('a.json', text1)
  assert(first.created, '首次读入创建批次')
  const second = await intakePack('a-copy.json', text1)
  assert(!second.created && second.batch.batchId === first.batch.batchId, '同内容包复用同一批次（按内容哈希认身份）')
  assert((await db.importBatches.count()) === 1, '批次表仍只有 1 条')
  assert((await db.importStaging.count()) === 1, '暂存记录不重复')
  const summary1 = await applyBatch(first.batch.batchId)
  assert(summary1.status === 'applied', '整包写入完成')
  assert((await db.moulds.where('mouldNo').equals('DL-09').count()) === 1, 'DL-09 建档一次')
  const retry1 = await applyBatch(first.batch.batchId)
  assert(retry1.status === 'applied', '重试已完成批次仍为 applied')
  assert((await db.moulds.where('mouldNo').equals('DL-09').count()) === 1, '重试没有重复建档')

  console.log('场景 2：同编号分歧先留双方，选定后才写入')
  const text2 = packFile({
    moulds: [
      // DL-01 本机丝径 0.3 / 间距 1.1，包内丝径 0.28
      { mouldNo: 'DL-01', frameW: 60, frameH: 90, wireMaterial: '竹丝', wireDiameter: 0.28, stripeGap: 1.1, weaver: '周守良', state: '在用' },
    ],
  })
  const b2 = (await intakePack('b.json', text2)).batch
  const s2 = await listStaging(b2.batchId)
  const conflict = s2.find((r) => r.businessNo === 'DL-01')!
  assert(conflict.status === 'conflict', 'DL-01 标记为有分歧')
  assert((await db.moulds.where('mouldNo').equals('DL-01').first())?.wireDiameter === 0.3, '未选定前本机台账保持原值')
  const beforeResolve = await applyBatch(b2.batchId)
  assert(beforeResolve.status === 'partial', '有未选定冲突时整包状态为部分写入')
  assert((await db.moulds.where('mouldNo').equals('DL-01').first())?.wireDiameter === 0.3, '跳过冲突，台账仍未改动')
  await setChosenSide(conflict.key, 'local')
  await applyBatch(b2.batchId)
  assert((await db.moulds.where('mouldNo').equals('DL-01').first())?.wireDiameter === 0.3, '选定本机值后写入本机丝径 0.3')

  console.log('场景 3：缺上游暂存，上游补齐后重试重新挂接（不碰包内数字编号）')
  const text3 = packFile({
    moulds: [{ mouldNo: 'DL-40', frameW: 58, frameH: 88, wireMaterial: '铜丝', wireDiameter: 0.2, stripeGap: 0.9, weaver: '沈云舟', state: '在用' }],
    fiberBatches: [{ batchNo: 'XW-2699', material: '竹麻', origin: '测试地', cookAgent: '石灰', cookHours: 10, bleachMethod: '日晒', beatingDegree: 30, operator: '罗青禾' }],
    sheetRuns: [
      // CB-9001 的纸帘/料批都在包内；CB-9002 缺纸帘；YZ-91 缺工序
      { runNo: 'CB-9001', mouldNo: 'DL-40', batchNo: 'XW-2699', runDate: '2026-09-28', operator: '罗青禾', stripeDirection: '竖帘纹', dipCount: 2, stackHeight: 40, dryMethod: '火墙', grammage: 30, measuredGap: 0.9 },
      { runNo: 'CB-9002', mouldNo: 'DL-NOPE', batchNo: 'XW-2699', runDate: '2026-09-29', operator: '罗青禾', stripeDirection: '横帘纹', dipCount: 1, stackHeight: 35, dryMethod: '日晒', grammage: 33, measuredGap: 0.9 },
    ],
    paperSamples: [
      { sampleNo: 'YZ-91', runNo: 'CB-MISSING', sizeMm: 200, stripeCount: 44, evenness: '均匀', archiveBin: '暂存柜-01' },
    ],
  })
  const b3 = (await intakePack('c.json', text3)).batch
  const sum3 = await applyBatch(b3.batchId)
  assert(sum3.status === 'partial', '存在暂存记录，状态部分写入')
  const run9001 = await db.sheetRuns.where('runNo').equals('CB-9001').first()
  assert(Boolean(run9001), 'CB-9001 已建档')
  const mould40 = await db.moulds.where('mouldNo').equals('DL-40').first()
  const batch99 = await db.fiberBatches.where('batchNo').equals('XW-2699').first()
  assert(run9001?.mouldId === mould40?.id && run9001?.batchId === batch99?.id, '工序按业务编号挂接到包内新建的纸帘与料批（非包内数字 id）')
  assert(Math.abs((run9001?.deviation ?? 99) - 0) < 1e-9, '偏差按选中纸帘间距重算（0.9-0.9=0）')
  assert(!(await db.sheetRuns.where('runNo').equals('CB-9002').first()), 'CB-9002 缺纸帘，暂存不建档')
  assert(!(await db.paperSamples.where('sampleNo').equals('YZ-91').first()), 'YZ-91 缺工序，暂存不建档')

  // 上游后续通过另一个包补齐
  const text3b = packFile({
    moulds: [{ mouldNo: 'DL-NOPE', frameW: 50, frameH: 80, wireMaterial: '竹丝', wireDiameter: 0.3, stripeGap: 1.2, weaver: '林砚秋', state: '在用' }],
    sheetRuns: [{ runNo: 'CB-MISSING', mouldNo: 'DL-NOPE', batchNo: 'XW-2699', runDate: '2026-09-27', operator: '郭文山', stripeDirection: '竖帘纹', dipCount: 2, stackHeight: 41, dryMethod: '火墙', grammage: 31, measuredGap: 1.2 }],
  })
  const b3b = (await intakePack('c-upstream.json', text3b)).batch
  await applyBatch(b3b.batchId)
  const sum3retry = await applyBatch(b3.batchId)
  assert(sum3retry.status === 'applied', '原批次重试后全部写入')
  const run9002 = await db.sheetRuns.where('runNo').equals('CB-9002').first()
  const mouldNope = await db.moulds.where('mouldNo').equals('DL-NOPE').first()
  assert(Boolean(run9002) && run9002.mouldId === mouldNope?.id, 'CB-9002 跟着新补齐的纸帘重新挂接')
  const yz91 = await db.paperSamples.where('sampleNo').equals('YZ-91').first()
  const runMissing = await db.sheetRuns.where('runNo').equals('CB-MISSING').first()
  assert(Boolean(yz91) && yz91.runId === runMissing?.id, 'YZ-91 跟着新补齐的工序重新挂接')

  console.log('场景 4：中途写入失败保留批次与进度，重试不重复')
  const text4 = packFile({
    fibreTypoIgnored: true,
    moulds: [
      { mouldNo: 'DL-51', frameW: 60, frameH: 90, wireMaterial: '竹丝', wireDiameter: 0.3, stripeGap: 1.1, weaver: '周守良', state: '在用' },
      { mouldNo: 'DL-52', frameW: 60, frameH: 90, wireMaterial: '竹丝', wireDiameter: 0.3, stripeGap: 1.1, weaver: '周守良', state: '在用' },
    ],
  })
  const b4 = (await intakePack('d.json', text4)).batch
  const originalAdd = db.moulds.add.bind(db.moulds)
  let failOnce = true
  db.moulds.add = ((value: unknown) => {
    if (failOnce && typeof value === 'object' && value !== null && (value as { mouldNo?: string }).mouldNo === 'DL-52') {
      failOnce = false
      return Promise.reject(new Error('模拟写入中断'))
    }
    return originalAdd(value as never)
  }) as typeof db.moulds.add
  const failed = await applyBatch(b4.batchId)
  db.moulds.add = originalAdd
  assert(failed.status === 'partial' && failed.errors.length === 1, '单条失败不影响其他记录，批次标记 partial 并保留错误')
  assert(Boolean(await db.moulds.where('mouldNo').equals('DL-51').first()), '失败前的 DL-51 进度保留')
  assert(!(await db.moulds.where('mouldNo').equals('DL-52').first()), 'DL-52 未写入')
  const recovered = await applyBatch(b4.batchId)
  assert(recovered.status === 'applied' && recovered.applied === 2, '重试后 2 条全部 applied（DL-51 跳过、DL-52 补写）')
  assert((await db.moulds.where('mouldNo').equals('DL-51').count()) === 1, 'DL-51 没有重复建档')
  assert((await db.moulds.where('mouldNo').equals('DL-52').count()) === 1, 'DL-52 建档一次')

  console.log('场景 5：字段级混选')
  const text5 = packFile({
    moulds: [
      { mouldNo: 'DL-02', frameW: 99, frameH: 82, wireMaterial: '铜丝', wireDiameter: 0.2, stripeGap: 0.85, weaver: '外作坊匠人', state: '在用' },
    ],
  })
  const b5 = (await intakePack('e.json', text5)).batch
  const staging5 = await listStaging(b5.batchId)
  const rec5 = staging5.find((r) => r.businessNo === 'DL-02')!
  // 框宽选本机(55)、匠人选离线包；其余默认跟随“全用离线包”
  await setChosenSide(rec5.key, 'remote')
  const { setFieldChoice } = await import('../src/utils/import-service')
  await setFieldChoice(b5.batchId, rec5.key, 'frameW', 'local')
  await applyBatch(b5.batchId)
  const dl02 = await db.moulds.where('mouldNo').equals('DL-02').first()
  assert(dl02?.frameW === 55, '字段级：框宽取本机 55')
  assert(dl02?.weaver === '外作坊匠人', '字段级：匠人取离线包')
  assert(dl02?.wireMaterial === '铜丝', '默认字段跟随离线包（材质仍为铜丝）')

  console.log('场景 6：校验问题跳过且不阻塞')
  const text6 = packFile({
    moulds: [
      { mouldNo: 'DL-61', frameW: 60, frameH: 90, wireMaterial: '竹丝', wireDiameter: 0.3, stripeGap: 1.1, weaver: '周守良', state: '在用' },
      { mouldNo: 'DL-BAD', frameW: 'bad', frameH: 90, wireMaterial: '竹丝', wireDiameter: 0.3, stripeGap: 1.1, weaver: '周守良', state: '在用' },
    ],
  })
  const intake6 = await intakePack('f.json', text6)
  assert(intake6.issues.length === 1, '不合法记录产生 1 条校验问题')
  await applyBatch(intake6.batch.batchId)
  assert(Boolean(await db.moulds.where('mouldNo').equals('DL-61').first()), '合法记录正常写入')
  assert(!(await db.moulds.where('mouldNo').equals('DL-BAD').first()), '不合法记录被跳过')

  console.log('场景 7：导出数据包含合并结果')
  const [moulds, batches, runs, samples] = await Promise.all([
    db.moulds.toArray(),
    db.fiberBatches.toArray(),
    db.sheetRuns.toArray(),
    db.paperSamples.toArray(),
  ])
  assert(moulds.some((m) => m.mouldNo === 'DL-40'), '台账含合并后的纸帘 DL-40')
  assert(batches.some((b) => b.batchNo === 'XW-2699'), '台账含合并后的料批 XW-2699')
  assert(runs.some((r) => r.runNo === 'CB-9002'), '台账含重新挂接的工序 CB-9002')
  assert(samples.some((s) => s.sampleNo === 'YZ-91'), '台账含重新挂接的样本 YZ-91')

  await discardBatch(b5.batchId)
  assert((await db.importStaging.where('batchId').equals(b5.batchId).count()) === 0, '丢弃批次清理暂存')

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  } else {
    console.log('\n全部断言通过')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
