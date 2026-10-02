# 手工造纸帘纹与工序档案

围绕手工造纸的纸帘、纤维料批、抄纸工序与成纸样本建立一体化档案。界面可登记纸帘丝径与帘纹间距、推算网目密度，跟踪料批打浆度，复测抄纸帘纹偏差，并按匀度与帘纹条数复核样本。所有业务数据保存在浏览器 IndexedDB 中，无需后端服务。

## Docker 一键启动

```bash
cp .env.example .env && docker compose up -d --build
```

默认映射端口为 `21807`。启动后访问 `http://localhost:21807`。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端框架 | React 18 + TypeScript 5 |
| 构建工具 | Vite 5 |
| 界面组件 | MUI 5 + Emotion |
| 路由 | React Router 6 |
| 状态管理 | Zustand 4 |
| 本地数据库 | Dexie 4 + IndexedDB |
| 部署 | Nginx + Docker Compose |

## 访问地址

`http://localhost:21807`

## 本地开发方式

```bash
cd frontend
npm install
npm run dev
```

本地开发服务器默认运行在 `http://localhost:5173`。

## 目录结构

```text
.
├── docker-compose.yml
├── .env.example
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── package.json
│   └── src/
│       ├── components/common/  公共可视化组件
│       ├── hooks/              筛选与单位换算
│       ├── pages/              六个业务页面
│       ├── router/             路由表
│       ├── stores/             Zustand 状态与持久化动作
│       ├── types/              业务模型与离线包合并模型
│       └── utils/              Stripe 计算、Dexie、离线包解析与 JSON 导出
└── README.md
```

## 数据存储说明

数据存储使用 IndexedDB，Dexie 数据库名为 `gbpapermill-db`。

- `version(1)`：建立 `moulds`、`fiberBatches`、`sheetRuns`、`paperSamples` 四张表及编号、日期、状态等索引。
- `version(2)`：为四张表加入 `schemaRev` 索引，并通过 `upgrade` 将存量记录回填为版本 `2`。
- `version(3)`：新增 `importBatches`（导入批次与进度）、`mergeConflicts`（同号分歧留底）、`pendingLinks`（缺上游暂存）三张表，支撑离线包合并。
- 数据库首次创建时通过 `populate` 写入 5 张纸帘、5 个纤维料批、8 槽抄纸工序和 6 个成纸样本。
- 页面顶部的“导出 JSON”可下载四张业务表与导入批次的完整备份，合并结果一并包含。

## 离线包合并说明

作坊带回的离线包（JSON）在“离线包合并”页导入，规则如下：

- 包内以纸帘、料批、工序、样本的业务编号（`mouldNo` / `batchNo` / `runNo` / `sampleNo`）认关系；源机的数字 `id` 一律丢弃，不与本机编号硬套。
- 同一业务编号两边值有分歧时，本机与包内各留一份（`mergeConflicts`），选定一侧后才写入台账。
- 抄纸工序与成纸样本跟着选中的上游重新挂接；上游缺失或仍待选定时，先暂存（`pendingLinks`），上游就位后可重新挂接。
- 整包按 `packageId` 幂等：写入失败后批次与进度保留在 `importBatches`，重试同一包按业务编号去重，不重复建档。
- 旧包中缺 `schemaRev` 的记录，第一次导入时回填为当前版本；各台账页与导出 JSON 即时反映合并结果。

## 核心功能与路由表

| 路由 | 页面标题 | 核心功能 |
| --- | --- | --- |
| `/` | 工作台 | 查看纸帘状态分布、本周工序数、待复检样本与标准工序路径 |
| `/moulds` | 纸帘台帐 | 筛选纸帘，登记新纸帘，实时推算网目密度并登记修补 |
| `/fibers` | 纤维料批台账 | 按原料和打浆度筛选、比较，展开查看关联抄纸工序 |
| `/runs` | 抄纸工序记录台 | 按日期和帘号筛选，登记工序并即时判断 ±0.2 mm 帘纹偏差 |
| `/samples` | 成纸样本与透光检验卡 | 按匀度与帘纹条数分档，查看透光帘纹预览和归档位置 |
| `/imports` | 离线包合并 | 导入离线包、选定同号分歧、重新挂接暂存记录、失败重试 |

未匹配的地址会回到工作台。
