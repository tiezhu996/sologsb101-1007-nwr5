/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号 + upgrade 迁移
 * - 级联删除、整库导入导出、首屏幂等播种
 */
import Dexie, { type Table } from 'dexie'
import type { Dam } from '@/types/dam'
import type { Section } from '@/types/section'
import type { Point } from '@/types/point'
import type { Observation } from '@/types/observation'
import type { Alarm } from '@/types/alarm'
import type { Pool } from '@/types/pool'
import type { Succession, SuccessionDraft } from '@/types/succession'
import { cumulativeOf, dailyRateOf, daysBetween, round } from '@/utils/threshold'

/**
 * 跨接替关系的日速率口径：
 * 新旧测点读数零位不同，不能用原始读数差；应比较沿链连续累计量之差。
 */
function continuousDailyRateOf(currentCumulative: number, basisCumulative: number, days: number): number {
  const span = days > 0 ? days : 1
  return round(Math.abs(currentCumulative - basisCumulative) / span, 4)
}

export const DB_NAME = 'gbtaildam'
export const DB_VERSION = 3

export const LS_KEYS = {
  dbVersion: 'gbtaildam:db-version',
  lastBackupAt: 'gbtaildam:last-backup-at',
  uiPrefs: 'gbtaildam:ui-prefs',
  successionCheckpoint: 'gbtaildam:succession-checkpoint'
} as const

export interface UiPrefs {
  lastDamId: string | null
  alarmOnlyOpen: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastDamId: null, alarmOnlyOpen: false }

export interface BackupPayload {
  app: 'gbtaildam'
  dbVersion: number
  exportedAt: string
  dams: Dam[]
  sections: Section[]
  points: Point[]
  observations: Observation[]
  alarms: Alarm[]
  pools: Pool[]
  successions?: Succession[]
}

export interface Revisioned {
  revision?: number
}

export const ROW_REVISION = 3

export type DamRow = Dam & Revisioned
export type SectionRow = Section & Revisioned
export type PointRow = Point & Revisioned
export type ObservationRow = Observation & Revisioned
export type AlarmRow = Alarm & Revisioned
export type PoolRow = Pool & Revisioned
export type SuccessionRow = Succession & Revisioned

class TailDamDatabase extends Dexie {
  dams!: Table<DamRow, string>
  sections!: Table<SectionRow, string>
  points!: Table<PointRow, string>
  observations!: Table<ObservationRow, string>
  alarms!: Table<AlarmRow, string>
  pools!: Table<PoolRow, string>
  successions!: Table<SuccessionRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      dams: 'id, name, damType, grade',
      sections: 'id, damId, stakeNo',
      points: 'id, sectionId, code, type',
      observations: 'id, pointId, date',
      alarms: 'id, pointId, level, state',
      pools: 'id, damId, date'
    })

    // v2：测点/预警补 damId 冗余列（按坝体筛选免联表）；全部表补 revision 行修订号
    this.version(DB_VERSION)
      .stores({
        dams: 'id, name, damType, grade, updatedAt',
        sections: 'id, damId, stakeNo, updatedAt',
        points: 'id, sectionId, damId, code, type, updatedAt',
        observations: 'id, pointId, date, observer, updatedAt',
        alarms: 'id, pointId, damId, level, state, updatedAt',
        pools: 'id, damId, date, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移 1：为全部业务行补齐 revision
        for (const name of ['dams', 'sections', 'points', 'observations', 'alarms', 'pools']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }

        // 迁移 2：测点缺少 damId 时用所属断面回填
        const sections = (await tx.table('sections').toArray()) as Array<{ id: string; damId: string }>
        const damOfSection = new Map(sections.map((section) => [section.id, section.damId]))
        await tx
          .table('points')
          .toCollection()
          .modify((point: Record<string, unknown>) => {
            if (typeof point.damId !== 'string' || point.damId.length === 0) {
              point.damId = damOfSection.get(String(point.sectionId)) ?? ''
            }
            if (typeof point.threshold !== 'number' || !Number.isFinite(point.threshold)) {
              point.threshold = 25
            }
          })

        // 迁移 3：预警缺少 damId 时用测点回填；补齐 handler / measure 字段
        const points = (await tx.table('points').toArray()) as Array<{ id: string; damId: string }>
        const damOfPoint = new Map(points.map((point) => [point.id, point.damId]))
        await tx
          .table('alarms')
          .toCollection()
          .modify((alarm: Record<string, unknown>) => {
            if (typeof alarm.damId !== 'string' || alarm.damId.length === 0) {
              alarm.damId = damOfPoint.get(String(alarm.pointId)) ?? ''
            }
            if (typeof alarm.handler !== 'string') alarm.handler = ''
            if (typeof alarm.measure !== 'string') alarm.measure = ''
          })
      })

    // v3：新增测点接替关系表 successions；旧数据无需回填——
    // 每个无关系测点在链计算中天然作为「单点链」处理（旧数据自动补成单点链）。
    this.version(DB_VERSION)
      .stores({
        dams: 'id, name, damType, grade, updatedAt',
        sections: 'id, damId, stakeNo, updatedAt',
        points: 'id, sectionId, damId, code, type, updatedAt',
        observations: 'id, pointId, date, observer, updatedAt',
        alarms: 'id, pointId, damId, level, state, updatedAt',
        pools: 'id, damId, date, updatedAt',
        successions: 'id, predecessorId, successorId, damId, effectiveDate, status, updatedAt'
      })
      .upgrade(async (tx) => {
        // 行修订号统一升到 v3
        for (const name of ['dams', 'sections', 'points', 'observations', 'alarms', 'pools']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }
      })
  }
}

