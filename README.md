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
        ├── hooks/              # useAlarmLevel.ts useIdbTable.ts usePointChain.ts
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
| `/points` | 测点布设与阈值配置 | Point、Section | 按断面批量布点；逐点改写初值与阈值（草稿 → 逐条/批量提交）；显示最新累计变化与接续关系 |
| `/successions` | 测点接替管理 | Succession、Point、Observation、Alarm | 登记旧点→新点独立接替关系；生效前列出受影响观测与未闭环预警；首读继承旧点累计值；撤下关系、检查点恢复 |
| `/observations` | 位移/浸润线观测录入 | Observation、Point | 选定测点按日期录入读数（自动算累计量与日速率）；接替新点首读自动继承；实时预警级别预览；一键生成预警单 |
| `/trends` | 累计位移与沉降速率计算 | Observation、Point、Succession | 按接续链连续展示累计量与日速率、占阈值比排行；仅看越限；抽屉查看链上历次观测序列；生成预警单 |
| `/alarms` | 预警触发与处置闭环 | Alarm、Point、Observation、Succession | 按级别排序；归属测点显示接续链；旧预警不随接替改挂、新预警归新点；状态流转与闭环 |
| `/pool` | 干滩长度与库水位记录 | Pool、Dam | 按日登记水位/干滩/超高并自动校核；导出 CSV、导出结构版本、重置演示数据 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbtaildam`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`dams`、`sections`、`points`、`observations`、`alarms`、`pools`、`successions`
- **数据结构版本**：`DB_VERSION = 3`
  - `version(1)` → `version(2)`：补齐 `revision`、用所属断面回填测点 `damId`、用测点回填预警 `damId` 并补齐处置字段
  - `version(3)`：新增测点接替关系表 `successions`；旧数据无需回填——每个无关系测点在链计算中天然作为**单点链**处理（旧数据自动补成单点链）
- **测点接替模型**（`successions` 独立关系表，`src/types/succession.ts` + `src/utils/succession.ts`）：
  - 旧测点原始观测与历史预警原样保留、归属不变；新测点自接替日起接续
  - 新点首读数继承旧点累计量（扣减进新点初值），累计位移天然连续；旧点已有基准而新点无读数时，在首读录入时延迟继承
  - 跨接替日速率按「连续累计量之差 ÷ 间隔天数」计算（新旧仪器读数零位不同，不直接用读数差）
  - 旧预警不自动改挂，接替后新预警归属新测点；撤下关系后新点计算与归属恢复，已闭环处置记录照旧；只允许从链尾依次撤下
  - 生效/撤下写入前在 localStorage 留存检查点（`gbtaildam:succession-checkpoint`），写失败可整体恢复
- **首屏自动播种**：`initDatabase()` 中 `if (await db.dams.count() === 0) await seedDatabase()`，播种 2 座坝体 → 4 个断面 → 10 个测点 → 23 条观测 → 6 张预警 → 5 条库水位 → 1 条测点接替（DB-01 → DB-01R）的完整链条；播种幂等
- **localStorage 辅助键**：`gbtaildam:db-version`、`gbtaildam:last-backup-at`、`gbtaildam:ui-prefs`、`gbtaildam:succession-checkpoint`
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
- 接替新点初值 `= 首读数 − 旧点继承累计量`，故其原始累计变化量即沿接续链的连续累计量
- 跨接替关系的第一档日速率 `= |新点首读连续累计 − 旧点基准连续累计| ÷ 间隔天数`（读数零位不同，不用原始读数差）
- 比值 `= |累计变化量| ÷ 阈值`；分级：`≥0.70` 蓝、`≥0.85` 黄、`≥1.00` 橙、`≥1.30` 红
- 干滩长度达标下限 `100 m`，安全超高达标下限 `1.5 m`
