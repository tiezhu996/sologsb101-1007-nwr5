/**
 * 测点接续链纯计算：不接触 Dexie / React，便于单测与多页面复用。
 *
 * 连续口径（链口径）：
 * - 链头段：chainCumulative = 读数 − 链头初值（即原始累计）；
 * - 接替段：平移新点初值为（首读数 − 继承累计），因此
 *   chainCumulative = 读数 − 新点初值（点内存储累计）+ 继承累计 = 读数 −（首读数 − 继承累计）+ 继承累计?
 *   实际实现统一用「段偏移量」：chainCumulative = pointCumulative + segmentOffset，
 *   段偏移保证新点接替日首读数的连续累计恰好等于继承基线；
 * - 链日速率：以链上前一条观测（可能在旧点）的读数差 ÷ 间隔天数。
 */
import type { AlarmLevel } from '@/types/alarm'
import { alarmLevelOf, dailyRateOf, daysBetween, ratioOf, round } from '@/utils/threshold'
import type {
  ChainObservation,
  ObservationLike,
  PointChain,
  PointLike,
  Succession,
  SuccessionImpact,
  SuccessionValidationError
} from '@/types/succession'

/** 旧点被接替后（有出边）即视为撤下停测 */
export function isRetiredPoint(pointId: string, successions: Succession[]): boolean {
  return successions.some((item) => item.predecessorId === pointId)
}

/** 当前在测点（链尾）集合：没有入边的测点……反之，链尾 = 不以 predecessor 身份出现且在链上 */
export function activePointIds(successions: Succession[]): Set<string> {
  const retired = new Set(successions.map((item) => item.predecessorId))
  const involved = new Set<string>()
  successions.forEach((item) => {
    involved.add(item.predecessorId)
    involved.add(item.successorId)
  })
  const active = new Set<string>()
  involved.forEach((id) => {
    if (!retired.has(id)) active.add(id)
  })
  return active
}

/** 找到以某点为链头的接续关系出边 */
export function outgoingSuccession(pointId: string, successions: Succession[]): Succession | null {
  return successions.find((item) => item.predecessorId === pointId) ?? null
}

/** 找到某点作为新点的入边（它从谁接替而来） */
export function incomingSuccession(pointId: string, successions: Succession[]): Succession | null {
  return successions.find((item) => item.successorId === pointId) ?? null
}

/** 含某点的整条链（自链头至链尾）；该点不在任何接替关系中时返回单点链 */
export function buildPointChain(
  pointId: string,
  points: PointLike[],
  observations: ObservationLike[],
  successions: Succession[]
): PointChain {
  // 向前追到链头
  let headId = pointId
  const guard = new Set<string>([headId])
  for (;;) {
    const incoming = incomingSuccession(headId, successions)
    if (!incoming) break
    if (guard.has(incoming.predecessorId)) break // 防御：数据异常成环时不卡死
    headId = incoming.predecessorId
    guard.add(headId)
  }

  const pointMap = new Map(points.map((point) => [point.id, point]))
  const segmentPointIds: string[] = []
  let cursor: string | null = headId
  const cursorGuard = new Set<string>()
  while (cursor && !cursorGuard.has(cursor)) {
    cursorGuard.add(cursor)
    segmentPointIds.push(cursor)
    const outgoing = outgoingSuccession(cursor, successions)
    cursor = outgoing ? outgoing.successorId : null
  }

  const chain: PointChain = {
    headId,
    tailId: segmentPointIds[segmentPointIds.length - 1] ?? headId,
    pointIds: segmentPointIds,
    segments: [],
    observations: []
  }

  const observationsByPoint = new Map<string, ObservationLike[]>()
  observations.forEach((row) => {
    const list = observationsByPoint.get(row.pointId)
    if (list) list.push(row)
    else observationsByPoint.set(row.pointId, [row])
  })

  let seq = 1
  let previous: { date: string; reading: number } | null = null
  let segmentSeen = 0
  // 前一段末次观测的链累计：用于衔接段首条的偏移校验（偏移仍以接替关系存的基线为准）
  segmentPointIds.forEach((segmentPointId, segmentIndex) => {
    const incoming = segmentIndex === 0 ? null : incomingSuccession(segmentPointId, successions)
    // 当前段通向下一段的出边：旧点观测只保留到接替生效日之前（上界，不含）
    const outgoingEdge = outgoingSuccession(segmentPointId, successions)
    const point = pointMap.get(segmentPointId)
    const own = (observationsByPoint.get(segmentPointId) ?? []).slice().sort((a, b) => a.date.localeCompare(b.date))

    // 段窗口：有入边则从接替生效日起（含）；有出边则止于下一接替生效日之前（不含）
    const scoped = own.filter((row) => {
      if (incoming && row.date < incoming.effectiveDate) return false
      if (outgoingEdge && row.date >= outgoingEdge.effectiveDate) return false
      return true
    })
    const fromDate = segmentIndex === 0 ? (scoped[0]?.date ?? '') : (incoming?.effectiveDate ?? '')
    chain.segments.push({ pointId: segmentPointId, index: segmentIndex + 1, fromDate, succession: incoming })

    // 段偏移量：让点内累计平移到链累计
    let segmentOffset = 0
    if (incoming && point) {
      const first = scoped[0]
      if (first) {
        // 首读数连续累计 = 继承基线：offset = inherited − pointCumulative(first)
        segmentOffset = round(incoming.inheritedCumulative - (first.reading - point.initialValue), 4)
      } else {
        // 新点尚未录入：以接替关系登记的首读数为虚拟锚点
        segmentOffset = round(incoming.inheritedCumulative - (incoming.firstReading - point.initialValue), 4)
      }
    }

    scoped.forEach((row) => {
      const pointCumulative = point ? round(row.reading - point.initialValue, 3) : row.cumulative
      const chainCumulative = round(pointCumulative + segmentOffset, 3)
      // 接替段的第一条观测即跨点衔接点
      const isJunction = segmentIndex > 0 && chain.observations.length === segmentSeen
      const chainDailyRate = previous
        ? dailyRateOf(row.reading, previous.reading, daysBetween(previous.date, row.date))
        : 0
      chain.observations.push({
        observation: row,
        pointId: row.pointId,
        seq: seq++,
        segmentIndex: segmentIndex + 1,
        chainCumulative,
        chainDailyRate,
        isJunction,
        pointCumulative
      })
      previous = { date: row.date, reading: row.reading }
    })
    segmentSeen = chain.observations.length
  })

  return chain
}