export const db = new TailDamDatabase()

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/* ============================ 演示数据播种 ============================ */

const SEED_STAMP = Date.parse('2024-06-12T09:00:00+08:00')
const stamp = (offsetDays = 0): number => SEED_STAMP + offsetDays * 86400000

const SEED_DAMS: DamRow[] = [
  { id: 'dam-1', name: '尾矿库 A 坝', damType: '上游式', finalHeightM: 68, grade: '三等', commissionDate: '2012-06-30', createdAt: stamp(-400), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dam-2', name: '尾矿库 B 坝', damType: '中线式', finalHeightM: 45, grade: '四等', commissionDate: '2018-09-15', createdAt: stamp(-360), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_SECTIONS: SectionRow[] = [
  { id: 'sec-1', damId: 'dam-1', stakeNo: '0+120', slopeRatio: 2.5, elevationM: 712.5, createdAt: stamp(-390), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'sec-2', damId: 'dam-1', stakeNo: '0+260', slopeRatio: 2.8, elevationM: 713.2, createdAt: stamp(-389), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'sec-3', damId: 'dam-2', stakeNo: '0+080', slopeRatio: 2.2, elevationM: 645.0, createdAt: stamp(-350), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'sec-4', damId: 'dam-2', stakeNo: '0+180', slopeRatio: 2.4, elevationM: 645.6, createdAt: stamp(-349), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_POINTS: PointRow[] = [
  { id: 'pt-1', sectionId: 'sec-1', damId: 'dam-1', code: 'DB-01', type: '表面位移', initialValue: 0, threshold: 25, unit: 'mm', installDate: '2021-03-18', createdAt: stamp(-380), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-2', sectionId: 'sec-1', damId: 'dam-1', code: 'CX-01', type: '测斜', initialValue: 0, threshold: 30, unit: 'mm', installDate: '2021-03-18', createdAt: stamp(-380), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-3', sectionId: 'sec-1', damId: 'dam-1', code: 'JR-01', type: '浸润线', initialValue: 12.6, threshold: 2, unit: 'm', installDate: '2021-04-02', createdAt: stamp(-379), updatedAt: stamp(-3), revision: ROW_REVISION },
  { id: 'pt-4', sectionId: 'sec-2', damId: 'dam-1', code: 'DB-02', type: '表面位移', initialValue: 0, threshold: 25, unit: 'mm', installDate: '2021-03-20', createdAt: stamp(-378), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-5', sectionId: 'sec-2', damId: 'dam-1', code: 'SY-01', type: '渗压', initialValue: 45, threshold: 8, unit: 'kPa', installDate: '2021-04-06', createdAt: stamp(-377), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'pt-6', sectionId: 'sec-2', damId: 'dam-1', code: 'JR-02', type: '浸润线', initialValue: 13.1, threshold: 2, unit: 'm', installDate: '2021-04-06', createdAt: stamp(-377), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'pt-7', sectionId: 'sec-3', damId: 'dam-2', code: 'DB-03', type: '表面位移', initialValue: 0, threshold: 20, unit: 'mm', installDate: '2022-05-11', createdAt: stamp(-340), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-8', sectionId: 'sec-3', damId: 'dam-2', code: 'CX-02', type: '测斜', initialValue: 0, threshold: 24, unit: 'mm', installDate: '2022-05-11', createdAt: stamp(-340), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-9', sectionId: 'sec-4', damId: 'dam-2', code: 'SY-02', type: '渗压', initialValue: 38.5, threshold: 6, unit: 'kPa', installDate: '2022-05-18', createdAt: stamp(-339), updatedAt: stamp(-1), revision: ROW_REVISION },
  // pt-1（DB-01）损坏后的接替点：初值 20.1 = 首读数 47.5 − 继承累计量 27.4
  { id: 'pt-10', sectionId: 'sec-1', damId: 'dam-1', code: 'DB-01R', type: '表面位移', initialValue: 20.1, threshold: 25, unit: 'mm', installDate: '2024-06-10', createdAt: stamp(-2), updatedAt: stamp(-1), revision: ROW_REVISION }
]

/** 播种用的观测原始行：[测点, 日期, 读数, 观测人] */
const SEED_OBSERVATION_ROWS: Array<[string, string, number, string]> = [
  ['pt-1', '2024-04-10', 8.2, '刘振国'],
  ['pt-1', '2024-05-10', 15.4, '刘振国'],
  ['pt-1', '2024-06-09', 27.4, '陈文'],
  ['pt-2', '2024-04-10', 9.6, '刘振国'],
  ['pt-2', '2024-05-10', 16.2, '陈文'],
  ['pt-2', '2024-06-09', 27.9, '陈文'],
  ['pt-3', '2024-04-11', 12.8, '王丽'],
  ['pt-3', '2024-05-11', 13.4, '王丽'],
  ['pt-3', '2024-06-10', 14.9, '王丽'],
  ['pt-4', '2024-04-11', 5.4, '刘振国'],
  ['pt-4', '2024-06-10', 11.2, '刘振国'],
  ['pt-5', '2024-04-12', 46.8, '王丽'],
  ['pt-5', '2024-06-11', 51.6, '王丽'],
  ['pt-6', '2024-04-12', 13.3, '陈文'],
  ['pt-6', '2024-06-11', 13.9, '陈文'],
  ['pt-7', '2024-04-13', 6.8, '赵鹏'],
  ['pt-7', '2024-06-11', 14.2, '赵鹏'],
  ['pt-8', '2024-04-13', 7.5, '赵鹏'],
  ['pt-8', '2024-06-11', 18.4, '赵鹏'],
  ['pt-9', '2024-04-14', 39.6, '赵鹏'],
  ['pt-9', '2024-06-11', 44.2, '赵鹏'],
  // pt-10 自接替日 2024-06-10 起接续 pt-1：连续累计量 27.4（首读继承）→ 28.3
  ['pt-10', '2024-06-10', 47.5, '陈文'],
  ['pt-10', '2024-06-11', 48.4, '陈文']
]

const SEED_ALARMS: AlarmRow[] = [
  { id: 'al-1', pointId: 'pt-1', damId: 'dam-1', level: '橙', triggerValue: 27.4, triggerDate: '2024-06-09', state: '待处置', handler: '', measure: '', createdAt: stamp(-2), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'al-2', pointId: 'pt-3', damId: 'dam-1', level: '橙', triggerValue: 2.3, triggerDate: '2024-06-10', state: '处置中', handler: '王丽', measure: '加密浸润线观测至每周一次，同时降低库水位', createdAt: stamp(-2), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'al-3', pointId: 'pt-9', damId: 'dam-2', level: '黄', triggerValue: 5.7, triggerDate: '2024-06-11', state: '待处置', handler: '', measure: '', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'al-4', pointId: 'pt-2', damId: 'dam-1', level: '黄', triggerValue: 27.9, triggerDate: '2024-06-09', state: '已闭环', handler: '陈文', measure: '复核测斜孔，补充人工观测，位移稳定后闭环', createdAt: stamp(-2), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'al-5', pointId: 'pt-5', damId: 'dam-1', level: '蓝', triggerValue: 6.6, triggerDate: '2024-06-11', state: '已闭环', handler: '王丽', measure: '渗压计校核后复测，读数正常', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'al-6', pointId: 'pt-7', damId: 'dam-2', level: '蓝', triggerValue: 14.2, triggerDate: '2024-06-11', state: '待处置', handler: '', measure: '', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_POOLS: PoolRow[] = [
  { id: 'pl-1', damId: 'dam-1', date: '2024-04-10', waterLevelM: 709.8, beachLengthM: 132, freeboardM: 2.7, createdAt: stamp(-63), updatedAt: stamp(-63), revision: ROW_REVISION },
  { id: 'pl-2', damId: 'dam-1', date: '2024-05-10', waterLevelM: 710.4, beachLengthM: 118, freeboardM: 2.1, createdAt: stamp(-33), updatedAt: stamp(-33), revision: ROW_REVISION },
  { id: 'pl-3', damId: 'dam-1', date: '2024-06-09', waterLevelM: 711.1, beachLengthM: 96, freeboardM: 1.4, createdAt: stamp(-2), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pl-4', damId: 'dam-2', date: '2024-05-10', waterLevelM: 642.1, beachLengthM: 88, freeboardM: 2.9, createdAt: stamp(-33), updatedAt: stamp(-33), revision: ROW_REVISION },
  { id: 'pl-5', damId: 'dam-2', date: '2024-06-09', waterLevelM: 643.4, beachLengthM: 74, freeboardM: 1.8, createdAt: stamp(-2), updatedAt: stamp(-2), revision: ROW_REVISION }
]

/**
 * 演示接替：表面位移测点 DB-01（pt-1）2024-06-09 观测后损坏，
 * 2024-06-10 起由 DB-01R（pt-10）接续。旧点橙色预警 al-1 不自动改挂。
 */
const SEED_SUCCESSIONS: SuccessionRow[] = [
  {
    id: 'su-1',
    predecessorId: 'pt-1',
    successorId: 'pt-10',
    damId: 'dam-1',
    effectiveDate: '2024-06-10',
    inheritedCumulative: 27.4,
    basisObservationId: 'ob-3',
    basisObservationDate: '2024-06-09',
    inherited: true,
    note: '原测点被落石击损，桩位旁 0.5 m 重新埋设 DB-01R',
    status: '生效',
    createdAt: stamp(-2),
    updatedAt: stamp(-2),
    revision: ROW_REVISION
  }
]

/** 由原始行派生累计变化量与日速率（跨接替关系的第一档按旧点基准读数计算） */
function buildSeedObservations(): ObservationRow[] {
  const previousByPoint = new Map<string, { date: string; reading: number }>()
  return SEED_OBSERVATION_ROWS.map(([pointId, date, reading, observer], index) => {
    const point = SEED_POINTS.find((item) => item.id === pointId)
    const initialValue = point ? point.initialValue : 0
    const previous = previousByPoint.get(pointId)
    let dailyRate = previous ? dailyRateOf(reading, previous.reading, daysBetween(previous.date, date)) : 0
    previousByPoint.set(pointId, { date, reading })
    // 新点首读数（自身无更早读数）且存在生效接替时，用旧点基准读数跨链接档
    if (!previous) {
      const link = SEED_SUCCESSIONS.find(
        (item) => item.successorId === pointId && item.status === '生效' && date >= item.effectiveDate
      )
      if (link) {
        const basis = SEED_OBSERVATION_ROWS
          .filter(([pid, rowDate]) => pid === link.predecessorId && rowDate < link.effectiveDate)
          .pop()
        if (basis) {
          const basisPoint = SEED_POINTS.find((item) => item.id === basis[0])
          const basisCumulative = cumulativeOf(basis[2], basisPoint ? basisPoint.initialValue : 0)
          dailyRate = continuousDailyRateOf(
            cumulativeOf(reading, initialValue),
            basisCumulative,
            daysBetween(basis[1], date)
          )
        }
      }
    }
    return {
      id: `ob-${index + 1}`,
      pointId,
      date,
      reading,
      cumulative: cumulativeOf(reading, initialValue),
      dailyRate,
      observer,
      createdAt: stamp(-200 + index),
      updatedAt: stamp(-200 + index),
      revision: ROW_REVISION
    }
  })
}

export async function seedDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.dams, db.sections, db.points, db.observations, db.alarms, db.pools, db.successions],
    async () => {
      await db.dams.bulkPut(SEED_DAMS)
      await db.sections.bulkPut(SEED_SECTIONS)
      await db.points.bulkPut(SEED_POINTS)
      await db.observations.bulkPut(buildSeedObservations())
      await db.alarms.bulkPut(SEED_ALARMS)
      await db.pools.bulkPut(SEED_POOLS)
      await db.successions.bulkPut(SEED_SUCCESSIONS)
    }
  )
}

/** 首屏调用：打开数据库并在主表为空时播种演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.dams.count()) === 0) {
    await seedDatabase()
  }
}

/* ============================== 级联删除 ============================== */

export async function deleteDamCascade(damId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.dams, db.sections, db.points, db.observations, db.alarms, db.pools, db.successions],
    async () => {
      const sections = await db.sections.where('damId').equals(damId).toArray()
      await deletePointsOfSections(sections.map((section) => section.id))
      if (sections.length > 0) await db.sections.bulkDelete(sections.map((section) => section.id))
      await db.pools.where('damId').equals(damId).delete()
      await db.successions.where('damId').equals(damId).delete()
      await db.dams.delete(damId)
    }
  )
}

export async function deleteSectionCascade(sectionId: string): Promise<void> {
  await db.transaction('rw', db.sections, db.points, db.observations, db.alarms, db.successions, async () => {
    await deletePointsOfSections([sectionId])
    await db.sections.delete(sectionId)
  })
}

/**
 * 删除单个测点。
 * 测点仍在生效的接替链中（已接替他点或正被接替）时拒绝删除：
 * 需先在测点接替页撤下关系；只涉及已撤下关系时随测点一并清理。
 */
export async function deletePointCascade(pointId: string): Promise<void> {
  const active = await db.successions
    .where('status')
    .equals('生效')
    .filter((link) => link.predecessorId === pointId || link.successorId === pointId)
    .first()
  if (active) {
    throw new Error('该测点仍在生效的接替链中，请先撤下接替关系后再删除')
  }
  await db.transaction('rw', db.points, db.observations, db.alarms, db.successions, async () => {
    await db.observations.where('pointId').equals(pointId).delete()
    await db.alarms.where('pointId').equals(pointId).delete()
    // 已撤下的历史接替关系失去一方即无展示意义，随测点清理
    await db.successions
      .filter((link) => link.predecessorId === pointId || link.successorId === pointId)
      .delete()
    await db.points.delete(pointId)
  })
}

async function deletePointsOfSections(sectionIds: string[]): Promise<void> {
  if (sectionIds.length === 0) return
  const points = await db.points.where('sectionId').anyOf(sectionIds).toArray()
  const pointIds = points.map((point) => point.id)
  if (pointIds.length > 0) {
    await db.observations.where('pointId').anyOf(pointIds).delete()
    await db.alarms.where('pointId').anyOf(pointIds).delete()
    await db.successions
      .filter((link) => pointIds.includes(link.predecessorId) || pointIds.includes(link.successorId))
      .delete()
    await db.points.bulkDelete(pointIds)
  }
}

/* ============================ 整库导入导出 ============================ */

export async function countAll(): Promise<Record<string, number>> {
  const [dams, sections, points, observations, alarms, pools, successions] = await Promise.all([
    db.dams.count(),
    db.sections.count(),
    db.points.count(),
    db.observations.count(),
    db.alarms.count(),
    db.pools.count(),
    db.successions.count()
  ])
  return { dams, sections, points, observations, alarms, pools, successions }
}

export async function exportSnapshot(): Promise<BackupPayload> {
  const [dams, sections, points, observations, alarms, pools, successions] = await Promise.all([
    db.dams.toArray(),
    db.sections.toArray(),
    db.points.toArray(),
    db.observations.toArray(),
    db.alarms.toArray(),
    db.pools.toArray(),
    db.successions.toArray()
  ])
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row
    return rest
  }
  return {
    app: 'gbtaildam',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    dams: dams.map(strip),
    sections: sections.map(strip),
    points: points.map(strip),
    observations: observations.map(strip),
    alarms: alarms.map(strip),
    pools: pools.map(strip),
    successions: successions.map(strip)
  }
}

export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction(
    'rw',
    [db.dams, db.sections, db.points, db.observations, db.alarms, db.pools, db.successions],
    async () => {
      await Promise.all([
        db.dams.clear(),
        db.sections.clear(),
        db.points.clear(),
        db.observations.clear(),
        db.alarms.clear(),
        db.pools.clear(),
        db.successions.clear()
      ])
      const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
      await db.dams.bulkPut((payload.dams ?? []).map(rev))
      await db.sections.bulkPut((payload.sections ?? []).map(rev))
      await db.points.bulkPut((payload.points ?? []).map(rev))
      await db.observations.bulkPut((payload.observations ?? []).map(rev))
      await db.alarms.bulkPut((payload.alarms ?? []).map(rev))
      await db.pools.bulkPut((payload.pools ?? []).map(rev))
      await db.successions.bulkPut((payload.successions ?? []).map(rev))
    }
  )
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.dams, db.sections, db.points, db.observations, db.alarms, db.pools, db.successions],
    async () => {
      await Promise.all([
        db.dams.clear(),
        db.sections.clear(),
        db.points.clear(),
        db.observations.clear(),
        db.alarms.clear(),
        db.pools.clear(),
        db.successions.clear()
      ])
    }
  )
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/**
 * 观测录入：写入累计变化量与日速率。
 *
 * 若写入测点是某生效接替关系的新测点且尚未完成继承，则本次读数（日期 >= 接替日）
 * 即「接替后首读数」：从旧点基准读数继承累计量、扣减进新点初值并重算全部读数，
 * 使累计位移与日速率沿接续链连续。旧点观测始终不被改写。
 */
