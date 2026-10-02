/**
 * /trends 累计位移与沉降速率计算
 * 按测点降序展示累计变化量与日速率，抽屉内查看历次观测曲线并可直接生成预警单。
 * 消费 Observation、Point；复用 <StatBadge>、<AlarmTag>、<EmptyPanel>。
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
import { usePointChains } from '@/hooks/usePointChain'
import type { ChainReading } from '@/utils/succession'
import { POINT_TYPES, type Point, type PointType } from '@/types/point'
import { formatRate, formatReading, ratioOf } from '@/utils/threshold'

interface TrendRow {
  /** 链头测点 id（单点链即自身） */
  headId: string
  /** 链上测点（旧 → 新） */
  points: Point[]
  chainCode: string
  damName: string
  stakeNo: string
  /** 判定所用测点：链尾最新测点 */
  point: Point
  latest: ChainReading | null
  count: number
  cumulative: number
  dailyRate: number
  ratio: number
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

  const trendRows = useMemo<TrendRow[]>(() => {
    const rows = chains.headIds
      .map((headId) => {
        const chainPoints = chains.pointsOf(headId)
        const head = chainPoints[0]
        if (!head) return null
        // 链上任一测点命中坝体 / 类型 / 关键字即展示整条链
        const matched = chainPoints.some((point) => {
          if (filter.damId && point.damId !== filter.damId) return false
          if (filter.types.length > 0 && !filter.types.includes(point.type)) return false
          const text = filter.keyword.trim().toLowerCase()
          if (text.length > 0 && !point.code.toLowerCase().includes(text)) return false
          return true
        })
        if (!matched) return null
        const summary = chains.summaryOf(headId)
        const latest = summary.latest
        // 最新观测所属测点决定阈值与判定（通常是链尾新点）
        const activePoint =
          (latest ? chainPoints.find((point) => point.id === latest.pointId) : undefined) ?? chainPoints[chainPoints.length - 1]
        const section = damStore.sections.find((item) => item.id === activePoint.sectionId)
        const dam = damStore.dams.find((item) => item.id === activePoint.damId)
        const cumulative = latest ? latest.cumulative : 0
        return {
          headId,
          points: chainPoints,
          chainCode: chains.codeOf(headId),
          damName: dam ? dam.name : '—',
          stakeNo: section ? section.stakeNo : '—',
          point: activePoint,
          latest,
          count: summary.readings.length,
          cumulative,
          dailyRate: latest ? latest.dailyRate : 0,
          ratio: ratioOf(cumulative, activePoint.threshold)
        }
      })
      .filter((row): row is TrendRow => row !== null)
    const filtered = onlyExceeded ? rows.filter((row) => row.ratio >= 0.7) : rows
    return filtered.sort((a, b) => b.ratio - a.ratio)
  }, [chains, filter, onlyExceeded, damStore.sections, damStore.dams])

  const exceededCount = trendRows.filter((row) => row.ratio >= 0.7).length
  const averageRate = useMemo(() => {
    const rated = trendRows.filter((row) => row.latest !== null)
    if (rated.length === 0) return 0
    return rated.reduce((sum, row) => sum + row.dailyRate, 0) / rated.length
  }, [trendRows])

  /** 抽屉：按链头展示整条接续链 */
  const drawerChainPoints = drawerHeadId ? chains.pointsOf(drawerHeadId) : []
  const drawerPoint = drawerChainPoints[drawerChainPoints.length - 1] ?? null
  const drawerSummary = drawerHeadId ? chains.summaryOf(drawerHeadId) : null
  const drawerReadings = drawerSummary ? [...drawerSummary.readings].reverse() : []
  const drawerLatest = drawerSummary?.latest ?? null
  const drawerEffectiveInitial = drawerPoint ? chains.initialValueOf(drawerPoint.id) : 0
  const drawerLevel =
    drawerPoint && drawerLatest ? alarmLevel.evaluate(drawerPoint, drawerLatest.reading, drawerEffectiveInitial).level : null

  const generateAlarm = async (point: Point, reading: ChainReading): Promise<void> => {
    if (alarmStore.alarms.some((alarm) => alarm.pointId === point.id && alarm.triggerDate === reading.date)) {
      message.info('该测点当日已生成预警单')
      return
    }
    const result = alarmLevel.buildDraft(point, reading.date, reading.reading, chains.initialValueOf(point.id))
    if (!result) {
      message.info('该观测未越限，无需生成预警单')
      return
    }
    await alarmStore.createAlarm({ ...result.draft, measure: result.basis })
    message.success(`已生成${result.draft.level}色预警单，归属当前测点 ${point.code}`)
  }

  const openThreshold = (point: Point): void => {
    setEditingPoint(point)
    thresholdForm.setFieldsValue({ initialValue: point.initialValue, threshold: point.threshold })
    setThresholdOpen(true)
  }

  const submitThreshold = async (): Promise<void> => {
    if (!editingPoint) return
    const values = await thresholdForm.validateFields().catch(() => null)
    if (!values) return
    await pointStore.updatePoint(editingPoint.id, {
      initialValue: values.initialValue,
      threshold: values.threshold
    })
    message.success(`${editingPoint.code} 初值与阈值已更新，历史观测偏差已重算`)
    setThresholdOpen(false)
  }

  const removePoint = async (point: Point): Promise<void> => {
    await pointStore.removePoint(point.id)
    setDrawerHeadId(null)
    message.success('测点及其观测记录已删除')
  }

  const columns: TableColumnsType<TrendRow> = [
    {
      title: '排名',
      width: 70,
      render: (_value, _record, index) => index + 1
    },
    {
      title: '接续链（旧 → 新）',
      width: 210,
      render: (_value, record) => (
        <Space size={4} wrap>
          <strong>{record.chainCode}</strong>
          {record.points.length > 1 ? <Tag color="blue">接替链 {record.points.length} 点</Tag> : null}
        </Space>
      )
    },
    {
      title: '坝体 / 桩号',
      width: 190,
      render: (_value, record) => `${record.damName} / ${record.stakeNo}`
    },
    { title: '类型', width: 100, render: (_value, record) => <Tag color="blue">{record.point.type}</Tag> },
    { title: '连续观测次数', width: 120, render: (_value, record) => record.count },
    {
      title: '最新读数',
      width: 140,
      render: (_value, record) =>
        record.latest ? formatReading(record.latest.reading, record.point.unit) : <span className="muted">暂无观测</span>
    },
    {
      title: '连续累计',
      width: 140,
      render: (_value, record) => (
        <span style={{ color: record.ratio >= 0.7 ? '#b03a2e' : undefined }}>
          {record.cumulative.toFixed(3)} {record.point.unit}
        </span>
      )
    },
    {
      title: '日速率',
      width: 130,
      render: (_value, record) => (record.latest ? formatRate(record.dailyRate, record.point.unit) : '—')
    },
    {
      title: '占阈值比',
      width: 110,
      render: (_value, record) => `${(record.ratio * 100).toFixed(1)}%`
    },
    {
      title: '判定',
      width: 150,
      render: (_value, record) => {
        if (!record.latest) return <Tag>暂无观测</Tag>
        const level = alarmLevel.evaluate(record.point, record.latest.reading, chains.initialValueOf(record.point.id)).level
        return level ? <AlarmTag level={level} size="small" /> : <Tag color="green">正常</Tag>
      }
    },
    {
      title: '操作',
      width: 170,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => setDrawerHeadId(record.headId)}>
            曲线
          </Button>
          <Button
            type="link"
            size="small"
            disabled={!record.latest || record.ratio < 0.7}
            onClick={() => record.latest && generateAlarm(record.point, record.latest)}
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
            按接续链连续展示累计变化量与日速率（损坏换号测点自动接档），按占阈值比降序排列。
          </p>
        </div>
        <div className="page-head__actions">
          <Button onClick={() => setOnlyExceeded((value) => !value)}>{onlyExceeded ? '查看全部监测序列' : '仅看越限序列'}</Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="监测序列" value={chains.headIds.length} suffix="条（含接续链）" tone="primary" />
        <StatBadge label="越限序列" value={exceededCount} suffix="条" tone="warning" />
        <StatBadge
          label="越限占比"
          value={exceededCount}
          percent={chains.headIds.length === 0 ? 0 : Math.round((exceededCount / chains.headIds.length) * 100)}
          tone="danger"
        />
        <StatBadge label="平均日速率" value={averageRate.toFixed(4)} suffix="/d" tone="info" />
      </div>

      <FilterBar
        model={model}
        selects={filterSelects}
        keywordPlaceholder="搜索测点编号（链上任一测点）"
        onModelChange={onModelChange}
      />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            速率排行（{trendRows.length} / {chains.headIds.length} 条序列）
          </h3>
          <span className="muted">点击「曲线」查看该接续链的连续观测记录</span>
        </div>
        {trendRows.length === 0 ? (
          <EmptyPanel
            title="没有可计算的监测序列"
            description="先到观测录入页登记各测点的读数；损坏换号的测点可在测点接替页登记关系。"
            secondaryText="查看全部序列"
            onSecondary={() => setOnlyExceeded(false)}
            compact
          />
        ) : (
          <Table<TrendRow>
            rowKey={(record) => record.headId}
            size="small"
            bordered
            dataSource={trendRows}
            columns={columns}
            pagination={false}
            scroll={{ x: 1400 }}
          />
        )}
      </div>

      <Drawer
        open={drawerHeadId !== null}
        width={680}
        title={drawerHeadId ? `${chains.codeOf(drawerHeadId)} · 连续观测曲线` : '接续链详情'}
        onClose={() => setDrawerHeadId(null)}
      >
        {drawerPoint ? (
          <>
            <Descriptions size="small" bordered column={2}>
              <Descriptions.Item label="接续链">
                {drawerChainPoints.map((point) => point.code).join(' → ')}
              </Descriptions.Item>
              <Descriptions.Item label="当前测点">{drawerPoint.code}</Descriptions.Item>
              <Descriptions.Item label="测点类型">{drawerPoint.type}</Descriptions.Item>
              <Descriptions.Item label="单位">{drawerPoint.unit}</Descriptions.Item>
              <Descriptions.Item label="连续口径初值">{chains.initialValueOf(drawerPoint.id)}</Descriptions.Item>
              <Descriptions.Item label="阈值">{drawerPoint.threshold}</Descriptions.Item>
              <Descriptions.Item label="连续观测次数">{drawerReadings.length}</Descriptions.Item>
              <Descriptions.Item label="最新判定">
                {drawerLevel ? <AlarmTag level={drawerLevel} size="small" /> : <Tag color="green">正常</Tag>}
              </Descriptions.Item>
            </Descriptions>
            <div style={{ margin: '14px 0', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {drawerLatest ? (
                <Button
                  type="primary"
                  size="small"
                  disabled={!drawerLevel}
                  onClick={() => generateAlarm(drawerPoint, drawerLatest)}
                >
                  按最新观测生成预警单（归属 {drawerPoint.code}）
                </Button>
              ) : null}
              <Button size="small" onClick={() => openThreshold(drawerPoint)}>
                编辑当前测点初值与阈值
              </Button>
              <Popconfirm
                title={drawerChainPoints.length > 1 ? '当前测点在接续链中，需先在测点接替页撤下关系' : '删除该测点将同时删除其观测记录与预警单'}
                onConfirm={() => removePoint(drawerPoint)}
                disabled={drawerChainPoints.length > 1}
              >
                <Button size="small" danger disabled={drawerChainPoints.length > 1}>
                  删除测点
                </Button>
              </Popconfirm>
            </div>
            {drawerReadings.length === 0 ? (
              <EmptyPanel title="暂无观测记录" description="该接续链尚未录入任何读数。" compact />
            ) : (
              <Table<ChainReading>
                rowKey="observationId"
                size="small"
                bordered
                pagination={false}
                dataSource={drawerReadings}
                columns={[
                  { title: '日期', dataIndex: 'date', width: 110 },
                  {
                    title: '归属测点',
                    width: 110,
                    render: (_value, record) => (
                      <Tag color={record.nodeIndex > 0 ? 'blue' : 'default'}>
                        {drawerChainPoints.find((point) => point.id === record.pointId)?.code ?? record.pointId}
                      </Tag>
                    )
                  },
                  { title: '读数', dataIndex: 'reading', width: 90, render: (value: number) => value.toFixed(3) },
                  { title: '连续累计', dataIndex: 'cumulative', width: 100, render: (value: number) => value.toFixed(3) },
                  { title: '日速率', dataIndex: 'dailyRate', width: 100, render: (value: number) => value.toFixed(4) },
                  {
                    title: '接档',
                    width: 90,
                    render: (_value, record) => (record.acrossLink ? <Tag color="blue">跨接替</Tag> : '—')
                  }
                ]}
              />
            )}
          </>
        ) : (
          <EmptyPanel title="未选择监测序列" description="从速率排行中选择一条接续链查看详情。" compact />
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
            rules={[{ required: true, message: '请填写初值' }]}
          >
            <InputNumber step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="threshold"
            label={`阈值 · 允许最大变化量（${editingPoint ? editingPoint.unit : ''}）`}
            rules={[{ required: true, message: '请填写阈值' }]}
          >
            <InputNumber min={0.01} step={0.5} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
