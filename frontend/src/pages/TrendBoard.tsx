/**
 * /trends 累计位移与沉降速率计算
 * 按测点接续链降序展示连续累计变化量与日速率，抽屉内查看链上历次观测并可直接生成预警单。
 * 每条物理链只占一行（链头去重），阈值取链尾当前在测测点，累计/速率沿链连续。
 * 消费 Observation、Point、Succession；复用 <StatBadge>、<AlarmTag>、<EmptyPanel>。
 */
import { useMemo, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Descriptions,
  Drawer,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag
} from 'antd'
import type { TableColumnsType } from 'antd'
import AlarmTag from '@/components/common/AlarmTag'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useDamStore } from '@/stores/damStore'
import { usePointStore } from '@/stores/pointStore'
import { useAlarmStore } from '@/stores/alarmStore'
import { useAlarmLevel } from '@/hooks/useAlarmLevel'
import { usePointChains } from '@/hooks/usePointChains'
import type { Point, PointType } from '@/types/point'
import { POINT_TYPES } from '@/types/point'
import type { AlarmLevel } from '@/types/alarm'
import type { ChainObservation, PointChain } from '@/types/succession'
import { formatRate, formatReading, ratioOf } from '@/utils/threshold'

interface TrendRow {
  chain: PointChain
  /** 链尾当前在测测点（阈值以此为准） */
  tailPoint: Point
  headPoint: Point
  damName: string
  stakeNo: string
  latest: ChainObservation | null
  count: number
  cumulative: number
  dailyRate: number
  ratio: number
  level: AlarmLevel | null
}

