/**
 * 测点接续链：纯函数计算层
 *
 * 接续链把「旧测点 → 接替关系 → 新测点」串成一条逻辑监测序列：
 * - 旧测点观测（点自身的 reading/cumulative）原样保留，不做物理改写；
 * - 新测点初值在生效时扣减「继承累计量」，其原始 cumulative 即连续口径；
 * - 跨关系的第一档日速率，以旧点基准读数 → 新点首读数计算；
 * - 撤下关系后不再使用该关系，计算自然恢复为各点单链。
 *
 * 该模块不依赖 Dexie / React，可被 store、hooks、页面与测试复用。
 */
import type { Alarm } from '@/types/alarm'
import type { Observation } from '@/types/observation'
import type { Point } from '@/types/point'
import type { Succession } from '@/types/succession'
import { daysBetween, round } from '@/utils/threshold'

/** 链上一个测点节点 */
export interface ChainNode {
  pointId: string
  /** 进入该节点的接替关系（链头为 null） */
  link: Succession | null
  /** 该点观测（日期升序） */
  observations: Observation[]
}

/** 接续链上一条连续取点 */
export interface ChainReading {
  pointId: string
  observationId: string
  date: string
  /** 原始读数 */
  reading: number
  /** 沿链连续口径的累计变化量 */
  cumulative: number
  /** 与链上上一条观测之间的日速率（链首首条为 0） */
  dailyRate: number
  observer: string
  /** 节点序号（从 0 开始），用于同日期时稳定排序与着色 */
  nodeIndex: number
  /** 是否跨过一次接替关系计算 */
  acrossLink: boolean
}

/** 只取生效中的接替关系 */
export function activeSuccessions(successions: Succession[]): Succession[] {
  return successions.filter((item) => item.status === '生效')
}

export interface ChainIndex {
  /** 新测点 id → 进入它的生效关系 */
  bySuccessor: Map<string, Succession>
  /** 旧测点 id → 由它出发的生效关系（当前模型一点至多一条出边） */
  byPredecessor: Map<string, Succession>
}

export function buildChainIndex(successions: Succession[]): ChainIndex {
  const bySuccessor = new Map<string, Succession>()
  const byPredecessor = new Map<string, Succession>()
  activeSuccessions(successions).forEach((link) => {
    bySuccessor.set(link.successorId, link)
    byPredecessor.set(link.predecessorId, link)
  })
  return { bySuccessor, byPredecessor }
}

/** 返回某测点所属链的链头测点 id（无关系时即自身） */
export function chainHeadOf(pointId: string, index: ChainIndex): string {
  const guard = new Set<string>()
  let current = pointId
  while (!guard.has(current)) {
    guard.add(current)
    const incoming = index.bySuccessor.get(current)
    if (!incoming) return current
    current = incoming.predecessorId
  }
  return current
}

/** 从链头开始按接替顺序返回节点（旧 → 新） */
export function buildChain(headId: string, index: ChainIndex, observations: Observation[]): ChainNode[] {
  const nodes: ChainNode[] = []
  const guard = new Set<string>()
  let pointId: string | null = headId
  let incomingLink: Succession | null = null
  while (pointId && !guard.has(pointId)) {
    guard.add(pointId)
    const own = observations
      .filter((row) => row.pointId === pointId)
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt)
    nodes.push({ pointId, link: incomingLink, observations: own })
    const outgoing = index.byPredecessor.get(pointId)
    if (!outgoing) break
    incomingLink = outgoing
    pointId = outgoing.successorId
  }
  return nodes
}

/** 按链头分组全部测点（无关系测点自成单链） */
export function groupPointsByChain(points: Point[], index: ChainIndex): Map<string, Point[]> {
  const groups = new Map<string, Point[]>()
  points.forEach((point) => {
    const head = chainHeadOf(point.id, index)
    const list = groups.get(head) ?? []
    list.push(point)
    groups.set(head, list)
  })
  groups.forEach((list) => {
    // 链头在前，其余按接替顺序无法直接知道序号时，用关系表排序代价较大；
    // 页面展示统一使用 buildChain，分组仅用于统计，这里按编号稳定排序。
    list.sort((a, b) => {
      if (a.id === chainHeadOf(a.id, index)) return -1
      if (b.id === chainHeadOf(b.id, index)) return 1
      return a.code.localeCompare(b.code, 'zh-Hans-CN')
    })
  })
  return groups
}

/**
 * 把一条链的观测整理为连续取点。
 *
 * 规则：
 * - 链头节点累计量取观测自带 cumulative（原始观测保留值）；
 * - 后续节点取生效日起的观测，累计量同样取观测自带 cumulative
 *   （新点初值已在生效/首读时扣减继承量，故原始 cumulative 连续）；
 * - 跨接替关系的第一档日速率按「连续累计量之差」计算（新旧测点读数零位不同，
 *   原始读数差无物理意义），基准为旧点「日期 < 接替日」的最后一条
 *   （无则取旧点最后一条），日期或读数对不上时回退为 0。
 */