export async function putObservation(
  row: Omit<Observation, 'cumulative' | 'dailyRate'> & { cumulative?: number; dailyRate?: number }
): Promise<ObservationRow> {
  return db.transaction('rw', [db.points, db.observations, db.successions], async () => {
    const point = await db.points.get(row.pointId)
    const now = Date.now()
    // 首读延迟继承
    const incoming = await db.successions
      .where('status')
      .equals('生效')
      .filter((link) => link.successorId === row.pointId)
      .first()
    if (point && incoming && !incoming.inherited && row.date >= incoming.effectiveDate) {
      const predecessorRows = await db.observations.where('pointId').equals(incoming.predecessorId).toArray()
      const basis =
        predecessorRows.filter((item) => item.date < incoming.effectiveDate).sort((a, b) => a.date.localeCompare(b.date)).pop() ??
        predecessorRows.sort((a, b) => a.date.localeCompare(b.date)).pop() ??
        null
      const inherited = basis ? basis.cumulative : 0
      const firstInitial = round(row.reading - inherited, 4)
      await db.points.update(point.id, { initialValue: firstInitial, updatedAt: now })
      await db.successions.update(incoming.id, {
        inherited: true,
        inheritedCumulative: inherited,
        basisObservationId: basis ? basis.id : null,
        basisObservationDate: basis ? basis.date : null,
        updatedAt: now
      })
      await recalculateSuccessorInTx(point.id, incoming, firstInitial)
      // 继承基准行可能就是本次行（旧点无观测、新点首读），继续走下方正常写入会重复，
      // 但 bulkPut 幂等；先把刚存的行取出回填累计/速率即可。
      const stored = await db.observations.get(row.id)
      if (stored) return stored
    }

    const effectiveInitial = await db.points.get(row.pointId)
    const initialValue = effectiveInitial ? effectiveInitial.initialValue : point ? point.initialValue : 0
    const others = (await db.observations.where('pointId').equals(row.pointId).toArray())
      .filter((item) => item.id !== row.id)
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt)

    let previous = others.filter((item) => item.date < row.date).pop() ?? null
    // 新点、尚未链到更早本点读数时，跨接替关系取旧点基准读数
    if (!previous) {
      const link = await db.successions
        .where('status')
        .equals('生效')
        .filter((item) => item.successorId === row.pointId && row.date >= item.effectiveDate)
        .first()
      if (link) {
        const predecessorRows = (await db.observations.where('pointId').equals(link.predecessorId).toArray()).sort((a, b) =>
          a.date.localeCompare(b.date)
        )
        const basis = predecessorRows.filter((item) => item.date < link.effectiveDate).pop() ?? predecessorRows.pop() ?? null
        if (basis) previous = basis
      }
    }

    const cumulative = cumulativeOf(row.reading, initialValue)
    let dailyRate: number
    if (previous && previous.pointId === row.pointId) {
      dailyRate = dailyRateOf(row.reading, previous.reading, daysBetween(previous.date, row.date))
    } else if (previous) {
      // 跨接替关系：基准是旧点，读数零位不同，按连续累计量之差计算日速率
      dailyRate = continuousDailyRateOf(cumulative, previous.cumulative, daysBetween(previous.date, row.date))
    } else {
      dailyRate = 0
    }
    const next: ObservationRow = {
      ...row,
      cumulative,
      dailyRate,
      revision: ROW_REVISION
    }
    await db.observations.put(next)
    return next
  })
}

