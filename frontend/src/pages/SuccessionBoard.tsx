/**
 * /successions 测点接替管理
 * 把测点损坏后的接替登记为独立关系：
 * - 生效前列出旧点受影响观测与未闭环预警（影响预览，二次确认）；
 * - 新点按接替日首读数继承旧点累计值，链上累计位移 / 日速率连续；
 * - 旧预警不自动改挂，新预警归属接替后的测点；
 * - 写失败可从检查点恢复；撤下关系后计算与归属恢复，已闭环处置照旧；
 * - 无关系测点自动作为单点链，无需补数据。
 * 消费 Succession、Point、Observation、Alarm；复用 <FilterBar>、<StatBadge>、<EmptyPanel>。
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Alert,
  App as AntdApp,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography
} from 'antd'
import type { TableColumnsType } from 'antd'
import EmptyPanel from '@/components/common/EmptyPanel'
import StatBadge from '@/components/common/StatBadge'
import { useDamStore } from '@/stores/damStore'
import { usePointStore } from '@/stores/pointStore'
import { useAlarmStore } from '@/stores/alarmStore'
import {
  clearSuccessionCheckpoint,
  readSuccessionCheckpoint,
  useSuccessionStore
} from '@/stores/successionStore'
import { usePointChains } from '@/hooks/usePointChain'
import { previewSuccession, type SuccessionCheckpoint } from '@/utils/db'
import { EMPTY_SUCCESSION_DRAFT, type Succession, type SuccessionDraft } from '@/types/succession'
import type { Point } from '@/types/point'

interface LinkRow extends Succession {
  predecessor?: Point
  successor?: Point
  damName: string
  stakeNo: string
}

export default function SuccessionBoard() {
  const { message } = AntdApp.useApp()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const damStore = useDamStore()
  const pointStore = usePointStore()
  const alarmStore = useAlarmStore()
  const successionStore = useSuccessionStore()
  const chains = usePointChains()

  const [form] = Form.useForm<SuccessionDraft>()
  const [createOpen, setCreateOpen] = useState(false)
  const [impactOpen, setImpactOpen] = useState(false)
  const [impact, setImpact] = useState<Awaited<ReturnType<typeof previewSuccession>> | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [drawerLinkId, setDrawerLinkId] = useState<string | null>(null)
  const [checkpoint, setCheckpoint] = useState<SuccessionCheckpoint | null>(() => readSuccessionCheckpoint())
  const [keyword, setKeyword] = useState('')
  const [damId, setDamId] = useState('')

  const refreshCheckpoint = (): void => setCheckpoint(readSuccessionCheckpoint())

  const pointById = useMemo(() => new Map(pointStore.points.map((point) => [point.id, point])), [pointStore.points])

  const rows = useMemo<LinkRow[]>(() => {
    const text = keyword.trim().toLowerCase()
    return successionStore.successions
      .filter((link) => {
        if (successionStore.statusFilter.length > 0 && !successionStore.statusFilter.includes(link.status)) return false
        if (damId && link.damId !== damId) return false
        if (text.length === 0) return true
        const predecessor = pointById.get(link.predecessorId)
        const successor = pointById.get(link.successorId)
        return (
          (predecessor ? predecessor.code.toLowerCase().includes(text) : false) ||
          (successor ? successor.code.toLowerCase().includes(text) : false) ||
          link.note.toLowerCase().includes(text)
        )
      })
      .map((link) => {
        const predecessor = pointById.get(link.predecessorId)
        const successor = pointById.get(link.successorId)
        const anchor = predecessor ?? successor
        const section = anchor ? damStore.sections.find((item) => item.id === anchor.sectionId) : undefined
        const dam = damStore.dams.find((item) => item.id === link.damId)
        return {
          ...link,
          predecessor,
          successor,
          damName: dam ? dam.name : '—',
          stakeNo: section ? section.stakeNo : '—'
        }
      })
  }, [successionStore.successions, successionStore.statusFilter, keyword, damId, pointById, damStore.dams, damStore.sections])

  const activeLinks = successionStore.successions.filter((link) => link.status === '生效')
  const chainCount = chains.headIds.length
  const multiChainCount = chains.headIds.filter((head) => chains.pointsOf(head).length > 1).length

  /** 旧点候选：当前没有「接替出去」的生效关系（一点至多被接替一次） */
  const predecessorOptions = useMemo(
    () =>
      pointStore.points
        .filter((point) => !chains.outgoingLink(point.id))
        .map((point) => {
          const dam = damStore.dams.find((item) => item.id === point.damId)
          return { label: `${point.code} · ${point.type} · ${dam ? dam.name : '未知坝体'}`, value: point.id }
        }),
    [pointStore.points, chains, damStore.dams]
  )

  const selectedPredecessorId = Form.useWatch('predecessorId', form)
  const selectedPredecessor = selectedPredecessorId ? pointById.get(selectedPredecessorId) : undefined

  /** 新点候选：与旧点同类型、不能是旧点本身、当前没有进入/出去的生效关系 */
  const successorOptions = useMemo(() => {
    if (!selectedPredecessor) return []
    const sameChain = new Set(chains.pointsOf(chains.headOf(selectedPredecessor.id)).map((point) => point.id))
    return pointStore.points
      .filter(
        (point) =>
          point.id !== selectedPredecessor.id &&
          point.type === selectedPredecessor.type &&
          !sameChain.has(point.id) &&
          !chains.incomingLink(point.id) &&
          !chains.outgoingLink(point.id)
      )
      .map((point) => {
        const dam = damStore.dams.find((item) => item.id === point.damId)
        return { label: `${point.code} · ${point.type} · ${dam ? dam.name : '未知坝体'}`, value: point.id }
      })
  }, [selectedPredecessor, pointStore.points, chains, damStore.dams])

  // 支持从测点配置页带参进入：?from=<旧点id>
  useEffect(() => {
    const from = searchParams.get('from')
    if (from && pointById.has(from) && !chains.outgoingLink(from)) {
      openCreate(from)
    }
    // 仅在首次拿到测点数据时处理一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointStore.ready])

  function openCreate(predecessorId?: string): void {
    if (pointStore.points.length < 2) {
      message.warning('请先布设用于接替的新测点')
      return
    }
    form.setFieldsValue({
      ...EMPTY_SUCCESSION_DRAFT,
      predecessorId: predecessorId ?? '',
      successorId: '',
      effectiveDate: new Date().toISOString().slice(0, 10),
      note: ''
    })
    setImpact(null)
    setCreateOpen(true)
  }

  const openImpact = async (): Promise<void> => {
    const values = await form.validateFields().catch(() => null)
    if (!values) return
    setPreviewLoading(true)
    try {
      const result = await previewSuccession(values)
      setImpact(result)
      setCreateOpen(false)
      setImpactOpen(true)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '影响检查失败')
    } finally {
      setPreviewLoading(false)
    }
  }

  const confirmApply = async (): Promise<void> => {
    if (!impact) return
    setSubmitting(true)
    try {
      await successionStore.apply(impact.draft)
      message.success('接替关系已生效：旧点观测与预警保留，累计位移沿接续链连续')
      setImpactOpen(false)
      setImpact(null)
      refreshCheckpoint()
    } catch (error) {
      refreshCheckpoint()
      message.error(`接替写入失败${readSuccessionCheckpoint() ? '，可从检查点恢复' : ''}：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setSubmitting(false)
    }
  }

  const revoke = async (link: Succession): Promise<void> => {
    try {
      await successionStore.revoke(link.id)
      message.success('接替关系已撤下：新点累计量与预警归属恢复，已闭环处置记录照旧')
      refreshCheckpoint()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '撤下失败')
    }
  }

  const restore = async (): Promise<void> => {
    const cp = readSuccessionCheckpoint()
    if (!cp) return
    try {
      await successionStore.restoreCheckpoint(cp)
      clearSuccessionCheckpoint()
      refreshCheckpoint()
      message.success('已从检查点恢复到写入前状态')
    } catch (error) {
      message.error(`恢复失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  const dismissCheckpoint = (): void => {
    clearSuccessionCheckpoint()
    refreshCheckpoint()
  }

  const drawerLink = drawerLinkId ? successionStore.successions.find((link) => link.id === drawerLinkId) ?? null : null
  const drawerReadings = drawerLink
    ? chains.summaryOf(chains.headOf(drawerLink.predecessorId)).readings.filter((reading) => {
        if (reading.pointId === drawerLink.predecessorId) return reading.date < drawerLink.effectiveDate
        return reading.date >= drawerLink.effectiveDate
      })
    : []

  const columns: TableColumnsType<LinkRow> = [
    {
      title: '接续链（旧 → 新）',
      width: 220,
      render: (_value, record) => (
        <Space size={6} wrap>
          <strong>{record.predecessor ? record.predecessor.code : '测点已删除'}</strong>
          <span style={{ color: '#8a97a8' }}>→</span>
          <strong style={{ color: '#1f5c99' }}>{record.successor ? record.successor.code : '测点已删除'}</strong>
          <Tag color={record.status === '生效' ? 'green' : 'default'}>{record.status}</Tag>
        </Space>
      )
    },
    { title: '坝体 / 桩号', width: 180, render: (_value, record) => `${record.damName} / ${record.stakeNo}` },
    {
      title: '类型 / 单位',
      width: 130,
      render: (_value, record) =>
        record.successor ? `${record.successor.type} / ${record.successor.unit}` : record.predecessor?.type ?? '—'
    },
    { title: '接替日', dataIndex: 'effectiveDate', width: 110 },
    {
      title: '继承累计量',
      width: 150,
      render: (_value, record) => {
        if (!record.inherited || record.inheritedCumulative === null) return <Tag>待首读继承</Tag>
        const unit = record.successor?.unit ?? record.predecessor?.unit ?? ''
        return (
          <Space size={4}>
            <span>{record.inheritedCumulative.toFixed(3)} {unit}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              基准 {record.basisObservationDate ?? '—'}
            </Typography.Text>
          </Space>
        )
      }
    },
    {
      title: '旧点未闭环预警',
      width: 130,
      render: (_value, record) => {
        const count = alarmStore.alarms.filter(
          (alarm) => alarm.pointId === record.predecessorId && alarm.state !== '已闭环'
        ).length
        return count > 0 ? <Tag color="orange">{count} 张（保留旧点）</Tag> : <Tag>无</Tag>
      }
    },
    { title: '说明', dataIndex: 'note', ellipsis: true, render: (value: string) => value || '—' },
    {
      title: '操作',
      width: 170,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => setDrawerLinkId(record.id)}>
            连续序列
          </Button>
          {record.status === '生效' ? (
            <Popconfirm
              title="撤下该接替关系？"
              description="新点累计量与预警归属恢复，已闭环处置记录不变"
              onConfirm={() => revoke(record)}
            >
              <Button type="link" size="small" danger>
                撤下
              </Button>
            </Popconfirm>
          ) : (
            <Tag>已留痕</Tag>
          )}
        </Space>
      )
    }
  ]

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">测点接替管理</h2>
          <p className="page-head__desc">
            测点损坏后登记独立接替关系：旧点原始观测与历史预警保留，新点按接替日首读数继承累计值，趋势与处置沿接续链连续展示。
          </p>
        </div>
        <div className="page-head__actions">
          <Button onClick={() => navigate('/points')}>测点配置</Button>
          <Button type="primary" onClick={() => openCreate()}>
            登记接替
          </Button>
        </div>
      </div>

      {checkpoint ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message="存在未完成的接替写入检查点"
          description={
            <Space wrap>
              <span>
                {checkpoint.action === 'apply' ? '登记接替' : '撤下接替'}（{checkpoint.reason}，
                {new Date(checkpoint.createdAt).toLocaleString('zh-CN')}）写入过程中断，可整体恢复到写入前状态。
              </span>
              <Button size="small" type="primary" onClick={restore}>
                从检查点恢复
              </Button>
              <Button size="small" onClick={dismissCheckpoint}>
                忽略并清除
              </Button>
            </Space>
          }
        />
      ) : null}

      <div className="stat-row">
        <StatBadge label="接替关系" value={activeLinks.length} suffix="条生效" tone="primary" />
        <StatBadge label="多测点接续链" value={multiChainCount} suffix="条" tone="info" />
        <StatBadge label="逻辑监测序列" value={chainCount} suffix="条（含单点链）" tone="default" />
        <StatBadge
          label="旧点待处置预警"
          value={alarmStore.alarms.filter((alarm) => {
            const link = activeLinks.find((item) => item.predecessorId === alarm.pointId)
            return Boolean(link) && alarm.state !== '已闭环'
          }).length}
          suffix="张（不自动改挂）"
          tone="warning"
        />
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'center',
          padding: '14px 16px',
          background: '#ffffff',
          border: '1px solid #dde5ee',
          borderRadius: 10,
          marginBottom: 16
        }}
      >
        <Input.Search
          allowClear
          style={{ width: 240 }}
          placeholder="搜索新旧测点编号 / 说明"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <Select
          style={{ width: 200 }}
          allowClear
          placeholder="按坝体筛选"
          value={damId || undefined}
          onChange={(value: string | undefined) => setDamId(value ?? '')}
          options={damStore.dams.map((dam) => ({ label: dam.name, value: dam.id }))}
        />
        <Select
          style={{ width: 180 }}
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          placeholder="状态"
          value={successionStore.statusFilter}
          onChange={(value: Array<'生效' | '已撤下'>) => successionStore.patchStatusFilter(value)}
          options={[
            { label: '生效', value: '生效' },
            { label: '已撤下', value: '已撤下' }
          ]}
        />
        <Button type="link" onClick={() => { setKeyword(''); setDamId(''); successionStore.resetFilter() }}>
          重置
        </Button>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            接替关系清单（{rows.length}）
          </h3>
          <span className="muted">撤下关系后计算恢复；已闭环处置记录始终保留在原测点</span>
        </div>
        {rows.length === 0 ? (
          <EmptyPanel
            title="还没有接替关系"
            description="旧测点损坏时，先布设同类型新测点，再登记接替关系；旧数据无需迁移，自动按单点链展示。"
            actionText="登记接替"
            onAction={() => openCreate()}
            compact
          />
        ) : (
          <Table<LinkRow> rowKey="id" size="small" bordered dataSource={rows} columns={columns} pagination={false} scroll={{ x: 1300 }} />
        )}
      </div>

      <Modal
        open={createOpen}
        title="登记测点接替"
        onCancel={() => setCreateOpen(false)}
        onOk={openImpact}
        confirmLoading={previewLoading}
        okText="下一步：检查影响"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={EMPTY_SUCCESSION_DRAFT}>
          <Form.Item name="predecessorId" label="旧测点（损坏点，原始观测继续保留）" rules={[{ required: true, message: '请选择旧测点' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={predecessorOptions}
              placeholder="选择被接替的旧测点"
              onChange={() => form.setFieldsValue({ successorId: '' })}
            />
          </Form.Item>
          <Form.Item name="successorId" label="新测点（同类型，自接替日起接续观测）" rules={[{ required: true, message: '请选择新测点' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={successorOptions}
              placeholder={selectedPredecessor ? `选择接替「${selectedPredecessor.code}」的新测点` : '请先选择旧测点'}
              notFoundContent={selectedPredecessor ? '没有同类型且未在其他链上的新测点，请先到测点配置布设' : undefined}
            />
          </Form.Item>
          <Form.Item name="effectiveDate" label="接替生效日" rules={[{ required: true, message: '请填写接替生效日' }]}>
            <Input placeholder="YYYY-MM-DD，新点自该日起的读数进入接续链" />
          </Form.Item>
          <Form.Item name="note" label="损坏 / 换桩说明">
            <Input.TextArea rows={2} placeholder="如 原测点被落石击损，桩位旁 0.5 m 重新埋设" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={impactOpen}
        title="接替生效前影响确认"
        onCancel={() => {
          setImpactOpen(false)
          setCreateOpen(true)
        }}
        onOk={confirmApply}
        confirmLoading={submitting}
        okText="确认生效"
        cancelText="返回修改"
        okButtonProps={{ danger: false }}
        width={620}
      >
        {impact ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions size="small" bordered column={1}>
              <Descriptions.Item label="接续链">
                <strong>{impact.predecessor.code}</strong>（{impact.predecessor.type}）→{' '}
                <strong style={{ color: '#1f5c99' }}>{impact.successor.code}</strong>
              </Descriptions.Item>
              <Descriptions.Item label="接替日">{impact.draft.effectiveDate}</Descriptions.Item>
              <Descriptions.Item label="继承方式">
                {impact.inheritMode === 'immediate' ? (
                  <Tag color="blue">
                    立即继承旧点累计量 {impact.inheritedCumulative !== null ? impact.inheritedCumulative.toFixed(3) : '0.000'}{' '}
                    {impact.successor.unit}（基准 {impact.basisObservationDate ?? '—'}）
                  </Tag>
                ) : (
                  <Tag color="gold">
                    首读扣减：新点暂无接替后读数；
                    {impact.inheritedCumulative !== null
                      ? `将继承旧点累计量 ${impact.inheritedCumulative.toFixed(3)} ${impact.successor.unit}（基准 ${impact.basisObservationDate ?? '—'}），`
                      : ''}
                    录入第一条 ≥ 接替日读数时完成扣减与接档
                  </Tag>
                )}
              </Descriptions.Item>
            </Descriptions>
            <Alert
              type="info"
              showIcon
              message={`旧点 ${impact.predecessor.code} 的 ${impact.retainedObservationCount} 条原始观测原样保留，不做迁移或改写`}
            />
            {impact.recalculatedObservationCount > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={`新点已有 ${impact.recalculatedObservationCount} 条 ≥ 接替日观测，生效后将按连续口径重算累计量与第一档日速率`}
              />
            ) : (
              <Alert type="success" showIcon message="新点暂无接替后观测，首读数录入时自动完成继承与接档" />
            )}
            <Alert
              type={impact.openAlarmCount > 0 ? 'warning' : 'success'}
              showIcon
              message={
                impact.openAlarmCount > 0
                  ? `旧点有 ${impact.openAlarmCount} 张未闭环预警，继续挂在旧点，不会自动改挂到新点`
                  : '旧点无未闭环预警；接替后触发的新预警归属新测点'
              }
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              写入前已建立检查点，写入失败可整体恢复；撤下关系后新点计算与预警归属恢复，已闭环处置记录照旧。
            </Typography.Text>
          </Space>
        ) : null}
      </Modal>

      <Drawer
        open={drawerLinkId !== null}
        width={680}
        title={drawerLink ? `连续观测序列 · ${drawerLink.predecessorId} → ${drawerLink.successorId}` : '连续序列'}
        onClose={() => setDrawerLinkId(null)}
      >
        {drawerLink ? (
          <>
            <Descriptions size="small" bordered column={2} style={{ marginBottom: 14 }}>
              <Descriptions.Item label="接替日">{drawerLink.effectiveDate}</Descriptions.Item>
              <Descriptions.Item label="状态">{drawerLink.status}</Descriptions.Item>
              <Descriptions.Item label="继承累计量" span={2}>
                {drawerLink.inheritedCumulative !== null
                  ? `${drawerLink.inheritedCumulative.toFixed(3)}（基准 ${drawerLink.basisObservationDate ?? '—'}）`
                  : '待首读继承'}
              </Descriptions.Item>
              <Descriptions.Item label="说明" span={2}>
                {drawerLink.note || '—'}
              </Descriptions.Item>
            </Descriptions>
            <Table
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
                    <Tag color={record.pointId === drawerLink.predecessorId ? 'default' : 'blue'}>
                      {pointById.get(record.pointId)?.code ?? record.pointId}
                    </Tag>
                  )
                },
                { title: '读数', dataIndex: 'reading', width: 90, render: (value: number) => value.toFixed(3) },
                { title: '连续累计', dataIndex: 'cumulative', width: 100, render: (value: number) => value.toFixed(3) },
                {
                  title: '日速率',
                  dataIndex: 'dailyRate',
                  width: 100,
                  render: (value: number) => <span style={{ color: '#1f5c99' }}>{value.toFixed(4)}</span>
                },
                {
                  title: '接档',
                  width: 80,
                  render: (_value, record) => (record.acrossLink ? <Tag color="blue">跨接替</Tag> : '—')
                },
                { title: '观测人', dataIndex: 'observer', width: 90 }
              ]}
            />
            <Timeline
              style={{ marginTop: 16 }}
              items={[
                { color: 'gray', children: `旧点 ${pointById.get(drawerLink.predecessorId)?.code ?? ''} 观测保留至 ${drawerLink.effectiveDate} 前` },
                { color: 'blue', children: `接替日 ${drawerLink.effectiveDate} 起由 ${pointById.get(drawerLink.successorId)?.code ?? ''} 接续` },
                {
                  color: 'green',
                  children: drawerLink.status === '生效' ? '关系生效中，趋势与处置页按本链连续展示' : '关系已撤下，两测点恢复为各自独立序列'
                }
              ]}
            />
          </>
        ) : (
          <EmptyPanel title="未选择接替关系" compact />
        )}
      </Drawer>
    </div>
  )
}
