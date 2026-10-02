/**
 * 测点接替关系状态（Zustand）
 * 维护接替关系集合与写前检查点；真正的多表写入在 db.ts 事务中完成。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import {
  applySuccession,
  createCheckpoint,
  db,
  deleteCheckpoint,
  restoreCheckpoint,
  revokeSuccession,
  type ApplySuccessionInput,
  type CheckpointRow
} from '@/utils/db'
import type { Succession } from '@/types/succession'
import type { PointRow } from '@/utils/db'
import type { PointType } from '@/types/point'

/** 现场新建新点的入参：在检查点落库后、接替事务前建点，失败可凭检查点整体回滚 */
export interface CreateSuccessorPointInput {
  sectionId: string
  damId: string
  code: string
  type: PointType
  threshold: number
  unit: string
  installDate: string
}

interface SuccessionState {
  successions: Succession[]
  checkpoints: CheckpointRow[]
  ready: boolean
  /** 建立接替（调用方先做校验与影响预览）；成功后写前检查点自动清除，失败时保留并抛出 */
  apply: (input: ApplySuccessionInput) => Promise<Succession>
  /** 需要现场新建新点时：先落检查点，再建新点并执行接替；任一步失败检查点均保留可恢复 */
  applyWithNewPoint: (input: ApplySuccessionInput, newPoint: CreateSuccessorPointInput) => Promise<Succession>
  /** 撤下接替；成功后检查点自动清除，失败时保留并抛出 */
  revoke: (successionId: string, label: string) => Promise<void>
  restore: (checkpointId: string) => Promise<void>
  removeCheckpoint: (checkpointId: string) => Promise<void>
}

export const useSuccessionStore = create<SuccessionState>(() => ({
  successions: [],
  checkpoints: [],
  ready: false,

  async apply(input) {
    const label = `接替生效：${input.predecessorId} → ${input.successorId}（${input.effectiveDate}）`
    const checkpoint = await createCheckpoint('apply-succession', label)
    try {
      const succession = await applySuccession(input)
      await deleteCheckpoint(checkpoint.id).catch(() => undefined)
      return succession
    } catch (error) {
      // 检查点保留：页面提示用户可一键恢复
      throw error
    }
  },

  async applyWithNewPoint(input, newPointInput) {
    const label = `接替生效（现场建新点）：${input.predecessorId} → ${newPointInput.code}（${input.effectiveDate}）`
    const checkpoint = await createCheckpoint('apply-succession', label)
    try {
      const now = Date.now()
      const newPoint: PointRow = {
        id: `pt_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        sectionId: newPointInput.sectionId,
        damId: newPointInput.damId,
        code: newPointInput.code,
        type: newPointInput.type,
        initialValue: 0,
        threshold: newPointInput.threshold,
        unit: newPointInput.unit,
        installDate: newPointInput.installDate,
        createdAt: now,
        updatedAt: now
      }
      await db.points.put(newPoint)
      const succession = await applySuccession({ ...input, successorId: newPoint.id })
      await deleteCheckpoint(checkpoint.id).catch(() => undefined)
      return succession
    } catch (error) {
      throw error
    }
  },

  async revoke(successionId, label) {
    const checkpoint = await createCheckpoint('revoke-succession', `撤下接替：${label}`)
    try {
      await revokeSuccession(successionId)
      await deleteCheckpoint(checkpoint.id).catch(() => undefined)
    } catch (error) {
      throw error
    }
  },

  async restore(checkpointId) {
    await restoreCheckpoint(checkpointId)
  },

  async removeCheckpoint(checkpointId) {
    await deleteCheckpoint(checkpointId)
  }
}))

liveQuery(async () =>
  (await db.successions.toArray()).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
).subscribe({
  next: (rows) => useSuccessionStore.setState({ successions: rows, ready: true }),
  error: () => useSuccessionStore.setState({ ready: true })
})

liveQuery(async () =>
  (await db.checkpoints.toArray()).sort((a, b) => b.createdAt - a.createdAt)
).subscribe({
  next: (rows) => useSuccessionStore.setState({ checkpoints: rows })
})