/**
 * 重算某测点全部观测的累计变化量与日速率。
 * 已继承的新测点：生效日起的读数跨关系取旧点基准算第一档日速率；
 * 生效日前的调试读数按该点自身初值序列计算，不进入接续链。
 */
export async function recalculateObservations(pointId: string): Promise<void> {
  await db.transaction('rw', [db.points, db.observations, db.successions], async () => {
    const point = await db.points.get(pointId)
    if (!point) return
    const incoming = await db.successions
      .where('status')
      .equals('生效')
      .filter((link) => link.successorId === pointId)
      .first()
    if (incoming && incoming.inherited) {
      await recalculateSuccessorInTx(pointId, incoming, point.initialValue)
      return
    }
    await recalculatePlainInTx(pointId, point.initialValue)
  })
}

/** 事务内：普通测点（链头 / 无关节点）按自身初值重算 */
async function recalculatePlainInTx(pointId: string, initialValue: number): Promise<void> {
  const rows = (await db.observations.where('pointId').equals(pointId).toArray()).sort(
    (a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt
  )
  const patches = rows.map((row, index) => {
    const previous = index === 0 ? null : rows[index - 1]
    return {
      ...row,
      cumulative: cumulativeOf(row.reading, initialValue),
      dailyRate: previous ? dailyRateOf(row.reading, previous.reading, daysBetween(previous.date, row.date)) : 0,
      updatedAt: Date.now()
    }
  })
  if (patches.length > 0) await db.observations.bulkPut(patches)
}

/** 事务内：已继承新点重算（跨关系第一档日速率以旧点基准读数计算） */
async function recalculateSuccessorInTx(
  pointId: string,
  link: SuccessionRow,
  initialValue: number
): Promise<void> {
  const all = (await db.observations.where('pointId').equals(pointId).toArray()).sort(
    (a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt
  )
  // 生效日前的调试读数：按点自身序列，日速率不跨关系
  const before = all.filter((row) => row.date < link.effectiveDate)
  const onAfter = all.filter((row) => row.date >= link.effectiveDate)

  const predecessorRows = (await db.observations.where('pointId').equals(link.predecessorId).toArray()).sort((a, b) =>
    a.date.localeCompare(b.date)
  )
  const basis = predecessorRows.filter((row) => row.date < link.effectiveDate).pop() ?? predecessorRows.pop() ?? null

  const patches: ObservationRow[] = []
  before.forEach((row, index) => {
    const previous = index === 0 ? null : before[index - 1]
    patches.push({
      ...row,
      cumulative: cumulativeOf(row.reading, initialValue),
      dailyRate: previous ? dailyRateOf(row.reading, previous.reading, daysBetween(previous.date, row.date)) : 0,
      updatedAt: Date.now()
    })
  })
  onAfter.forEach((row, index) => {
    if (index === 0 && basis) {
      patches.push({
        ...row,
        cumulative: cumulativeOf(row.reading, initialValue),
        dailyRate: continuousDailyRateOf(
          cumulativeOf(row.reading, initialValue),
          basis.cumulative,
          daysBetween(basis.date, row.date)
        ),
        updatedAt: Date.now()
      })
      return
    }
    const previous = index === 0 ? null : onAfter[index - 1]
    patches.push({
      ...row,
      cumulative: cumulativeOf(row.reading, initialValue),
      dailyRate: previous ? dailyRateOf(row.reading, previous.reading, daysBetween(previous.date, row.date)) : 0,
      updatedAt: Date.now()
    })
  })
  if (patches.length > 0) await db.observations.bulkPut(patches)
}

/* ============================ 测点接替（独立关系） ============================ */

/** 接替写入前的检查点：写失败 / 撤下后反悔时可整段恢复 */
export interface SuccessionCheckpoint {
  createdAt: number
  reason: string
  action: 'apply' | 'revoke'
  linkId: string
  predecessorId: string
  successorId: string
  succession: SuccessionRow | null
  points: PointRow[]
  observations: ObservationRow[]
}

export function saveSuccessionCheckpoint(checkpoint: SuccessionCheckpoint): void {
  localStorage.setItem(LS_KEYS.successionCheckpoint, JSON.stringify(checkpoint))
}

export function readSuccessionCheckpoint(): SuccessionCheckpoint | null {
  try {
    const raw = localStorage.getItem(LS_KEYS.successionCheckpoint)
    return raw ? (JSON.parse(raw) as SuccessionCheckpoint) : null
  } catch {
    return null
  }
}

export function clearSuccessionCheckpoint(): void {
  localStorage.removeItem(LS_KEYS.successionCheckpoint)
}

/** 从检查点恢复（幂等：关系、测点初值、受影响观测整体回到检查点快照） */
export async function restoreSuccessionCheckpoint(checkpoint: SuccessionCheckpoint): Promise<void> {
  await db.transaction('rw', [db.successions, db.points, db.observations], async () => {
    await db.successions.delete(checkpoint.linkId)
    if (checkpoint.succession) await db.successions.put(checkpoint.succession)
    if (checkpoint.points.length > 0) await db.points.bulkPut(checkpoint.points)
    const ids = new Set(checkpoint.observations.map((row) => row.id))
    const current = await db.observations.where('pointId').anyOf([checkpoint.predecessorId, checkpoint.successorId]).toArray()
    const toDelete = current.filter((row) => !ids.has(row.id)).map((row) => row.id)
    if (toDelete.length > 0) await db.observations.bulkDelete(toDelete)
    if (checkpoint.observations.length > 0) await db.observations.bulkPut(checkpoint.observations)
  })
}

export interface SuccessionPreviewResult {
  draft: SuccessionDraft
  predecessor: PointRow
  successor: PointRow
  retainedObservationCount: number
  recalculatedObservationCount: number
  openAlarmCount: number
  inheritedCumulative: number | null
  basisObservationDate: string | null
  inheritMode: 'immediate' | 'firstReading'
}

/** 接替生效前的影响预览：列出受影响观测与未闭环预警，不写库 */
export async function previewSuccession(draft: SuccessionDraft): Promise<SuccessionPreviewResult> {
  const predecessor = await db.points.get(draft.predecessorId)
  const successor = await db.points.get(draft.successorId)
  if (!predecessor) throw new Error('旧测点不存在或已删除')
  if (!successor) throw new Error('新测点不存在或已删除')
  if (predecessor.id === successor.id) throw new Error('旧测点与新测点不能相同')
  if (predecessor.type !== successor.type) throw new Error('新旧测点类型必须一致，才能接续累计位移')

  const outgoing = await db.successions
    .where('status')
    .equals('生效')
    .filter((link) => link.predecessorId === predecessor.id)
    .first()
  if (outgoing) throw new Error(`旧测点 ${predecessor.code} 已有生效接替，不能重复登记`)
  const incoming = await db.successions
    .where('status')
    .equals('生效')
    .filter((link) => link.successorId === successor.id)
    .first()
  if (incoming) throw new Error(`新测点 ${successor.code} 已在接替另一个测点`)

  const predecessorRows = (await db.observations.where('pointId').equals(predecessor.id).toArray()).sort((a, b) =>
    a.date.localeCompare(b.date)
  )
  const basis =
    predecessorRows.filter((row) => row.date < draft.effectiveDate).pop() ?? predecessorRows[predecessorRows.length - 1] ?? null
  const successorRows = await db.observations
    .where('pointId')
    .equals(successor.id)
    .filter((row) => row.date >= draft.effectiveDate)
    .toArray()
  const openAlarmCount = await db.alarms
    .where('pointId')
    .equals(predecessor.id)
    .filter((alarm) => alarm.state !== '已闭环')
    .count()

  const canInheritNow = successorRows.length > 0
  return {
    draft,
    predecessor,
    successor,
    retainedObservationCount: predecessorRows.length,
    recalculatedObservationCount: successorRows.length,
    openAlarmCount,
    inheritedCumulative: basis ? basis.cumulative : null,
    basisObservationDate: basis ? basis.date : null,
    inheritMode: canInheritNow ? 'immediate' : 'firstReading'
  }
}

/**
 * 生效接替关系。
 * - 旧点观测与旧预警原样保留（预警不改挂）；
 * - 可立即继承时扣减新点初值、重算新点读数；否则首读时延迟继承；
 * - 写入前留存检查点，事务失败时尝试自动恢复。
 */
export async function applySuccession(draft: SuccessionDraft): Promise<SuccessionRow> {
  const preview = await previewSuccession(draft)
  const now = Date.now()
  const linkId = createId('su')

  // 检查点：创建前的新点初值与全部相关观测（旧点 + 新点）
  const checkpointPoints = [preview.predecessor, preview.successor]
  const checkpointObservations = await db.observations
    .where('pointId')
    .anyOf([draft.predecessorId, draft.successorId])
    .toArray()
  const checkpoint: SuccessionCheckpoint = {
    createdAt: now,
    reason: `接替 ${preview.predecessor.code} → ${preview.successor.code}`,
    action: 'apply',
    linkId,
    predecessorId: draft.predecessorId,
    successorId: draft.successorId,
    succession: null,
    points: checkpointPoints,
    observations: checkpointObservations
  }
  saveSuccessionCheckpoint(checkpoint)

  try {
    return await db.transaction(
      'rw',
      [db.points, db.observations, db.alarms, db.successions],
      async () => {
        const basis = preview.basisObservationDate
          ? (
              await db.observations
                .where('pointId')
                .equals(draft.predecessorId)
                .filter((row) => row.date === preview.basisObservationDate)
                .toArray()
            ).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
          : null

        const successorOnAfter = await db.observations
          .where('pointId')
          .equals(draft.successorId)
          .filter((row) => row.date >= draft.effectiveDate)
          .toArray()

        let inherited = false
        let inheritedCumulative: number | null = null
        let successorInitial = preview.successor.initialValue

        // 旧点有接替日前基准读数时，继承量可立即确定；但只有拿到新点首读数
        // 才能把继承量扣进新点初值，因此首读数缺失时保持 inherited=false，
        // 交由 putObservation 在首读时延迟扣减。
        if (basis) inheritedCumulative = basis.cumulative

        const firstReading = successorOnAfter.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt)[0]
        if (firstReading) {
          inherited = true
          if (inheritedCumulative === null) inheritedCumulative = 0
          successorInitial = round(firstReading.reading - inheritedCumulative, 4)
          await db.points.update(draft.successorId, { initialValue: successorInitial, updatedAt: now })
        }

        const link: SuccessionRow = {
          id: linkId,
          predecessorId: draft.predecessorId,
          successorId: draft.successorId,
          damId: preview.predecessor.damId,
          effectiveDate: draft.effectiveDate,
          inheritedCumulative,
          basisObservationId: basis ? basis.id : null,
          basisObservationDate: basis ? basis.date : null,
          inherited,
          note: draft.note.trim(),
          status: '生效',
          createdAt: now,
          updatedAt: now,
          revision: ROW_REVISION
        }
        await db.successions.put(link)
        if (inherited && successorOnAfter.length > 0) {
          await recalculateSuccessorInTx(draft.successorId, link, successorInitial)
        }
        return link
      }
    )
  } catch (error) {
    // 写失败后从检查点恢复，再把原始错误抛给页面提示
    try {
      await restoreSuccessionCheckpoint(checkpoint)
    } catch {
      /* 恢复失败时保留检查点，交由页面手动恢复 */
    }
    throw error
  }
}

/**
 * 撤下接替关系：相关计算与预警归属恢复。
 * - 新点初值恢复为创建接替前的基线（连续累计量随之恢复为按新点单链计算）；
 * - 受影响观测重算；关系标记「已撤下」留痕，不物理删除；
 * - 预警不迁移：接替期间挂在新点的预警仍归新点，已闭环处置记录照旧。
 * 仅允许撤下链尾关系（该关系的新点没有再生效接替出去）。
 */
export async function revokeSuccession(linkId: string): Promise<SuccessionRow> {
  const link = await db.successions.get(linkId)
  if (!link) throw new Error('接替关系不存在')
  if (link.status !== '生效') throw new Error('该接替关系已撤下')
  const outgoing = await db.successions
    .where('status')
    .equals('生效')
    .filter((item) => item.predecessorId === link.successorId)
    .first()
  if (outgoing) throw new Error('新测点已继续接替到更下游测点，请先撤下末端关系')

  const checkpoint: SuccessionCheckpoint = {
    createdAt: Date.now(),
    reason: `撤下接替 ${link.predecessorId} → ${link.successorId}`,
    action: 'revoke',
    linkId,
    predecessorId: link.predecessorId,
    successorId: link.successorId,
    succession: { ...link },
    points: await db.points.where('id').anyOf([link.predecessorId, link.successorId]).toArray(),
    observations: await db.observations.where('pointId').anyOf([link.predecessorId, link.successorId]).toArray()
  }
  saveSuccessionCheckpoint(checkpoint)

  try {
    return await db.transaction('rw', [db.points, db.observations, db.successions], async () => {
      const now = Date.now()
      await db.successions.update(linkId, { status: '已撤下', updatedAt: now })
      if (link.inherited) {
        // 恢复新点初值：基线 = 当前初值 + 继承累计量（创建前新点按独立点保存的初值）
        const successor = await db.points.get(link.successorId)
        if (successor) {
          const restoredInitial = round(successor.initialValue + (link.inheritedCumulative ?? 0), 4)
          await db.points.update(link.successorId, { initialValue: restoredInitial, updatedAt: now })
          await recalculatePlainInTx(link.successorId, restoredInitial)
        }
      }
      return (await db.successions.get(linkId)) as SuccessionRow
    })
  } catch (error) {
    try {
      await restoreSuccessionCheckpoint(checkpoint)
    } catch {
      /* 保留检查点供手动恢复 */
    }
    throw error
  }
}

/* ============================ 本地 UI 偏好 ============================ */

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastDamId: typeof parsed.lastDamId === 'string' ? parsed.lastDamId : null,
      alarmOnlyOpen: parsed.alarmOnlyOpen === true
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const parsed = Number(localStorage.getItem(LS_KEYS.dbVersion))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}
