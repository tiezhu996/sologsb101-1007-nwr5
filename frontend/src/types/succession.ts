/**
 * 测点接替关系（独立关系表）
 *
 * 测点损坏后不再用「新编号重录」把累计位移、日速率截成两段，
 * 而是登记一条接替关系：
 * - 旧测点（predecessor）继续保存全部原始观测与历史预警，归属不变；
 * - 新测点（successor）自接替日（effectiveDate）起接续观测，
 *   首读数继承旧点最新累计变化量（扣减进新点初值，原始累计量天然连续）；
 * - 预警不随接替改挂：旧预警留在旧点，接替后触发的新预警归属新点。
 */
export type SuccessionStatus = '生效' | '已撤下'

export interface Succession {
  id: string
  /** 被接替的旧测点 id */
  predecessorId: string
  /** 接替的新测点 id（当前链尾） */
  successorId: string
  /** 冗余坝体 id，便于按坝体筛选 */
  damId: string
  /** 接替生效日 YYYY-MM-DD：新测点读数自该日起进入接续链 */
  effectiveDate: string
  /**
   * 继承的旧点累计变化量（连续口径）。
   * - 生效时旧点已有可推导读数，或新点已有 >= 接替日读数时固化；
   * - 旧点无任何观测、新点也尚无读数时为 null，待新点首读数时再确定。
   */
  inheritedCumulative: number | null
  /** 继承基准观测（旧点最近一次日期 < 接替日的读数，回退为最近一条） */
  basisObservationId: string | null
  basisObservationDate: string | null
  /** 是否已完成继承：新点初值已扣减 inheritedCumulative，且历史读数已重算 */
  inherited: boolean
  /** 登记说明（损坏原因、设桩位置等） */
  note: string
  status: SuccessionStatus
  createdAt: number
  updatedAt: number
}

export interface SuccessionDraft {
  predecessorId: string
  successorId: string
  effectiveDate: string
  note: string
}

export const EMPTY_SUCCESSION_DRAFT: SuccessionDraft = {
  predecessorId: '',
  successorId: '',
  effectiveDate: '',
  note: ''
}

export const SUCCESSION_STATUSES: SuccessionStatus[] = ['生效', '已撤下']

/** 接替生效前的影响预览（提交确认弹窗使用） */
export interface SuccessionImpact {
  /** 旧点将原样保留的观测条数 */
  retainedObservationCount: number
  /** 新点已有的、日期 >= 接替日、生效后立即重算的观测条数 */
  recalculatedObservationCount: number
  /** 旧点未闭环预警：继续挂在旧点，不会自动改挂 */
  openAlarmCount: number
  /** 预计继承的旧点累计变化量（旧点无观测时为 null，首读时再继承） */
  inheritedCumulative: number | null
  /** 继承基准观测日期 */
  basisObservationDate: string | null
  /** immediate = 生效即继承；firstReading = 新点首读数时才继承 */
  inheritMode: 'immediate' | 'firstReading'
}
