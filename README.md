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
│       ├── components/import/  离线包上传与分歧核对
│       ├── hooks/              筛选与单位换算
│       ├── pages/              六个业务页面
│       ├── router/             路由表
│       ├── stores/             Zustand 状态与持久化动作
│       ├── types/              四类业务模型与离线包契约
│       └── utils/              Stripe 计算、Dexie、JSON 导出与离线包合并服务
└── README.md
```

## 数据存储说明

数据存储使用 IndexedDB，Dexie 数据库名为 `gbpapermill-db`。

- `version(1)`：建立 `moulds`、`fiberBatches`、`sheetRuns`、`paperSamples` 四张表及编号、日期、状态等索引。
- `version(2)`：为四张表加入 `schemaRev` 索引，并通过 `upgrade` 将存量记录回填为版本 `2`。
- `version(3)`：加入 `importBatches`、`importStaging` 两张离线包合并表，并通过 `upgrade` 将四张业务表的存量记录回填为版本 `3`（旧数据第一次打开新版时自动回填）。
- 数据库首次创建时通过 `populate` 写入 5 张纸帘、5 个纤维料批、8 槽抄纸工序和 6 个成纸样本。
- 页面顶部的“导出 JSON”可下载四张业务表（合并后的台账结果）以及离线包批次与暂存进度的完整备份。

## 离线包合并（`/imports`）

作坊带回的离线包为 JSON 文件，根节点需声明 `"format": "gbpapermill-offline-pack/1"`，按 `moulds`、`fiberBatches`、`sheetRuns`、`paperSamples` 四个数组组织。

合并规则：

1. **只认业务编号**：工序以 `mouldNo`、`batchNo` 指向纸帘与料批，样本以 `runNo` 指向工序；包内即使带本机数字编号也不会用于挂接。
2. **分歧先留双方**：同一业务编号两边字段不一致时标记“有分歧”，并排列出本机值与离线包值，支持整侧选择或逐字段混选；未选定前不写入，密度与偏差在写入时按选中值重算。
3. **下游跟随选中上游**：写入顺序为纸帘 → 料批 → 工序 → 样本，工序/样本按业务编号现查本机 id 重新挂接；上游既不在包内也不在本机台账时，记录暂存待处理（不建档），上游经后续包补齐后重试即可挂接。
4. **失败保留进度**：每条记录独立事务提交，中途失败只回滚该条；批次与已写入进度保留，重试同一包按内容哈希识别、跳过已写入记录，不重复建档。
5. **旧数据回填版本**：v1/v2 老库首次由新版打开时逐级升级并回填 `schemaRev = 3`，现有台账页面与 JSON 导出均展示合并结果。

## 核心功能与路由表

| 路由 | 页面标题 | 核心功能 |
| --- | --- | --- |
| `/` | 工作台 | 查看纸帘状态分布、本周工序数、待复检样本与标准工序路径 |
| `/moulds` | 纸帘台帐 | 筛选纸帘，登记新纸帘，实时推算网目密度并登记修补 |
| `/fibers` | 纤维料批台账 | 按原料和打浆度筛选、比较，展开查看关联抄纸工序 |
| `/runs` | 抄纸工序记录台 | 按日期和帘号筛选，登记工序并即时判断 ±0.2 mm 帘纹偏差 |
| `/samples` | 成纸样本与透光检验卡 | 按匀度与帘纹条数分档，查看透光帘纹预览和归档位置 |
| `/imports` | 离线包合并 | 读入作坊离线包，核对双方分歧、按业务编号重新挂接并分批写入 |

未匹配的地址会回到工作台。

### 离线包示例

```json
{
  "format": "gbpapermill-offline-pack/1",
  "source": "第二作坊",
  "packedAt": "2026-09-30",
  "moulds": [
    { "mouldNo": "DL-01", "frameW": 60, "frameH": 90, "wireMaterial": "竹丝", "wireDiameter": 0.28, "stripeGap": 1.1, "weaver": "周守良", "state": "在用" }
  ],
  "fiberBatches": [
    { "batchNo": "XW-2699", "material": "竹麻", "origin": "四川夹江", "cookAgent": "石灰", "cookHours": 10, "bleachMethod": "日晒", "beatingDegree": 30, "operator": "罗青禾" }
  ],
  "sheetRuns": [
    { "runNo": "CB-9001", "mouldNo": "DL-01", "batchNo": "XW-2699", "runDate": "2026-09-28", "operator": "罗青禾", "stripeDirection": "竖帘纹", "dipCount": 2, "stackHeight": 40, "dryMethod": "火墙", "grammage": 30, "measuredGap": 1.08 }
  ],
  "paperSamples": [
    { "sampleNo": "YZ-91", "runNo": "CB-9001", "sizeMm": 210, "stripeCount": 46, "evenness": "均匀", "archiveBin": "甲柜-03" }
  ]
}
```

字段缺失或取值不合法的记录会在校验阶段跳过并列出原因，不影响其余记录合并。