export interface BuildChainsResult {
  /** 以链头 id 为键的全部链（含单点链） */
  chainsByHead: Map<string, PointChain>
  /** 任意点 id → 所属链头 id */
  headOf: Map<string, string>
  chains: PointChain[]
}

/** 全量测点构建链集合：每个物理测点恰好属于一条链 */
export function buildPointChains(
  points: PointLike[],
  observations: ObservationLike[],
  successions: Succession[]
): BuildChainsResult {
  const chainsByHead = new Map<string, PointChain>()
  const headOf = new Map<string, string>()
  points.forEach((point) => {
    if (headOf.has(point.id)) return
    const chain = buildPointChain(point.id, points, observations, successions)
    chainsByHead.set(chain.headId, chain)
    chain.pointIds.forEach((id) => headOf.set(id, chain.headId))
  })
  return { chainsByHead, headOf, chains: [...chainsByHead.values()] }
}

/** 链尾当前读数（用于趋势/预警判定）；无观测返回 null */
export function chainLatest(chain: PointChain): ChainObservation | null {
  return chain.observations[chain.observations.length - 1] ?? null
}

/**
 * 沿接续链判定级别：阈值取当前在测（链尾）测点，累计值取链口径连续累计。
 * 返回的 virtualPoint 可直接喂给既有 useAlarmLevel / alarmBasis 等按 Point 计算的逻辑。
 */
export function evaluateChain(
  chain: PointChain,
  points: PointLike[]
): { cumulative: number; ratio: number; level: AlarmLevel | null; virtualPoint: PointLike } {
  const tail = points.find((point) => point.id === chain.tailId) ?? points.find((point) => point.id === chain.headId)
  const latest = chainLatest(chain)
  const fallback: PointLike = tail ?? { id: chain.headId, code: chain.headId, initialValue: 0, threshold: 1, type: '表面位移', unit: '' }
  const cumulative = latest ? latest.chainCumulative : 0
  return {
    cumulative,
    ratio: ratioOf(cumulative, fallback.threshold),
    level: alarmLevelOf(cumulative, fallback.threshold),
    virtualPoint: { ...fallback, initialValue: round((latest ? latest.observation.reading : 0) - cumulative, 3) }
  }
}

/* ============================ 建立前校验与影响预览 ============================ */

/** 校验候选接替关系（不写库），返回错误码或 null */
export function validateSuccession(input: {
  predecessor: PointLike | undefined
  successor: PointLike | undefined
  effectiveDate: string
  successions: Succession[]
  successorObservationCount: number
}): SuccessionValidationError | null {
  const { predecessor, successor, effectiveDate, successions, successorObservationCount } = input
  if (!predecessor) return 'predecessor-missing'
  if (!successor) return 'successor-missing'
  if (predecessor.id === successor.id) return 'same-point'
  if (predecessor.type !== successor.type) return 'type-mismatch'
  if (predecessor.unit !== successor.unit) return 'unit-mismatch'
  if (isRetiredPoint(predecessor.id, successions)) return 'already-retired'
  // 新点不能已在任何链中（无论链头还是链尾）
  if (
    successions.some((item) => item.predecessorId === successor.id || item.successorId === successor.id)
  ) {
    return 'already-in-chain'
  }
  if (successorObservationCount > 0) return 'successor-has-observations'
  if (!effectiveDate) return 'effective-date-required'
  return null
}

export interface ImpactInput {
  predecessor: PointLike
  successor: PointLike
  effectiveDate: string
  firstReading: number
  observations: ObservationLike[]
  openAlarms: SuccessionImpact['openAlarms']
}

/** 计算接替影响清单与继承基线（旧点最后观测必须早于生效日） */
export function buildSuccessionImpact(input: ImpactInput): SuccessionImpact | SuccessionValidationError {
  const own = input.observations
    .filter((row) => row.pointId === input.predecessor.id)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (own.length === 0) return 'predecessor-no-observation'
  const last = own[own.length - 1]
  if (input.effectiveDate && last.date >= input.effectiveDate) return 'effective-date-before-last'

  return {
    predecessorObservations: own.map((row) => ({
      id: row.id,
      date: row.date,
      reading: row.reading,
      cumulative: row.cumulative
    })),
    openAlarms: input.openAlarms,
    inheritedCumulative: last.cumulative,
    predecessorLastDate: last.date,
    predecessorLastReading: last.reading,
    shiftedInitialValue: round(input.firstReading - last.cumulative, 3)
  }
}