export default function TrendBoard() {
  const { message } = AntdApp.useApp()
  const damStore = useDamStore()
  const pointStore = usePointStore()
  const alarmStore = useAlarmStore()
  const alarmLevel = useAlarmLevel()
  const chains = usePointChains()

  const [drawerHeadId, setDrawerHeadId] = useState<string | null>(null)
  const [onlyExceeded, setOnlyExceeded] = useState(false)
  const [thresholdOpen, setThresholdOpen] = useState(false)
  const [editingPoint, setEditingPoint] = useState<Point | null>(null)
  const [thresholdForm] = Form.useForm<{ initialValue: number; threshold: number }>()

  const filter = pointStore.filter
  const filterSelects = useMemo(
    () => [
      {
        key: 'damId',
        label: '坝体',
        multiple: false,
        options: damStore.dams.map((dam) => ({ label: dam.name, value: dam.id }))
      },
      { key: 'types', label: '测点类型', options: POINT_TYPES.map((item) => ({ label: item, value: item })) }
    ],
    [damStore.dams]
  )

  const model: FilterModel = { keyword: filter.keyword, damId: filter.damId, types: filter.types }

  const onModelChange = (next: FilterModel): void => {
    pointStore.patchFilter({
      keyword: String(next.keyword ?? ''),
      damId: typeof next.damId === 'string' ? next.damId : '',
      types: (Array.isArray(next.types) ? next.types : []) as PointType[]
    })
  }

  const pointById = (id: string): Point | undefined => pointStore.points.find((item) => item.id === id)

  const trendRows = useMemo<TrendRow[]>(() => {
    const rows: TrendRow[] = []
    chains.chains.forEach((chain) => {
      const memberPoints = chain.pointIds
        .map((id) => pointById(id))
        .filter((point): point is Point => Boolean(point))
      if (memberPoints.length === 0) return
      const tailPoint = memberPoints[memberPoints.length - 1]
      const headPoint = memberPoints[0]
      // 链上任一测点命中筛选即保留该链
      if (filter.damId && !memberPoints.some((point) => point.damId === filter.damId)) return
      if (filter.types.length > 0 && !memberPoints.some((point) => filter.types.includes(point.type))) return
      const text = filter.keyword.trim().toLowerCase()
      if (text.length > 0 && !memberPoints.some((point) => point.code.toLowerCase().includes(text))) return

      const section = damStore.sections.find((item) => item.id === tailPoint.sectionId)
      const dam = damStore.dams.find((item) => item.id === tailPoint.damId)
      const latest = chain.observations[chain.observations.length - 1] ?? null
      const cumulative = latest ? latest.chainCumulative : 0
      const evaluation = chains.evaluationOf(chain.headId)
      rows.push({
        chain,
        tailPoint,
        headPoint,
        damName: dam ? dam.name : '—',
        stakeNo: section ? section.stakeNo : '—',
        latest,
        count: chain.observations.length,
        cumulative,
        dailyRate: latest ? latest.chainDailyRate : 0,
        ratio: ratioOf(cumulative, tailPoint.threshold),
        level: evaluation?.level ?? null
      })
    })
    const filtered = onlyExceeded ? rows.filter((row) => row.ratio >= 0.7) : rows
    return filtered.sort((a, b) => b.ratio - a.ratio)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chains, pointStore.points, damStore.sections, damStore.dams, filter, onlyExceeded])

  const exceededCount = trendRows.filter((row) => row.ratio >= 0.7).length
  const averageRate = useMemo(() => {
    const rated = trendRows.filter((row) => row.latest !== null)
    if (rated.length === 0) return 0
    return rated.reduce((sum, row) => sum + row.dailyRate, 0) / rated.length
  }, [trendRows])

  const drawerChain = drawerHeadId ? chains.chainsByHead.get(drawerHeadId) ?? null : null
  const drawerObservations = useMemo<ChainObservation[]>(
    () => (drawerChain ? [...drawerChain.observations].reverse() : []),
    [drawerChain]
  )
  const drawerLatest = drawerChain ? drawerChain.observations[drawerChain.observations.length - 1] ?? null : null
  const drawerTailPoint = drawerChain ? pointById(drawerChain.tailId) : undefined
  const drawerLevel = drawerChain ? chains.evaluationOf(drawerChain.headId)?.level ?? null : null

  /** 按链尾在测测点的最新观测生成预警（新预警归属接替后测点） */
  const generateAlarm = async (row: TrendRow): Promise<void> => {
    const latest = row.chain.observations[row.chain.observations.length - 1]
    if (!latest) return
    if (alarmStore.alarms.some((alarm) => alarm.pointId === row.tailPoint.id && alarm.triggerDate === latest.observation.date)) {
      message.info('该测点当日已生成预警单')
      return
    }
    const result = alarmLevel.buildDraft(row.tailPoint, latest.observation.date, latest.observation.reading)
    if (!result) {
      message.info('该观测未越限，无需生成预警单')
      return
    }
    await alarmStore.createAlarm({ ...result.draft, measure: result.basis })
    message.success(`已生成${result.draft.level}色预警单（归属 ${row.tailPoint.code}）`)
  }

  const openThreshold = (point: Point): void => {
    // 接替新点的初值是继承基线的平移结果，改初值会断链，只允许改阈值
    setEditingPoint(point)
    thresholdForm.setFieldsValue({ initialValue: point.initialValue, threshold: point.threshold })
    setThresholdOpen(true)
  }

  const submitThreshold = async (): Promise<void> => {
    if (!editingPoint) return
    const values = await thresholdForm.validateFields().catch(() => null)
    if (!values) return
    if (chains.isSuccessor(editingPoint.id)) {
      // 新点：仅提交阈值，不动平移初值，保证链累计连续
      await pointStore.updatePoint(editingPoint.id, { threshold: values.threshold })
      message.success(`${editingPoint.code} 阈值已更新；初值为接替继承基线，不允许修改`)
    } else {
      await pointStore.updatePoint(editingPoint.id, {
        initialValue: values.initialValue,
        threshold: values.threshold
      })
      message.success(`${editingPoint.code} 初值与阈值已更新`)
    }
    setThresholdOpen(false)
  }

  const removeTailPoint = async (row: TrendRow): Promise<void> => {
    await pointStore.removePoint(row.tailPoint.id)
    setDrawerHeadId(null)
    message.success('测点及其观测记录、接替关系已删除')
  }

  const columns: TableColumnsType<TrendRow> = [
    {
      title: '排名',
      width: 70,
      render: (_value, _record, index) => index + 1
    },
    {
      title: '接续链测点',
      width: 180,
      render: (_value, record) => (
                <Space direction="vertical" size={0}>
          <strong>{record.tailPoint.code}</strong>
          {record.chain.pointIds.length > 1 ? (
            <span className="muted">
              链：{record.chain.pointIds.map((id) => pointById(id)?.code ?? id).join(' → ')}
            </span>
          ) : null}
        </Space>
      )
    },
    {
      title: '坝体 / 桩号',
      width: 180,
      render: (_value, record) => `${record.damName} / ${record.stakeNo}`
    },
    { title: '类型', width: 100, render: (_value, record) => <Tag color="blue">{record.tailPoint.type}</Tag> },
    { title: '链上观测', width: 90, render: (_value, record) => record.count },
    {
      title: '最新读数',
      width: 140,
      render: (_value, record) =>
        record.latest ? formatReading(record.latest.observation.reading, record.tailPoint.unit) : <span className="muted">暂无观测</span>
    },
    {
      title: '连续累计变化',
      width: 150,
      render: (_value, record) => (
        <span style={{ color: record.ratio >= 0.7 ? '#b03a2e' : undefined }}>
          {record.cumulative.toFixed(3)} {record.tailPoint.unit}
        </span>
      )
    },
    {
      title: '链日速率',
      width: 130,
      render: (_value, record) => (record.latest ? formatRate(record.dailyRate, record.tailPoint.unit) : '—')
    },
    {
      title: '占阈值比',
      width: 100,
      render: (_value, record) => `${(record.ratio * 100).toFixed(1)}%`
    },
    {
      title: '判定',
      width: 140,
      render: (_value, record) => {
        if (!record.latest) return <Tag>暂无观测</Tag>
        return record.level ? <AlarmTag level={record.level} size="small" /> : <Tag color="green">正常</Tag>
      }
    },
    {
      title: '操作',
      width: 160,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => setDrawerHeadId(record.chain.headId)}>
            曲线
          </Button>
          <Button
            type="link"
            size="small"
            disabled={!record.latest || record.ratio < 0.7}
            onClick={() => generateAlarm(record)}
          >
            生成预警
          </Button>
        </Space>
      )
    }
  ]

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">累计位移与沉降速率计算</h2>
          <p className="page-head__desc">
            按接续链连续累计量占阈值比降序排列；日速率沿相邻观测（含跨点衔接）差值除以间隔天数得到。
          </p>
        </div>
        <div className="page-head__actions">
          <Button onClick={() => setOnlyExceeded((value) => !value)}>{onlyExceeded ? '查看全部测点链' : '仅看越限测点链'}</Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="物理测点" value={pointStore.points.length} suffix="个" tone="primary" />
        <StatBadge label="接续链" value={chains.chains.length} suffix="条" tone="info" />
        <StatBadge label="越限链" value={exceededCount} suffix="条" tone="warning" />
        <StatBadge label="平均日速率" value={averageRate.toFixed(4)} suffix="/d" tone="danger" />
      </div>

      <FilterBar
        model={model}
        selects={filterSelects}
        keywordPlaceholder="搜索测点编号（含链上旧点）"
        onModelChange={onModelChange}
      />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            速率排行（{trendRows.length} 条链 / {pointStore.points.length} 个物理测点）
          </h3>
          <span className="muted">点击「曲线」查看该接续链全部观测记录</span>
        </div>
        {trendRows.length === 0 ? (
          <EmptyPanel
            title="没有可计算的测点"
            description="先到观测录入页登记各测点的读数。"
            secondaryText="查看全部测点"
            onSecondary={() => setOnlyExceeded(false)}
            compact
          />
        ) : (
          <Table<TrendRow>
            rowKey={(record) => record.chain.headId}
            size="small"
            bordered
            dataSource={trendRows}
            columns={columns}
            pagination={false}
            scroll={{ x: 1500 }}
          />
        )}
      </div>

      <Drawer
        open={drawerHeadId !== null}
        width={700}
        title={drawerChain ? `接续链 · ${drawerChain.pointIds.map((id) => pointById(id)?.code ?? id).join(' → ')}` : '测点详情'}
        onClose={() => setDrawerHeadId(null)}
      >
        {drawerChain && drawerTailPoint ? (
          <>
            <Descriptions size="small" bordered column={2}>
              <Descriptions.Item label="当前在测测点">{drawerTailPoint.code}</Descriptions.Item>
              <Descriptions.Item label="类型 / 单位">{`${drawerTailPoint.type} / ${drawerTailPoint.unit}`}</Descriptions.Item>
              <Descriptions.Item label="链上测点数">{drawerChain.pointIds.length}</Descriptions.Item>
              <Descriptions.Item label="链上观测次数">{drawerObservations.length}</Descriptions.Item>
              <Descriptions.Item label="阈值">{drawerTailPoint.threshold}</Descriptions.Item>
              <Descriptions.Item label="最新判定">
                {drawerLevel ? <AlarmTag level={drawerLevel} size="small" /> : <Tag color="green">正常</Tag>}
              </Descriptions.Item>
            </Descriptions>
            <div style={{ margin: '12px 0', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {drawerLatest ? (
                <Button type="primary" size="small" disabled={!drawerLevel} onClick={() => {
                  const row = trendRows.find((item) => item.chain.headId === drawerChain.headId)
                  if (row) void generateAlarm(row)
                }}>
                  按最新观测生成预警单
                </Button>
              ) : null}
              <Button size="small" onClick={() => openThreshold(drawerTailPoint)}>
                编辑在测点阈值
              </Button>
              <Popconfirm
                title="删除当前在测测点将同时删除其观测、预警与相关接替关系"
                onConfirm={() => {
                  const row = trendRows.find((item) => item.chain.headId === drawerChain.headId)
                  if (row) void removeTailPoint(row)
                }}
              >
                <Button size="small" danger>
                  删除在测测点
                </Button>
              </Popconfirm>
            </div>

            {drawerChain.segments.length > 1 ? (
              <div style={{ marginBottom: 12, padding: '8px 12px', background: '#f7fafd', borderRadius: 8, fontSize: 13 }}>
                {drawerChain.segments.map((segment) => {
                  const point = pointById(segment.pointId)
                  const sc = segment.succession
                  return (
                    <div key={segment.pointId} style={{ margin: '4px 0' }}>
                      <Tag color={segment.pointId === drawerChain.tailId ? 'blue' : 'default'}>
                        {point?.code ?? segment.pointId}
                      </Tag>
                      <span className="muted">
                        {sc
                          ? `自 ${sc.effectiveDate} 接替 ${pointById(sc.predecessorId)?.code ?? sc.predecessorId}，继承累计 ${sc.inheritedCumulative.toFixed(3)}`
                          : '链头原始测点'}
                      </span>
                    </div>
                  )
                })}
              </div>
            ) : null}

            {drawerObservations.length === 0 ? (
              <EmptyPanel title="暂无观测记录" description="该接续链尚未录入任何读数。" compact />
            ) : (
              <Table<ChainObservation>
                rowKey={(record) => record.observation.id}
                size="small"
                bordered
                pagination={false}
                dataSource={drawerObservations}
                columns={[
                  {
                    title: '测点',
                    width: 110,
                    render: (_v, record) => (
                      <Space size={4}>
                        {pointById(record.pointId)?.code ?? record.pointId}
                        {record.isJunction ? <Tag color="purple">衔接</Tag> : null}
                      </Space>
                    )
                  },
                  { title: '日期', width: 105, render: (_v, record) => record.observation.date },
                  { title: '读数', width: 100, render: (_v, record) => record.observation.reading.toFixed(3) },
                  { title: '连续累计', width: 110, render: (_v, record) => record.chainCumulative.toFixed(3) },
                  { title: '链日速率', width: 105, render: (_v, record) => record.chainDailyRate.toFixed(4) },
                  { title: '观测人', width: 90, render: (_v, record) => record.observation.observer }
                ]}
              />
            )}
          </>
        ) : (
          <EmptyPanel title="未选择测点" description="从速率排行中选择一条接续链查看详情。" compact />
        )}
      </Drawer>

      <Modal
        open={thresholdOpen}
        title={editingPoint ? `编辑阈值 · ${editingPoint.code}` : '编辑阈值'}
        onCancel={() => setThresholdOpen(false)}
        onOk={submitThreshold}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={thresholdForm} layout="vertical">
          <Form.Item
            name="initialValue"
            label={`初值（${editingPoint ? editingPoint.unit : ''}）`}
            tooltip={chains.isSuccessor(editingPoint?.id ?? '') ? '接替新点的初值是继承旧点累计的平移结果，修改会导致接续链断裂' : undefined}
          >
            <InputNumber step={0.01} style={{ width: '100%' }} disabled={editingPoint ? chains.isSuccessor(editingPoint.id) : false} />
          </Form.Item>
          <Form.Item
            name="threshold"
            label={`阈值 · 允许最大变化量（${editingPoint ? editingPoint.unit : ''}）`}
            rules={[{ required: true, message: '请填写阈值' }]}
          >
            <InputNumber min={0.01} step={0.5} style={{ width: '100%' }} />
          </Form.Item>
          {editingPoint && chains.isSuccessor(editingPoint.id) ? (
            <p className="muted">该点为接替新点：初值由接替日首读数与继承累计自动平移，如需调整请到测点接替页撤下关系。</p>
          ) : null}
        </Form>
      </Modal>
    </div>
  )
}
