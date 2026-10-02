/**
 * 测点接替关系：损坏/撤换测点不重录数据，而以独立关系链接新旧测点。
 * - 旧测点（predecessorId）继续保存原始观测，不改动；
 * - 新测点（successorId）按接替日首读数继承旧点累计值（平移初值实现连续累计）；
 * - 趋势与处置沿接续链展示连续结果；旧预警不自动改挂，新预警按接替后测点归属；
 * - 撤下接替关系时新点初值恢复、按点口径重算，已闭环处置记录照旧保留。
 */
import type { Point } from '@/types/point'

/** 测点接替关系 */
export interface Succession {
  id: string
  /** 旧测点（被接替、保留原始观测） */
  predecessorId: string
  /** 新测点（接替生效后继续观测） */
  successorId: string
  /** 接替生效日 YYYY-MM-DD：新点从该日首读数起继承旧点累计值 */
  effectiveDate: string
  /** 新点接替日首读数（与新点单位一致） */
  firstReading: number
  /** 接替生效瞬间旧点最后一条观测的累计值（继承基线，留痕） */
  inheritedCumulative: number
  /** 旧点最后一条观测日期（跨点日速率的衔接点，留痕） */
  predecessorLastDate: string
  /**
   * 新点原有初值快照：建链时平移新点初值（= 首读数 − 继承累计），
   * 撤下接替关系时据此恢复，使相关计算回到单点口径。
   */
  originalInitialValue: number
  /** 建链前新点已有观测数（正常为 0，留痕校验用） */
  successorObservationCount: number
  remark: string
  createdAt: number
  updatedAt: number
}

/** 接替前影响预览：生效确认前列出受影响观测与未闭环预警 */
export interface SuccessionImpact {
  /** 旧点全部原始观测（接替后原样保留） */
  predecessorObservations: Array<{ id: string; date: string; reading: number; cumulative: number }>
  /** 旧点未闭环预警（接替后仍挂旧点，不自动改挂） */
  openAlarms: Array<{ id: string; level: string; state: string; triggerDate: string; triggerValue: number }>
  /** 接替生效瞬间继承的累计值（旧点最后观测累计） */
  inheritedCumulative: number
  /** 旧点最后观测日期 */
  predecessorLastDate: string
  /** 旧点最后观测读数（跨点日速率的衔接读数） */
  predecessorLastReading: number
  /** 建链后平移使用的新初值 = 首读数 − 继承累计值 */
  shiftedInitialValue: number
}

/** 建立接替入参：选择已有新点或现场新建新点 */
export interface SuccessionDraft {
  predecessorId: string
  successorId?: string
  effectiveDate: string
  firstReading: number
  remark: string
  /** successorId 为空时现场新建新点 */
  newPoint?: {
    sectionId: string
    code: string
    type: Point['type']
    threshold: number
    unit: string
    installDate: string
  }
}

/** 接替链上的一段（对应一个物理测点） */
export interface ChainSegment {
  pointId: string
  /** 在链中的序号，从 1 开始 */
  index: number
  /** 段内生效起点：链头为其最早观测日，后续段为接替生效日 */
  fromDate: string
  /** 指向前一段的接替关系（链头为 null） */
  succession: Succession | null
}

/** 观测记录最小结构（便于纯函数解耦 Dexie 行类型） */
export interface ObservationLike {
  id: string
  pointId: string
  date: string
  reading: number
  cumulative: number
  dailyRate: number
  observer?: string
}

/** 测点记录最小结构 */
export type PointLike = Pick<Point, 'id' | 'initialValue' | 'threshold' | 'type' | 'unit' | 'code'>

/** 链上的一条观测（带连续累计与跨点日速率派生值） */
export interface ChainObservation {
  observation: ObservationLike
  pointId: string
  /** 在整条链中的序号，从 1 开始 */
  seq: number
  /** 所属链段序号 */
  segmentIndex: number
  /** 沿接续链连续的累计变化量 */
  chainCumulative: number
  /** 沿接续链连续的日速率（跨点衔接段以旧点末次观测为前值） */
  chainDailyRate: number
  /** 是否为跨点衔接后的第一条观测 */
  isJunction: boolean
  /** 该点原存储口径的累计值（读数 − 本点初值） */
  pointCumulative: number
}

/** 一条测点接续链 */
export interface PointChain {
  /** 链头（最早、被接替的根测点）id */
  headId: string
  /** 链尾（当前在测）测点 id */
  tailId: string
  /** 链上全部测点 id，自旧到新 */
  pointIds: string[]
  segments: ChainSegment[]
  /** 链上全部观测，自旧到新（旧点仅取接替生效日之前的原始观测） */
  observations: ChainObservation[]
}

/** 接替关系校验错误（中文提示可直接上屏） */
export type SuccessionValidationError =
  | 'predecessor-missing'
  | 'successor-missing'
  | 'same-point'
  | 'type-mismatch'
  | 'unit-mismatch'
  | 'already-retired'
  | 'already-in-chain'
  | 'successor-has-observations'
  | 'effective-date-required'
  | 'effective-date-before-last'
  | 'predecessor-no-observation'

export const SUCCESSION_ERROR_TEXT: Record<SuccessionValidationError, string> = {
  'predecessor-missing': '旧测点不存在',
  'successor-missing': '新测点不存在',
  'same-point': '新旧测点不能为同一个',
  'type-mismatch': '新旧测点类型必须一致',
  'unit-mismatch': '新旧测点单位必须一致',
  'already-retired': '该旧测点已被接替，不能再次被接替',
  'already-in-chain': '该新测点已在接续链中，不能重复接替',
  'successor-has-observations': '新测点已有观测记录，请选择未录过数的新点',
  'effective-date-required': '请填写接替生效日',
  'effective-date-before-last': '接替生效日不能早于旧点最后观测日',
  'predecessor-no-observation': '旧测点尚无观测记录，无法继承累计值'
}
