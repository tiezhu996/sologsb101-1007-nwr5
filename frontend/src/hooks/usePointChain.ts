/**
 * 测点接续链响应式查询
 * 汇总 points / observations / successions 三张表，沿接续链提供：
 * - 链头分组、链编号；
 * - 连续累计量、跨关系日速率取点；
 * - 按连续口径（新点已扣减继承量的初值）做预警评估。
 * 趋势、处置、录入、测点配置页统一消费本 hook，避免各页各算一套。
 */
import { useMemo } from 'react'
import { usePointStore } from '@/stores/pointStore'
import { useSuccessionStore } from '@/stores/successionStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type ObservationRow } from '@/utils/db'
import type { Point } from '@/types/point'
import {
  buildChainIndex,
  chainCodeOf,
  chainHeadOf,
  effectiveInitialValue,
  predecessorLinkOf,
  successorAfter,
  summarizeChain,
  type ChainIndex,
  type ChainReading,
  type ChainSummary
} from '@/utils/succession'

export interface UsePointChainsResult {
  index: ChainIndex
  /** 全部链头测点 id（含无关系的单点链） */
  headIds: string[]
  headOf: (pointId: string) => string
  codeOf: (headId: string) => string
  summaryOf: (headId: string) => ChainSummary
  /** 链上各测点（旧 → 新） */
  pointsOf: (headId: string) => Point[]
  /** 新点连续口径初值（未继承/链头返回自身初值） */
  initialValueOf: (pointId: string) => number
  /** 该测点作为新测点时的进入关系（链头为 null） */
  incomingLink: (pointId: string) => ReturnType<typeof predecessorLinkOf>
  /** 该测点作为旧点时向外的接替关系（链尾为 null） */
  outgoingLink: (pointId: string) => ReturnType<typeof successorAfter>
  /** 最新一条连续观测（跨链） */
  latestReadingOf: (pointId: string) => ChainReading | null
}

export function usePointChains(): UsePointChainsResult {
  const pointStore = usePointStore()
  const successionStore = useSuccessionStore()
  const observationTable = useIdbTable<ObservationRow>(db.observations, { sortByUpdatedAt: false })

  const points = pointStore.points
  const observations = observationTable.rows
  const successions = successionStore.successions

  return useMemo<UsePointChainsResult>(() => {
    const index = buildChainIndex(successions)
    const headIds = Array.from(new Set(points.map((point) => chainHeadOf(point.id, index)))).sort((a, b) => {
      const pa = points.find((point) => point.id === a)
      const pb = points.find((point) => point.id === b)
      return (pa?.code ?? a).localeCompare(pb?.code ?? b, 'zh-Hans-CN')
    })

    const pointById = new Map(points.map((point) => [point.id, point]))
    const pointsOf = (headId: string): Point[] => {
      const ids: string[] = []
      let current: string | null = headId
      const guard = new Set<string>()
      while (current && !guard.has(current)) {
        guard.add(current)
        ids.push(current)
        const outgoing = index.byPredecessor.get(current)
        current = outgoing ? outgoing.successorId : null
      }
      return ids.map((id) => pointById.get(id)).filter((point): point is Point => Boolean(point))
    }

    const initialValueOf = (pointId: string): number =>
      effectiveInitialValue(pointId, pointById.get(pointId), index)

    const latestReadingOf = (pointId: string): ChainReading | null => {
      const summary = summarizeChain(chainHeadOf(pointId, index), index, observations)
      return summary.latest
    }

    return {
      index,
      headIds,
      headOf: (pointId) => chainHeadOf(pointId, index),
      codeOf: (headId) => chainCodeOf(headId, index, points),
      summaryOf: (headId) => summarizeChain(headId, index, observations),
      pointsOf,
      initialValueOf,
      incomingLink: (pointId) => predecessorLinkOf(pointId, index),
      outgoingLink: (pointId) => successorAfter(pointId, index),
      latestReadingOf
    }
  }, [points, observations, successions])
}
