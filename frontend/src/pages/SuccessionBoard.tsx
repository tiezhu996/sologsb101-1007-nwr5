/**
 * /successions 测点接替关系管理
 * 建立/撤下测点接替：旧点保留原始观测，新点按接替日首读数继承累计值，
 * 趋势与处置沿接续链连续；生效前预览受影响观测与未闭环预警，写前留检查点可恢复。
 * 消费 Succession、Point、Observation、Alarm、Checkpoint。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  DatePicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import type { TableColumnsType } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import EmptyPanel from '@/components/common/EmptyPanel'
import StatBadge from '@/components/common/StatBadge'
import { useDamStore } from '@/stores/damStore'
import { usePointStore } from '@/stores/pointStore'
import { useAlarmStore } from '@/stores/alarmStore'
import { useSuccessionStore } from '@/stores/successionStore'
import { usePointChains } from '@/hooks/usePointChains'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type CheckpointRow, type ObservationRow } from '@/utils/db'
import type { Point } from '@/types/point'
import { buildSuccessionImpact, validateSuccession } from '@/utils/succession'
import { SUCCESSION_ERROR_TEXT, type Succession, type SuccessionImpact } from '@/types/succession'

interface CreateFormValues {
  predecessorId: string
  successorMode: 'existing' | 'new'
  successorId?: string
  effectiveDate: Dayjs
  firstReading: number
  remark: string
  code?: string
  sectionId?: string
  threshold?: number
  installDate?: Dayjs
}

export default function SuccessionBoard() {
  const { message, modal } = AntdApp.useApp()
  const damStore = useDamStore()
  const pointStore = usePointStore()
  const alarmStore = useAlarmStore()
  const successionStore = useSuccessionStore()
  const chains = usePointChains()
  const observationTable = useIdbTable<ObservationRow>(db.observations, { sortByUpdatedAt: false })

  const [open, setOpen] = useState(false)
  const [form] = Form.useForm<CreateFormValues>()
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)

  const predecessorId = Form.useWatch('predecessorId', form)
  const successorMode = Form.useWatch('successorMode', form)
  const successorId = Form.useWatch('successorId', form)
  const effectiveDate = Form.useWatch('effectiveDate', form)
  const firstReading = Form.useWatch('firstReading', form)

  const codeOf = (id: string): string => pointStore.points.find((point) => point.id === id)?.code ?? '已删除测点'
  const pointById = (id: string): Point | undefined => pointStore.points.find((point) => point.id === id)

  /** 可被接替的旧点：尚未停测（没有出边） */
  const predecessorOptions = useMemo(
    () =>
      pointStore.points
        .filter((point) => !chains.isRetired(point.id))
        .map((point) => {
          const dam = damStore.dams.find((item) => item.id === point.damId)
          return {
            label: `${point.code} · ${point.type} · ${dam ? dam.name : '未知坝体'}`,
            value: point.id
          }
        }),
    [pointStore.points, damStore.dams, chains]
  )

  /** 可作为新点的候选：无观测、未在任何链中、与旧点同断面同类型同单位 */
  const successorOptions = useMemo(() => {
    const predecessor = predecessorId ? pointById(predecessorId) : undefined
    return pointStore.points
      .filter((point) => {
        if (chains.isRetired(point.id) || chains.isSuccessor(point.id)) return false
        if (point.id === predecessorId) return false
        if (observationTable.rows.some((row) => row.pointId === point.id)) return false
        if (predecessor && (point.type !== predecessor.type || point.unit !== predecessor.unit)) return false
        return true
      })
      .map((point) => {
        const dam = damStore.dams.find((item) => item.id === point.damId)
        return {
          label: `${point.code} · ${point.type} · ${dam ? dam.name : '未知坝体'}`,
          value: point.id
        }
      })
  }, [pointStore.points, predecessorId, observationTable.rows, damStore.dams, chains])

  const sectionOptions = useMemo(() => {
    const predecessor = predecessorId ? pointById(predecessorId) : undefined
    return damStore.sections
      .filter((section) => !predecessor || section.damId === predecessor.damId)
      .map((section) => {
        const dam = damStore.dams.find((item) => item.id === section.damId)
        return { label: `${dam ? dam.name : '未知坝体'} · 桩号 ${section.stakeNo}`, value: section.id }
      })
  }, [damStore.sections, damStore.dams, predecessorId])

  /** 生效前影响预览（受影响观测 + 未闭环预警 + 继承基线） */
  const impact = useMemo<{ impact: SuccessionImpact } | { error: string } | null>(() => {
    const predecessor = predecessorId ? pointById(predecessorId) : undefined
    if (!predecessor) return null
    const dateText = effectiveDate ? dayjs(effectiveDate).format('YYYY-MM-DD') : ''
    const targetSuccessor =
      successorMode === 'existing' && successorId
        ? pointById(successorId)
        : predecessor
          ? { ...predecessor, id: '__new__', code: form.getFieldValue('code') ?? '新测点' }
          : undefined
    if (!targetSuccessor) return null
    const successorObservationCount =
      successorMode === 'existing' && successorId
        ? observationTable.rows.filter((row) => row.pointId === successorId).length
        : 0
    const errorCode = validateSuccession({
      predecessor,
      successor: targetSuccessor,
      effectiveDate: dateText,
      successions: successionStore.successions,
      successorObservationCount
    })
    if (errorCode) return { error: SUCCESSION_ERROR_TEXT[errorCode] }
    if (typeof firstReading !== 'number' || !Number.isFinite(firstReading)) return null
    const openAlarms = alarmStore.alarms
      .filter((alarm) => alarm.pointId === predecessor.id && alarm.state !== '已闭环')
      .map((alarm) => ({
        id: alarm.id,
        level: alarm.level,
        state: alarm.state,
        triggerDate: alarm.triggerDate,
        triggerValue: alarm.triggerValue
      }))
    const result = buildSuccessionImpact({
      predecessor,
      successor: targetSuccessor,
      effectiveDate: dateText,
      firstReading,
      observations: observationTable.rows,
      openAlarms
    })
    if (typeof result === 'string') return { error: SUCCESSION_ERROR_TEXT[result] }
    return { impact: result }
  }, [
    predecessorId,
    successorMode,
    successorId,
    effectiveDate,
    firstReading,
    pointStore.points,
    observationTable.rows,
    alarmStore.alarms,
    successionStore.successions,
    form
  ])

  const openCreate = (preselectPoint?: Point): void => {
    form.setFieldsValue({
      predecessorId: preselectPoint?.id,
      successorMode: 'existing',
      successorId: undefined,
      effectiveDate: dayjs(),
      firstReading: preselectPoint
        ? observationTable.rows
            .filter((row) => row.pointId === preselectPoint.id)
            .sort((a, b) => b.date.localeCompare(a.date))[0]?.reading ?? preselectPoint.initialValue
        : 0,
      remark: '',
      code: preselectPoint ? `${preselectPoint.code}A` : '',
      sectionId: preselectPoint?.sectionId,
      threshold: preselectPoint?.threshold,
      installDate: dayjs()
    })
    setOpen(true)
  }

  // 从测点配置页带选中点跳入时，自动以该点为旧点打开建立弹窗（仅首次）
  const preselectId = pointStore.selectedIds[0]
  useEffect(() => {
    if (!preselectId || pointStore.points.length === 0) return
    const point = pointStore.points.find((item) => item.id === preselectId)
    if (point && !chains.isRetired(point.id)) {
      openCreate(point)
      pointStore.setSelectedIds([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselectId])

  const submit = async (): Promise<void> => {
    const values = await form.validateFields().catch(() => null)
    if (!values) return
    if (!impact || 'error' in impact) {
      message.error(impact && 'error' in impact ? impact.error : '请完善接替信息')
      return
    }
    const predecessor = pointById(values.predecessorId)
    if (!predecessor) return

    const baseInput = {
      predecessorId: predecessor.id,
      effectiveDate: dayjs(values.effectiveDate).format('YYYY-MM-DD'),
      firstReading: Number(values.firstReading) || 0,
      inheritedCumulative: impact.impact.inheritedCumulative,
      predecessorLastDate: impact.impact.predecessorLastDate,
      remark: values.remark?.trim() ?? ''
    }

    setBusy(true)
    try {
      if (values.successorMode === 'new') {
        const section = damStore.sections.find((item) => item.id === values.sectionId)
        if (!section || !values.code?.trim()) {
          message.error('请完整填写新测点的断面与编号')
          return
        }
        // 检查点先落库，再建新点+接替；任一步失败都能整体回到操作前（新点不会残留）
        await successionStore.applyWithNewPoint(
          {
            ...baseInput,
            successorId: '__pending__',
            originalInitialValue: 0,
            successorObservationCount: 0
          },
          {
            sectionId: section.id,
            damId: section.damId,
            code: values.code.trim(),
            type: predecessor.type,
            threshold: Number(values.threshold) || predecessor.threshold || 1,
            unit: predecessor.unit,
            installDate: values.installDate ? dayjs(values.installDate).format('YYYY-MM-DD') : ''
          }
        )
      } else {
        const existing = values.successorId ? pointById(values.successorId) : undefined
        if (!existing) {
          message.error('请选择接替新测点')
          return
        }
        await successionStore.apply({
          ...baseInput,
          successorId: existing.id,
          originalInitialValue: existing.initialValue,
          successorObservationCount: observationTable.rows.filter((row) => row.pointId === existing.id).length
        })
      }
      message.success('接替已生效：旧点保留原始观测，新点已继承累计值')
      setOpen(false)
    } catch (error) {
      modal.error({
        title: '接替关系写入失败',
        content: `数据未受影响，可使用页面上的检查点恢复到写入前状态。错误：${error instanceof Error ? error.message : '未知错误'}`,
        okText: '知道了'
      })
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (record: Succession): Promise<void> => {
    // 撤下前置约束：新点未闭环预警不能回退归属
    const openOnSuccessor = alarmStore.alarms.filter(
      (alarm) => alarm.pointId === record.successorId && alarm.state !== '已闭环'
    )
    if (openOnSuccessor.length > 0) {
      modal.warning({
        title: '暂不能撤下接替关系',
        content: `新测点 ${codeOf(record.successorId)} 尚有 ${openOnSuccessor.length} 张未闭环预警。接替后的预警按新点归属，撤下关系不会自动改挂，请先闭环或删除这些预警。`,
        okText: '知道了'
      })
      return
    }
    setBusy(true)
    try {
      await successionStore.revoke(record.id, `${codeOf(record.predecessorId)} → ${codeOf(record.successorId)}`)
      message.success('已撤下接替关系：新点初值与观测已恢复单点口径，已闭环处置记录照旧保留')
    } catch (error) {
      modal.error({
        title: '撤下接替关系失败',
        content: `可使用页面上的检查点恢复。错误：${error instanceof Error ? error.message : '未知错误'}`,
        okText: '知道了'
      })
    } finally {
      setBusy(false)
    }
  }

  const restore = async (checkpoint: CheckpointRow): Promise<void> => {
    setRestoring(checkpoint.id)
    try {
      await successionStore.restore(checkpoint.id)
      message.success('已从检查点恢复到操作前状态')
    } catch (error) {
      message.error(`恢复失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setRestoring(null)
    }
  }

  const successionColumns: TableColumnsType<Succession> = [
    {
      title: '旧测点（保留原始观测）',
      width: 200,
      render: (_value, record) => {
        const point = pointById(record.predecessorId)
        return (
          <Space direction="vertical" size={0}>
            <strong>{codeOf(record.predecessorId)}</strong>
            <span className="muted">{point ? point.type : '—'}</span>
          </Space>
        )
      }
    },
    { title: '接替生效日', dataIndex: 'effectiveDate', width: 120 },
    {
      title: '新测点（当前在测）',
      width: 200,
      render: (_value, record) => {
        const point = pointById(record.successorId)
        return (
          <Space direction="vertical" size={0}>
            <strong>{codeOf(record.successorId)}</strong>
            <span className="muted">{point ? point.type : '—'}</span>
          </Space>
        )
      }
    },
    {
      title: '继承累计',
      width: 150,
      render: (_value, record) => {
        const point = pointById(record.successorId)
        return `${record.inheritedCumulative.toFixed(3)} ${point ? point.unit : ''}`
      }
    },
    {
      title: '首读数 / 平移后初值',
      width: 190,
      render: (_value, record) => {
        const point = pointById(record.successorId)
        const shifted = point ? (record.firstReading - record.inheritedCumulative).toFixed(3) : '—'
        const unit = point ? point.unit : ''
        return (
          <span>
            {record.firstReading.toFixed(3)} / {shifted} {unit}
          </span>
        )
      }
    },
    {
      title: '旧点未闭环预警',
      width: 140,
      render: (_value, record) => {
        const count = alarmStore.alarms.filter(
          (alarm) => alarm.pointId === record.predecessorId && alarm.state !== '已闭环'
        ).length
        return count > 0 ? <Tag color="orange">{count} 张（仍挂旧点）</Tag> : <Tag>无</Tag>
      }
    },
    { title: '备注', dataIndex: 'remark', render: (value: string) => value || '—' },
    {
      title: '操作',
      width: 110,
      render: (_value, record) => (
        <Popconfirm
          title="撤下接替关系后，新点初值与观测恢复单点口径；已闭环处置记录照旧。确认撤下？"
          onConfirm={() => revoke(record)}
          okButtonProps={{ loading: busy }}
        >
          <Button type="link" size="small" danger>
            撤下接替
          </Button>
        </Popconfirm>
      )
    }
  ]

  const multiSegmentChains = chains.chains.filter((chain) => chain.segments.length > 1)

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">测点接替关系</h2>
          <p className="page-head__desc">
            旧测点保留原始观测，新测点按接替日首读数继承旧点累计值；累计位移、日速率与处置页沿接续链连续展示。
          </p>
        </div>
        <div className="page-head__actions">
          <Button type="primary" onClick={() => openCreate()} disabled={pointStore.points.length === 0}>
            建立接替
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="测点总数" value={pointStore.points.length} suffix="个" tone="primary" />
        <StatBadge label="接替关系" value={successionStore.successions.length} suffix="条" tone="info" />
        <StatBadge label="停测旧点" value={chains.retiredIds.size} suffix="个" tone="warning" />
        <StatBadge
          label="待处理检查点"
          value={successionStore.checkpoints.filter((item) => item.status === 'pending').length}
          suffix="个"
          tone="danger"
        />
      </div>

      {successionStore.checkpoints.length > 0 ? (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message="存在写前检查点"
          description={
            <Space direction="vertical" style={{ width: '100%' }}>
              {successionStore.checkpoints.map((checkpoint) => (
                <Space key={checkpoint.id} wrap>
                  <Tag color={checkpoint.status === 'restored' ? 'green' : 'orange'}>
                    {checkpoint.status === 'restored' ? '已恢复' : '待处理'}
                  </Tag>
                  <span>{checkpoint.label}</span>
                  <span className="muted">{dayjs(checkpoint.createdAt).format('YYYY-MM-DD HH:mm')}</span>
                  {checkpoint.status === 'pending' ? (
                    <Popconfirm title="确认从该检查点恢复？当前相关数据将被覆盖回快照状态" onConfirm={() => restore(checkpoint)}>
                      <Button size="small" loading={restoring === checkpoint.id}>
                        从检查点恢复
                      </Button>
                    </Popconfirm>
                  ) : null}
                  <Popconfirm title="确认删除该检查点？" onConfirm={() => successionStore.removeCheckpoint(checkpoint.id)}>
                    <Button size="small" type="link" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ))}
            </Space>
          }
        />
      ) : null}

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            接替关系（{successionStore.successions.length}）
          </h3>
          <span className="muted">旧预警不自动改挂；新预警按接替后的测点归属</span>
        </div>
        {successionStore.successions.length === 0 ? (
          <EmptyPanel
            title="还没有接替关系"
            description="测点损坏撤换时建立接替：选择旧点与新点，填写接替日首读数，系统自动继承旧点累计值。"
            actionText="建立接替"
            onAction={() => openCreate()}
            compact
          />
        ) : (
          <Table<Succession>
            rowKey="id"
            size="small"
            bordered
            dataSource={successionStore.successions}
            columns={successionColumns}
            pagination={false}
            scroll={{ x: 1200 }}
          />
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            接续链总览（{chains.chains.length} 条链，其中多测点链 {multiSegmentChains.length} 条）
          </h3>
          <span className="muted">链上观测按接替生效日衔接，跨点计算日速率</span>
        </div>
        {chains.chains.length === 0 ? (
          <EmptyPanel title="暂无测点" description="先到测点配置页布设测点。" compact />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {chains.chains.map((chain) => {
              const head = pointById(chain.headId)
              const tail = pointById(chain.tailId)
              const latest = chain.observations[chain.observations.length - 1]
              return (
                <div
                  key={chain.headId}
                  style={{ border: '1px solid #dde5ee', borderRadius: 10, padding: '12px 14px' }}
                >
                  <Space wrap size={8}>
                    {chain.pointIds.map((id, index) => (
                      <Space key={id} size={8}>
                        <Tag
                          color={id === chain.tailId ? 'blue' : chains.isRetired(id) ? 'default' : 'green'}
                          style={{ fontSize: 13, padding: '2px 10px' }}
                        >
                          {codeOf(id)}
                          {chains.isRetired(id) ? '（旧点停测）' : id === chain.tailId && chain.pointIds.length > 1 ? '（在测）' : ''}
                        </Tag>
                        {index < chain.pointIds.length - 1 ? <span className="muted">→</span> : null}
                      </Space>
                    ))}
                    <span className="muted">
                      链上观测 {chain.observations.length} 次 · 最新连续累计{' '}
                      {latest ? `${latest.chainCumulative.toFixed(3)} ${tail?.unit ?? ''}` : '—'}
                    </span>
                    {head && tail && chain.pointIds.length > 1 ? (
                      <Tooltip title="旧点原始观测独立保存，仅在链视图中衔接展示">
                        <Tag>{head.type}</Tag>
                      </Tooltip>
                    ) : null}
                  </Space>
                </div>
              )
            })}
          </Space>
        )}
      </div>

      <Modal
        open={open}
        title="建立测点接替"
        onCancel={() => setOpen(false)}
        onOk={submit}
        okText="确认接替生效"
        cancelText="取消"
        width={680}
        confirmLoading={busy}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ successorMode: 'existing' }}>
          <Alert
            style={{ marginBottom: 14 }}
            type="info"
            showIcon
            message="旧测点原始观测与旧预警原样保留；新测点按接替日首读数继承旧点累计值，旧预警不会自动改挂到新点。"
          />
          <Form.Item name="predecessorId" label="旧测点（损坏/撤换）" rules={[{ required: true, message: '请选择旧测点' }]}>
            <Select
              options={predecessorOptions}
              showSearch
              optionFilterProp="label"
              placeholder="选择被接替的测点"
              onChange={() => {
                form.setFieldValue('successorId', undefined)
              }}
            />
          </Form.Item>
          <Form.Item name="successorMode" label="新测点来源" rules={[{ required: true }]}>
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              options={[
                { label: '选择已有空测点', value: 'existing' },
                { label: '现场新建测点', value: 'new' }
              ]}
            />
          </Form.Item>
          {successorMode === 'existing' ? (
            <Form.Item name="successorId" label="接替新测点" rules={[{ required: true, message: '请选择新测点' }]}>
              <Select options={successorOptions} showSearch optionFilterProp="label" placeholder="仅可选择未录过数、同类型同单位的测点" />
            </Form.Item>
          ) : (
            <>
              <Space wrap size={12} style={{ display: 'flex' }}>
                <Form.Item
                  name="sectionId"
                  label="所属断面"
                  style={{ flex: 1, minWidth: 220 }}
                  rules={[{ required: true, message: '请选择断面' }]}
                >
                  <Select options={sectionOptions} showSearch optionFilterProp="label" />
                </Form.Item>
                <Form.Item name="code" label="新测点编号" style={{ flex: 1, minWidth: 180 }} rules={[{ required: true, message: '请填写编号' }]}>
                  <Input placeholder="如 DB-01A" />
                </Form.Item>
              </Space>
              <Space wrap size={12} style={{ display: 'flex' }}>
                <Form.Item label="类型 / 单位" style={{ minWidth: 180 }}>
                  <Input value={predecessorId ? `${pointById(predecessorId)?.type ?? ''}（${pointById(predecessorId)?.unit ?? ''}）` : ''} disabled />
                </Form.Item>
                <Form.Item name="threshold" label="阈值" style={{ minWidth: 160 }} rules={[{ required: true, message: '请填写阈值' }]}>
                  <InputNumber min={0.1} step={0.5} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item name="installDate" label="安装日期" style={{ minWidth: 180 }} rules={[{ required: true, message: '请选择安装日期' }]}>
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Space>
            </>
          )}
          <Space wrap size={12} style={{ display: 'flex' }}>
            <Form.Item name="effectiveDate" label="接替生效日" style={{ minWidth: 200 }} rules={[{ required: true, message: '请选择生效日' }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="firstReading"
              label={predecessorId ? `接替日首读数（${pointById(predecessorId)?.unit ?? ''}）` : '接替日首读数'}
              style={{ minWidth: 200 }}
              rules={[{ required: true, message: '请填写首读数' }]}
            >
              <InputNumber step={0.1} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="remark" label="接替说明">
            <Input.TextArea rows={2} placeholder="如 测杆损坏，原位更换为新测点" />
          </Form.Item>

          {impact ? (
            'error' in impact ? (
              <Alert type="error" showIcon message="暂不能建立接替" description={impact.error} />
            ) : (
              <div style={{ border: '1px solid #dde5ee', borderRadius: 10, padding: 12 }}>
                <Typography.Text strong>生效前影响清单</Typography.Text>
                <Descriptions size="small" column={2} style={{ marginTop: 8 }}>
                  <Descriptions.Item label="旧点末次观测">
                    {impact.impact.predecessorLastDate} · {impact.impact.predecessorLastReading.toFixed(3)}
                  </Descriptions.Item>
                  <Descriptions.Item label="继承累计值">{impact.impact.inheritedCumulative.toFixed(3)}</Descriptions.Item>
                  <Descriptions.Item label="平移后新点初值">{impact.impact.shiftedInitialValue.toFixed(3)}</Descriptions.Item>
                  <Descriptions.Item label="保留原始观测">{impact.impact.predecessorObservations.length} 条（不改动）</Descriptions.Item>
                </Descriptions>
                <div style={{ marginTop: 4 }}>
                  <Space size={8}>
                    <Typography.Text strong>未闭环预警：</Typography.Text>
                    {impact.impact.openAlarms.length === 0 ? (
                      <Tag>无</Tag>
                    ) : (
                      impact.impact.openAlarms.map((alarm) => (
                        <Tag color="orange" key={alarm.id}>
                          {alarm.level}色 · {alarm.triggerDate} · {alarm.state}
                        </Tag>
                      ))
                    )}
                    <span className="muted">接替后仍挂旧点，不自动改挂</span>
                  </Space>
                </div>
              </div>
            )
          ) : (
            <Alert type="info" showIcon message="选择旧点、新点并填写接替日首读数后，这里列出受影响观测与未闭环预警。" />
          )}
        </Form>
      </Modal>
    </div>
  )
}
