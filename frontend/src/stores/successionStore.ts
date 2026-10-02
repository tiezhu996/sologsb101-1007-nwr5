/**
 * 测点接替关系状态（Zustand）
 * 维护接替关系集合、生效/已撤下筛选，以及接替生效、撤下、检查点恢复等动作。
 * 关系是独立数据：旧点观测与旧预警不迁移，链连续性由 utils/succession 计算。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import {
  applySuccession,
  clearSuccessionCheckpoint,
  db,
  readSuccessionCheckpoint,
  restoreSuccessionCheckpoint,
  revokeSuccession,
  type SuccessionCheckpoint,
  type SuccessionRow
} from '@/utils/db'
import {
  SUCCESSION_STATUSES,
  type Succession,
  type SuccessionDraft,
  type SuccessionStatus
} from '@/types/succession'

interface SuccessionState {
  successions: Succession[]
  statusFilter: SuccessionStatus[]
  ready: boolean
  patchStatusFilter: (statuses: SuccessionStatus[]) => void
  resetFilter: () => void
  apply: (draft: SuccessionDraft) => Promise<SuccessionRow>
  revoke: (linkId: string) => Promise<SuccessionRow>
  restoreCheckpoint: (checkpoint: SuccessionCheckpoint) => Promise<void>
  activeCount: () => number
}

export const useSuccessionStore = create<SuccessionState>((set, get) => ({
  successions: [],
  statusFilter: ['生效'],
  ready: false,

  patchStatusFilter(statuses) {
    set({ statusFilter: statuses.length > 0 ? statuses : [...SUCCESSION_STATUSES] })
  },

  resetFilter() {
    set({ statusFilter: ['生效'] })
  },

  async apply(draft) {
    return applySuccession(draft)
  },

  async revoke(linkId) {
    return revokeSuccession(linkId)
  },

  async restoreCheckpoint(checkpoint) {
    await restoreSuccessionCheckpoint(checkpoint)
  },

  activeCount() {
    return get().successions.filter((link) => link.status === '生效').length
  }
}))

export { readSuccessionCheckpoint, clearSuccessionCheckpoint }

liveQuery(async () =>
  (await db.successions.toArray()).sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))
).subscribe({
  next: (rows) => useSuccessionStore.setState({ successions: rows, ready: true }),
  error: () => useSuccessionStore.setState({ ready: true })
})
