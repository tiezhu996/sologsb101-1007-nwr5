/**
 * 测点接替关系的运行时验证（Node + fake-indexeddb）
 * 覆盖：播种接替链、连续累计量与跨接替日速率、撤下恢复、检查点、
 * 首读延迟继承、即时继承、多级链、删除保护、备份导入与校验规则。
 *
 * 运行：npm run test:succession
 */
import 'fake-indexeddb/auto'
import { strict as assert } from 'node:assert'

const store = new Map<string, string>()
globalThis.localStorage = {
  getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => void store.clear()
}

import {
  applySuccession,
  db,
  deletePointCascade,
  exportSnapshot,
  importSnapshot,
  initDatabase,
  readSuccessionCheckpoint,
  restoreSuccessionCheckpoint,
  clearSuccessionCheckpoint,
  revokeSuccession,
  previewSuccession,
  putObservation,
  type PointRow
} from '@/utils/db'
import { buildChainIndex, chainCodeOf, chainHeadOf, summarizeChain } from '@/utils/succession'

let passed = 0
function check(cond: boolean, msg: string): void {
  assert.ok(cond, msg)
  passed += 1
  console.log('  ok  ', msg)
}
const approx = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps
async function rejects(promise: Promise<unknown>, re: RegExp, msg: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => re.test(error instanceof Error ? error.message : ''), msg)
  passed += 1
  console.log('  ok  ', msg)
}
const now = (): number => Date.now()