export function buildChainReadings(nodes: ChainNode[]): ChainReading[] {
  const result: ChainReading[] = []
  let carry: { date: string; reading: number; cumulative: number } | null = null

  nodes.forEach((node, nodeIndex) => {
    const incoming = node.link
    let rows = node.observations
    if (incoming) {
      // 生效日之前的新点读数（安装调试等）不进入接续序列
      rows = rows.filter((row) => row.date >= incoming.effectiveDate)
    }

    let boundary: { date: string; reading: number; cumulative: number } | null = null
    if (incoming) {
      const previousNode = nodes[nodeIndex - 1]
      if (previousNode) {
        const before = previousNode.observations.filter((row) => row.date < incoming.effectiveDate)
        const basis = before[before.length - 1] ?? previousNode.observations[previousNode.observations.length - 1]
        if (basis) boundary = { date: basis.date, reading: basis.reading, cumulative: basis.cumulative }
      }
    }

    rows.forEach((row, rowIndex) => {
      let dailyRate: number
      let acrossLink = false
      if (rowIndex === 0 && boundary) {
        dailyRate = continuousDailyRate(row.cumulative, boundary.cumulative, daysBetween(boundary.date, row.date))
        acrossLink = true
      } else if (rowIndex === 0 && carry) {
        // 旧点没有可推导基准时，回退用上一条链观测的连续累计量
        dailyRate = continuousDailyRate(row.cumulative, carry.cumulative, daysBetween(carry.date, row.date))
        acrossLink = true
      } else {
        dailyRate = row.dailyRate
      }
      result.push({
        pointId: node.pointId,
        observationId: row.id,
        date: row.date,
        reading: row.reading,
        cumulative: row.cumulative,
        dailyRate,
        observer: row.observer,
        nodeIndex,
        acrossLink
      })
    })

    const last = rows[rows.length - 1]
    if (last) carry = { date: last.date, reading: last.reading, cumulative: last.cumulative }
    else if (boundary) carry = boundary
  })

  return result.sort((a, b) => a.date.localeCompare(b.date) || a.nodeIndex - b.nodeIndex)
}

/** 跨接替关系日速率：连续累计量差 ÷ 间隔天数 */
function continuousDailyRate(currentCumulative: number, basisCumulative: number, days: number): number {
  const span = days > 0 ? days : 1
  return round(Math.abs(currentCumulative - basisCumulative) / span, 4)
}

/**
 * 新点初值扣减继承量后的「评估初值」：
 * 预警判定 / 越限阈值按连续口径计算。
 * 未完成继承的新点、链头、无关节点返回自身初值。
 */
export function effectiveInitialValue(
  pointId: string,
  point: Point | undefined,
  index: ChainIndex
): number {
  if (!point) return 0
  const incoming = index.bySuccessor.get(pointId)
  if (!incoming || !incoming.inherited || incoming.inheritedCumulative === null) return point.initialValue
  return round(point.initialValue - incoming.inheritedCumulative, 4)
}

export interface ChainSummary {
  headId: string
  nodeCount: number
  readings: ChainReading[]
  /** 最新一条连续观测 */
  latest: ChainReading | null
}

/** 汇总一条链的连续结果 */
export function summarizeChain(headId: string, index: ChainIndex, observations: Observation[]): ChainSummary {
  const nodes = buildChain(headId, index, observations)
  const readings = buildChainReadings(nodes)
  return {
    headId,
    nodeCount: nodes.filter((node) => node.observations.length > 0).length,
    readings,
    latest: readings[readings.length - 1] ?? null
  }
}

/** 链编号：各测点编号用 → 连接（旧 → 新） */
export function chainCodeOf(headId: string, index: ChainIndex, points: Point[]): string {
  const codes: string[] = []
  const guard = new Set<string>()
  let current: string | null = headId
  while (current && !guard.has(current)) {
    guard.add(current)
    const point = points.find((item) => item.id === current)
    codes.push(point ? point.code : current)
    const outgoing = index.byPredecessor.get(current)
    current = outgoing ? outgoing.successorId : null
  }
  return codes.join(' → ')
}

/** 链上某测点之后的节点（不含自身），用于判断是否链尾 */
export function successorAfter(pointId: string, index: ChainIndex): Succession | null {
  return index.byPredecessor.get(pointId) ?? null
}

/** 链上某测点之前的生效关系（该点作为新测点时非空） */
export function predecessorLinkOf(pointId: string, index: ChainIndex): Succession | null {
  return index.bySuccessor.get(pointId) ?? null
}

/**
 * 把按归属测点过滤的预警映射到一条链：
 * 预警归属不随接替改挂，这里只用于「沿接续链展示」时归集。
 */
export function alarmsOfChain(headId: string, index: ChainIndex, alarms: Alarm[]): Alarm[] {
  const nodeIds = new Set<string>()
  buildChain(headId, index, []).forEach((node) => nodeIds.add(node.pointId))
  return alarms.filter((alarm) => nodeIds.has(alarm.pointId))
}
