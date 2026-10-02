# 尾矿库坝体位移与浸润线监测台（sologsb101-1007）

面向尾矿库安全监测与库区安全管理岗位，按坝体断面布设表面位移、测斜、浸润线与渗压测点，逐次录入观测值并对超阈值测点触发预警与处置跟踪。核心动作：建坝与断面、布测点配阈值、录观测值、算累计位移与日速率、触发预警闭环、记录库水位与干滩长度。

> 纯前端单页应用（SPA）：**无后端 / 无数据库服务 / 无 API**，全部数据保存在浏览器本地 IndexedDB。

## 一、Docker 一键启动（推荐）

在项目根目录（本 README 所在目录）执行：

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22807**

常用运维命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并删除容器
docker compose up -d --build      # 改代码后重新构建启动
```

如需更换宿主端口，修改 `.env` 中的 `FRONTEND_PORT` 后重新 `docker compose up -d`。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3 | 函数组件 + Hooks |
| 语言 | TypeScript 5.7 | `strict` 严格模式，构建前执行 `tsc --noEmit` |
| UI 组件 | Ant Design 5 | 表格、表单、Modal、Drawer、Tag、Descriptions |
| 状态管理 | Zustand 4.5 | `damStore` / `pointStore` / `alarmStore` / `successionStore`（模块级 liveQuery 订阅回流） |
| 路由 | React Router 6.28 | `createBrowserRouter`，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种 |
| 构建 | Vite 6 | 输出 `dist/`，按路由自动分包 |
| 运行 | nginx:alpine | 静态托管 + gzip + SPA 回退 |

## 三、目录结构

```
sologsb101-1007/
├── README.md
├── docker-compose.yml          # 不写 version；顶层 name: gbtaildam
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/              # dam.ts section.ts point.ts observation.ts alarm.ts pool.ts succession.ts
        ├── stores/             # damStore.ts pointStore.ts alarmStore.ts successionStore.ts
        ├── components/common/  # AlarmTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # useAlarmLevel.ts useIdbTable.ts usePointChains.ts
        ├── pages/              # DamList.tsx PointConfig.tsx SuccessionBoard.tsx ObservationEntry.tsx TrendBoard.tsx AlarmBoard.tsx PoolLog.tsx
        ├── router/index.tsx
        ├── utils/              # threshold.ts succession.ts db.ts export.ts
        ├── styles/main.css
        ├── App.tsx
        └── main.tsx
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/dams` | 坝体与断面台账 | Dam、Section | 新建/编辑/删除坝体与断面；按坝型、等别筛选；卡片回显测点数与未闭环预警数 |
| `/points` | 测点布设与阈值配置 | Point、Section | 按断面批量布点；逐点改写初值与阈值（草稿 → 逐条/批量提交）；显示最新累计变化与占阈值比；发起测点接替 |
| `/successions` | 测点接替关系 | Succession、Point、Observation、Alarm、Checkpoint | 建立/撤下接替：旧点保留原始观测、新点按接替日首读数继承累计；生效前列出受影响观测与未闭环预警；写前检查点可恢复；接续链总览 |
| `/observations` | 位移/浸润线观测录入 | Observation、Point | 选定测点按日期录入读数（自动算累计量与日速率）；沿接续链连续展示历史；旧点停测只读；实时预警级别预览；一键生成预警单 |
| `/trends` | 累计位移与沉降速率计算 | Observation、Point、Succession | 按接续链（链头去重）占阈值比降序排行；仅看越限；抽屉查看链上历次观测序列与跨点衔接；按链尾最新观测生成预警单 |
| `/alarms` | 预警触发与处置闭环 | Alarm、Point、Observation、Succession | 按级别（红>橙>黄>蓝）排序；状态流转 待处置→处置中→已闭环；填写处置人与措施；旧预警保留旧点归属，新预警按在测新点归属 |
| `/pool` | 干滩长度与库水位记录 | Pool、Dam | 按日登记水位/干滩/超高并自动校核；导出 CSV、导出结构版本、重置演示数据 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbtaildam`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`dams`、`sections`、`points`、`observations`、`alarms`、`pools`、`successions`、`checkpoints`
- **数据结构版本**：`DB_VERSION = 3`，含 `version(1)→(2)→(3)` 迁移：v2 补齐 `revision`、回填测点/预警 `damId` 与处置字段；v3 新增测点接替关系表与写前检查点表。旧数据无需逐行迁移——没有接替关系的旧点在链派生时**自动补成单点链**
- **测点接替口径**：接替是独立关系（`successions`），旧点原始观测不改动、不停删；新点初值平移为「接替日首读数 − 旧点末次累计」，使首读数的连续累计恰好等于继承基线；链日速率以旧点末次观测为跨点前值。撤下关系时新点初值恢复原值并按点重算，已闭环处置记录照旧；旧预警不自动改挂，新预警按接替后测点归属，新点有未闭环预警时拒绝撤下
- **检查点恢复**：接替/撤下写库前先落 `checkpoints` 全表快照，写入失败或误操作可在接替页一键恢复；写入成功后自动清除。检查点是本机运行态，不随 JSON 备份导出，整库导入/重置时清空
- **首屏自动播种**：`initDatabase()` 中 `if (await db.dams.count() === 0) await seedDatabase()`，播种 2 座坝体 → 4 个断面 → 10 个测点（含接替点 DB-01A）→ 23 条观测 → 6 张预警 → 5 条库水位 → 1 条接替关系（DB-01 → DB-01A）的完整父子孙与接续链条；播种幂等
- **localStorage 辅助键**：`gbtaildam:db-version`、`gbtaildam:last-backup-at`、`gbtaildam:ui-prefs`
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22807
npm run build      # tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview    # 本地预览构建产物
```

## 七、判定口径

- 累计变化量 `= 读数 − 初值`；日速率 `= |本次读数 − 上次读数| ÷ 间隔天数`
- **接续链口径**：链头段同上；接替段新点初值已平移，链累计 `= 读数 − 平移后初值`（首读数恰为继承基线）；跨点衔接条目的日速率以旧点末次观测为前值。趋势/处置页统一按链展示，旧点原始观测仍按单点口径留痕保存
- 比值 `= |累计变化量| ÷ 阈值`；分级：`≥0.70` 蓝、`≥0.85` 黄、`≥1.00` 橙、`≥1.30` 红
- 干滩长度达标下限 `100 m`，安全超高达标下限 `1.5 m`