async function main(): Promise<void> {
  await initDatabase()

  console.log('\n[1] 播种接替链 pt-1 → pt-10（读数零位不同，连续累计接平）')
  const seed = (await db.successions.toArray())[0]
  check(seed.id === 'su-1' && seed.inherited && approx(seed.inheritedCumulative ?? NaN, 27.4), '继承累计量 27.4')
  check(approx((await db.points.get('pt-10'))!.initialValue, 20.1), '新点初值扣减 20.1')
  const ob22 = (await db.observations.get('ob-22'))!
  check(approx(ob22.cumulative, 27.4) && approx(ob22.dailyRate, 0), '首读连续累计 27.4、跨链日速率 0')
  const ob23 = (await db.observations.get('ob-23'))!
  check(approx(ob23.cumulative, 28.3) && approx(ob23.dailyRate, 0.9), '第二条 28.3 / 0.9')
  check(approx((await db.observations.get('ob-3'))!.cumulative, 27.4), '旧点原始观测保留')
  const oldAlarm = await db.alarms.get('al-1')
  check(oldAlarm!.pointId === 'pt-1' && oldAlarm!.state === '待处置', '旧预警不自动改挂')

  console.log('\n[2] 纯链连续序列')
  {
    const points = await db.points.toArray()
    const observations = await db.observations.toArray()
    const index = buildChainIndex(await db.successions.toArray())
    check(chainHeadOf('pt-10', index) === 'pt-1', '新点链头解析为旧点')
    check(chainCodeOf('pt-1', index, points) === 'DB-01 → DB-01R', '链编号正确')
    const summary = summarizeChain('pt-1', index, observations)
    check(approx(summary.latest!.cumulative, 28.3) && summary.readings.length === 5, '链末 28.3，共 5 条读数')
    const cross = summary.readings.find((row) => row.acrossLink)
    check(cross?.pointId === 'pt-10' && approx(cross.dailyRate, 0), '跨接替档速率按累计差为 0')
    check(
      chainHeadOf('pt-4', index) === 'pt-4' && summarizeChain('pt-4', index, observations).readings.length === 2,
      '无关系测点自动补成单点链'
    )
  }

  console.log('\n[3] 撤下 → 计算与归属恢复')
  await revokeSuccession('su-1')
  check((await db.successions.get('su-1'))!.status === '已撤下', '关系标记已撤下并留痕')
  check(approx((await db.points.get('pt-10'))!.initialValue, 47.5), '新点初值恢复基线 47.5')
  check(approx((await db.observations.get('ob-22'))!.cumulative, 0), '首读恢复独立口径 0')
  check(approx((await db.observations.get('ob-23'))!.cumulative, 0.9), '独立序列累计 0.9')
  check((await db.alarms.get('al-1'))!.pointId === 'pt-1', '撤下后旧预警仍在旧点')
  check(
    chainHeadOf('pt-10', buildChainIndex(await db.successions.toArray())) === 'pt-10',
    '撤下后新点恢复独立链头'
  )

  console.log('\n[4] 从检查点恢复撤下')
  {
    const checkpoint = readSuccessionCheckpoint()
    check(Boolean(checkpoint) && checkpoint!.action === 'revoke', '撤下前留存检查点')
    await restoreSuccessionCheckpoint(checkpoint!)
    const link = await db.successions.get('su-1')
    check(link!.status === '生效' && link!.inherited, '检查点恢复关系为生效')
    check(approx((await db.points.get('pt-10'))!.initialValue, 20.1), '检查点恢复初值 20.1')
    check(approx((await db.observations.get('ob-22'))!.cumulative, 27.4), '检查点恢复连续累计 27.4')
    clearSuccessionCheckpoint()
  }

  console.log('\n[5] 首读延迟继承')
  {
    const rows: PointRow[] = [
      { id: 'pA', sectionId: 'sec-2', damId: 'dam-1', code: 'T-A', type: '表面位移', initialValue: 0, threshold: 30, unit: 'mm', installDate: '2024-01-01', createdAt: now(), updatedAt: now() },
      { id: 'pB', sectionId: 'sec-2', damId: 'dam-1', code: 'T-B', type: '表面位移', initialValue: 100, threshold: 30, unit: 'mm', installDate: '2024-07-01', createdAt: now(), updatedAt: now() }
    ]
    await db.points.bulkPut(rows)
    await db.observations.put({ id: 'oA1', pointId: 'pA', date: '2024-07-01', reading: 12, cumulative: 12, dailyRate: 0, observer: 'x', createdAt: now(), updatedAt: now() })
    const link = await applySuccession({ predecessorId: 'pA', successorId: 'pB', effectiveDate: '2024-07-05', note: '' })
    check(!link.inherited && link.inheritedCumulative === 12, '无新点读数时延迟扣减，但继承量可预知')
    check(approx((await db.points.get('pB'))!.initialValue, 100), '延迟期间不动新点初值')
    await putObservation({ id: 'oB1', pointId: 'pB', date: '2024-07-05', reading: 113, observer: 'x', createdAt: now(), updatedAt: now() })
    const after = await db.successions.get(link.id)
    check(after!.inherited && approx(after!.inheritedCumulative ?? NaN, 12), '首读后继承旧点累计 12')
    check(approx((await db.points.get('pB'))!.initialValue, 101), '新点初值 = 113 − 12 = 101')
    const first = await db.observations.get('oB1')
    check(approx(first!.cumulative, 12) && approx(first!.dailyRate, 0), '首读连续累计 12、跨链速率 0')
    await putObservation({ id: 'oB2', pointId: 'pB', date: '2024-07-06', reading: 115, observer: 'x', createdAt: now(), updatedAt: now() })
    const second = await db.observations.get('oB2')
    check(approx(second!.cumulative, 14) && approx(second!.dailyRate, 2), '后续读数 14 / 2')
  }

  console.log('\n[6] 即时继承与校验规则')
  {
    const rows: PointRow[] = [
      { id: 'pC', sectionId: 'sec-2', damId: 'dam-1', code: 'T-C', type: '浸润线', initialValue: 10, threshold: 2, unit: 'm', installDate: '2024-01-01', createdAt: now(), updatedAt: now() },
      { id: 'pD', sectionId: 'sec-2', damId: 'dam-1', code: 'T-D', type: '浸润线', initialValue: 50, threshold: 2, unit: 'm', installDate: '2024-08-01', createdAt: now(), updatedAt: now() }
    ]
    await db.points.bulkPut(rows)
    await db.observations.bulkPut([
      { id: 'oC1', pointId: 'pC', date: '2024-08-01', reading: 11.5, cumulative: 1.5, dailyRate: 0, observer: 'x', createdAt: now(), updatedAt: now() },
      { id: 'oD1', pointId: 'pD', date: '2024-08-02', reading: 52, cumulative: 2, dailyRate: 0, observer: 'x', createdAt: now(), updatedAt: now() }
    ])
    const preview = await previewSuccession({ predecessorId: 'pC', successorId: 'pD', effectiveDate: '2024-08-02', note: '' })
    check(
      preview.inheritMode === 'immediate' &&
        preview.retainedObservationCount === 1 &&
        preview.recalculatedObservationCount === 1 &&
        preview.openAlarmCount === 0,
      '影响预览：即时继承、受影响观测与未闭环预警计数正确'
    )
    const link = await applySuccession({ predecessorId: 'pC', successorId: 'pD', effectiveDate: '2024-08-02', note: '' })
    check(link.inherited && approx(link.inheritedCumulative ?? NaN, 1.5), '即时继承 1.5')
    check(approx((await db.points.get('pD'))!.initialValue, 50.5), '新点初值 50.5')
    const recalculated = await db.observations.get('oD1')
    check(approx(recalculated!.cumulative, 1.5) && approx(recalculated!.dailyRate, 0), '新点读数重算 1.5 / 0')

    await rejects(
      applySuccession({ predecessorId: 'pC', successorId: 'pt-3', effectiveDate: '2024-08-03', note: '' }),
      /已有生效接替/,
      '拒绝旧点重复接替'
    )
    await rejects(
      applySuccession({ predecessorId: 'pt-3', successorId: 'pD', effectiveDate: '2024-08-03', note: '' }),
      /已在接替/,
      '拒绝新点重复进入关系'
    )
    await rejects(
      applySuccession({ predecessorId: 'pC', successorId: 'pC', effectiveDate: '2024-08-03', note: '' }),
      /不能相同/,
      '拒绝旧新测点相同'
    )
    await rejects(
      applySuccession({ predecessorId: 'pC', successorId: 'pA', effectiveDate: '2024-08-03', note: '' }),
      /类型必须一致/,
      '拒绝跨类型接替'
    )
  }

  console.log('\n[7] 链中测点删除保护')
  await rejects(deletePointCascade('pt-10'), /接替链/, '拒绝删除生效链中的新点')
  await deletePointCascade('pt-4')
  check(!(await db.points.get('pt-4')), '无关系测点可正常删除')

  console.log('\n[8] 多级链 A→B→E 连续，撤下只能从链尾')
  {
    await db.points.put({ id: 'pE', sectionId: 'sec-2', damId: 'dam-1', code: 'T-E', type: '表面位移', initialValue: 9, threshold: 30, unit: 'mm', installDate: '2024-08-01', createdAt: now(), updatedAt: now() })
    await db.observations.put({ id: 'oE1', pointId: 'pE', date: '2024-08-02', reading: 24, cumulative: 0, dailyRate: 0, observer: 'x', createdAt: now(), updatedAt: now() })
    const tailLink = await applySuccession({ predecessorId: 'pB', successorId: 'pE', effectiveDate: '2024-08-02', note: '' })
    check(tailLink.inherited && approx(tailLink.inheritedCumulative ?? NaN, 14), '二级继承 pB 的累计 14')
    check(approx((await db.points.get('pE'))!.initialValue, 10), 'pE 初值 24 − 14 = 10')
    const inherited = await db.observations.get('oE1')
    check(approx(inherited!.cumulative, 14) && approx(inherited!.dailyRate, 0), 'pE 首读 14 / 0')
    const index = buildChainIndex(await db.successions.toArray())
    check(chainHeadOf('pE', index) === 'pA', '三级链头为 pA')
    const summary = summarizeChain('pA', index, await db.observations.toArray())
    check(summary.latest!.pointId === 'pE' && approx(summary.latest!.cumulative, 14), '链末 pE 连续累计 14')
    // 找上游 pA→pB 关系，非链尾不允许撤下
    const upstream = (await db.successions.where('successorId').equals('pB').toArray())[0]
    await rejects(revokeSuccession(upstream.id), /末端/, '拒绝撤下非链尾关系')
    const tail = await revokeSuccession(tailLink.id)
    check(tail.status === '已撤下', '链尾关系可撤下')
    const up = await revokeSuccession(upstream.id)
    check(up.status === '已撤下', '撤下末端后上游可依次撤下')
  }

  console.log('\n[9] 备份与导入携带接替关系')
  {
    const snapshot = await exportSnapshot()
    check(
      Array.isArray(snapshot.successions) && snapshot.successions!.some((item) => item.id === 'su-1'),
      '导出包含 successions'
    )
    check(snapshot.dbVersion === 3, '结构版本为 3')
    await importSnapshot(snapshot)
    check((await db.successions.count()) === snapshot.successions!.length, '导入恢复接替关系')
  }

  console.log(`\n全部 ${passed} 条断言通过 ✅`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
