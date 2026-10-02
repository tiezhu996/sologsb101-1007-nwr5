/**
 * 接续链派生：合并测点、观测、接替关系三个 live 数据源，
 * 向页面提供「链头去重视角」与「任意点 → 链」查询，保证趋势与处置沿链连续展示。
 */
import { useMemo } from 'react'
import { usePointStore } from '@/stores/pointStore'
import { useSuccessionStore } from '@/stores/successionStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type ObservationRow } from '@/utils/db'
import {
  activePointIds,
  buildPointChains,
  chainLatest,
  evaluateChain,
  incomingSuccession,
  isRetiredPoint,
  outgoingSuccession
} from '@/utils/succession'
import type { ChainObservation, ObservationLike, PointChain, PointLike, Succession } from '@/types/succession'

export interface UsePointChainsResult {
  chains: PointChain[]
  chainsByHead: Map<string, PointChain>
  headOf: Map<string, string>
  successions: Succession[]
  /** 全部在测（链尾）测点 id */
  activeIds: Set<string>
  /** 已撤下停测（旧点）测点 id */
  retiredIds: Set<string>
  chainOf: (pointId: string) => PointChain | null
  isRetired: (pointId: string) => boolean
  isSuccessor: (pointId: string) => boolean
  outgoing: (pointId: string) => Succession | null
  incoming: (pointId: string) => Succession | null
  latestOf: (pointId: string) => ChainObservation | null
  /** 沿链连续判定（级别按链尾阈值、链口径累计） */
  evaluationOf: (pointId: string) => ReturnType<typeof evaluateChain> | null
}

export function usePointChains(): UsePointChainsResult {
  const points = usePointStore((state) => state.points)
  const successions = useSuccessionStore((state) => state.successions)
  const observationTable = useIdbTable<ObservationRow>(db.observations, { sortByUpdatedAt: false })

  return useMemo<UsePointChainsResult>(() => {
    const pointLikes: PointLike[] = points.map((point) => ({
      id: point.id,
      code: point.code,
      initialValue: point.initialValue,
      threshold: point.threshold,
      type: point.type,
      unit: point.unit
    }))
    const observationLikes: ObservationLike[] = observationTable.rows.map((row) => ({
      id: row.id,
      pointId: row.pointId,
      date: row.date,
      reading: row.reading,
      cumulative: row.cumulative,
      dailyRate: row.dailyRate,
      observer: row.observer
    }))
    const { chains, chainsByHead, headOf } = buildPointChains(pointLikes, observationLikes, successions)
    const activeIds = activePointIds(successions)
    const retiredIds = new Set(successions.map((item) => item.predecessorId))

    const chainOf = (pointId: string): PointChain | null => {
      const headId = headOf.get(pointId)
      return headId ? chainsByHead.get(headId) ?? null : null
    }

    return {
      chains,
      chainsByHead,
      headOf,
      successions,
      activeIds,
      retiredIds,
      chainOf,
      isRetired: (pointId) => isRetiredPoint(pointId, successions),
      isSuccessor: (pointId) => incomingSuccession(pointId, successions) !== null,
      outgoing: (pointId) => outgoingSuccession(pointId, successions),
      incoming: (pointId) => incomingSuccession(pointId, successions),
      latestOf: (pointId) => {
        const chain = chainOf(pointId)
        return chain ? chainLatest(chain) : null
      },
      evaluationOf: (pointId) => {
        const chain = chainOf(pointId)
        return chain ? evaluateChain(chain, pointLikes) : null
      }
    }
  }, [points, observationTable.rows, successions])
}
