# 11 · 原生化收敛与 R0–R5 垂直迁移计划

[返回总览](../demo.md) · [ADR 012](../docs/adr/0012-native-ave-architecture.md) · [总体架构](02-architecture.md) · [接口契约](06-interfaces.md) · [风险与 ADR](09-risks-research.md)

> 状态：**实施基线（ADR 012，2026-11-27）**。本文记录基于仓库源码实测的耦合盘点、存储拆分与 R0–R5 垂直迁移路径。迁移期内原生目录与 `downstream/paseo/` 在根目录并存，各阶段按实际可运行验收门逐一推进。

## 1. 现状耦合盘点（基于仓库实测）

对 `downstream/paseo/` 的全量扫描表明，AVE 的核心价值（契约、EditGraph、审批、幂等恢复、对象编辑状态机、FFmpeg/Python 媒体流水线与前端编辑台逻辑）已经独立成型，宿主与第三方框架耦合高度收敛：

### 1.1 Paseo 宿主耦合点

| 类别 | 实测文件 | 耦合内容 | 迁移去向 |
| --- | --- | --- | --- |
| 宿主接入（非 `video/`） | [bootstrap.ts](../downstream/paseo/packages/server/src/server/bootstrap.ts) | 创建/启停 `EditorService({ paseoHome })` | `services/daemon` 独立入口 |
| 宿主接入（非 `video/`） | [session.ts](../downstream/paseo/packages/server/src/server/session.ts)、[websocket-server.ts](../downstream/paseo/packages/server/src/server/websocket-server.ts) | 绑定 `EditorPrincipal`、隔离设备 WS 通道 | `packages/protocol` + `services/daemon` WS 网关 |
| 宿主接入（非 `video/`） | [session-admission-auth.ts](../downstream/paseo/packages/server/src/server/session-admission-auth.ts)、[operation-permissions.ts](../downstream/paseo/packages/server/src/server/authorization/operation-permissions.ts) | `videoDevice` 准入与 `video.*` 操作权限映射 | `services/daemon` 鉴权中间件 |
| 宿主接入（非 `video/`） | [builtin/index.ts](../downstream/paseo/packages/server/src/server/plugins/builtin/index.ts)、[messages.ts](../downstream/paseo/packages/protocol/src/messages.ts)、[daemon-client.ts](../downstream/paseo/packages/client/src/daemon-client.ts) | 内置插件注册、`videoDomainPermissions` 与客户端连接凭据 | 原生移除插件注册；协议/SDK 迁入 `packages/protocol`、`packages/client-sdk` |
| 服务端领域内引用 | [authorization.ts](../downstream/paseo/packages/server/src/server/video/authorization.ts) | 仅导入 `type DaemonPermission` 并判断 `daemon.manage` | 改为原生 owner/operator/viewer 主体模型 |
| 服务端目录选项 | [service.ts](../downstream/paseo/packages/server/src/server/video/service.ts) | 仅使用 `paseoHome` 作为数据根目录参数名 | 替换为 `AVE_HOME` / `dataDir` |
| 客户端插件壳 | [index.client.tsx](../downstream/paseo/plugins/video-editor/index.client.tsx)（18 行） | `PluginClientContext.addScreen` / `SidebarRow` | 替换为 `apps/web` 独立路由壳 |
| 客户端 UI 视图 | `downstream/paseo/plugins/video-editor/client/*.tsx`（8 个 TSX 文件） | 仅导入 `@getpaseo/plugin/client` 的 `{ useRpc, type PluginSurfaceProps }` 与 `react`/`react-native` | 注入 `packages/client-sdk` hooks，逐步替换为标准 React Web/Expo 视图 |
| 零 Paseo 客户端 TS | `cut.ts`、`import-source.ts`、`object-edit-view.ts`、`web.ts`、`review-bytes.ts`、`planning-events.ts` | 无任何 `@getpaseo/*` 导入 | 直接迁入 `packages/domain` / `packages/client-sdk` / `apps/web` |

### 1.2 Pi 耦合点

- **唯一生产耦合文件**：[agent/session.ts](../downstream/paseo/packages/server/src/server/video/agent/session.ts)（256 行），导入 `@earendil-works/pi-coding-agent` 的 `createAgentSession`、`createExtensionRuntime`、`ModelRuntime`、`SessionManager`、`SettingsManager`、`AgentSessionEvent`。
- **探针辅助文件**：[closed-session.mjs](../downstream/paseo/plugins/video-editor/worker/closed-session.mjs)（103 行）。
- **已原生化周边模块**：[controller.ts](../downstream/paseo/packages/server/src/server/video/agent/controller.ts)（247 行）、[ipc.ts](../downstream/paseo/packages/server/src/server/video/agent/ipc.ts)（184 行）、[worker-main.ts](../downstream/paseo/packages/server/src/server/video/agent/worker-main.ts)（117 行）、[prompt.ts](../downstream/paseo/packages/server/src/server/video/agent/prompt.ts)、[tool-broker.ts](../downstream/paseo/packages/server/src/server/video/tool-broker.ts)（242 行，17 个受控工具）均已由 AVE 自有实现，不依赖 Pi 源码。

### 1.3 FilmCraft 耦合点

- `downstream/paseo/` 生产代码中 **0 处**导入 FilmCraft。
- 仅在 [research/upstream.json](../research/upstream.json)、[check_filmcraft_pin.py](../scripts/check_filmcraft_pin.py)、[check_filmcraft_e13.py](../scripts/check_filmcraft_e13.py) 及设计文档中作为实验性候选后端保留。原生首版以 FFmpeg 为唯一确定性后端，保留可选 `DeterministicBackend` 接口即可。

### 1.4 领域、存储、媒体与 Python Worker 资产盘点

- **契约与字节帧**：[v1.ts](../downstream/paseo/plugins/video-editor/shared/contracts/v1.ts)（1,650 行）、[v1.schema.json](../downstream/paseo/plugins/video-editor/shared/contracts/v1.schema.json)（8,749 行）、[bytes.ts](../downstream/paseo/plugins/video-editor/shared/bytes.ts)（41 行）、[fixtures.json](../downstream/paseo/plugins/video-editor/test/fixtures.json)（198 条）。
- **存储层**：[store.ts](../downstream/paseo/packages/server/src/server/video/store.ts)（3,009 行，单类 `EditorStore`，包含 23 张 SQLite 表与约 87 个方法）+ [access.ts](../downstream/paseo/packages/server/src/server/video/access.ts)（168 行，当前读写 `access.json`）。
- **RPC 表面**：[rpc.ts](../downstream/paseo/packages/server/src/server/video/rpc.ts)（605 行，共 63 个去重 `video.v1.*` 主路由，其中 `video.v1.import_asset` 为禁用桩；另有 `video.v1.configure_worker` 归入权限表）。
- **媒体与对象编辑**：[media.ts](../downstream/paseo/packages/server/src/server/video/media.ts)（1,837 行）、[cas.ts](../downstream/paseo/packages/server/src/server/video/cas.ts)（207 行）、[jobs.ts](../downstream/paseo/packages/server/src/server/video/jobs.ts)（143 行）、[object-edit.ts](../downstream/paseo/packages/server/src/server/video/object-edit.ts)（130 行）及相关检测/锚点/窗口/QA/模型网关模块。
- **Python Worker（11 个脚本）与第三方依赖策略**：
  - 核心运行依赖包含 `numpy`、`Pillow`、`opencv-python`、`onnxruntime`、`scenedetect`（BSD-3-Clause，仅 [shot_index.py](../downstream/paseo/plugins/video-editor/worker/shot_index.py) 使用）、`torch`、`transformers`、`diffusers`、`sam2`。
  - 按 ADR 012 决策，保留通用第三方库依赖，仅剥离 Paseo/Pi/FilmCraft 宿主源码与框架包。

### 1.5 仓库与本地工作流耦合点

- 本地存在未跟踪可运行工作区 `vendor/paseo/`（分支 `k/video-editor`，含未提交修改），R0–R4 禁止触碰或覆盖。
- 根仓库校验 [check_project.py](../scripts/check_project.py) 与分工统计 [update_division.py](../scripts/update_division.py) 在 R0–R4 保持对现有基线兼容，并在 R5 统一切换至原生目录与文档。

---

## 2. 目标原生架构与存储拆分

### 2.1 目录布局与依赖方向

```text
apps/
  desktop/             Electron 主进程、preload、安装与更新
  web/                 桌面编辑器 UI（React）
  mobile/              Android 远程监督端（Expo）
packages/
  contracts/           AVE wire schema、fixtures、版本兼容规则
  domain/              有理数时间、EditGraph、Plan、Approval、对象编辑状态机
  client-sdk/          类型化 RPC、重连、events(afterSeq) 补拉、get_mutation_result 对账
  protocol/            WebSocket 消息信封、二进制分块 framing、错误码
services/
  daemon/              唯一项目事实源、事务协调、授权中间件、任务调度、方法注册表
  planner-worker/      模型对话与受控工具循环，不接触数据库和媒体路径
  media-worker/        FFmpeg、Python 检测/分割/生成/QA，仅收 lease、BlobRef 与参数
  relay/               可选远程密文转发（不进入首版本地闭环）
storage/
  sqlite/              单 SQLite WAL 数据库、事务协调器、5 Repositories 与 outbox
  cas/                 源素材、代理、掩码、产物的 CAS 存储与校验
```

依赖方向固定：`apps/* -> packages/client-sdk -> packages/protocol + packages/contracts`；`services/daemon -> packages/domain + packages/protocol + packages/contracts + storage/*`；`services/planner-worker -> packages/contracts`；`services/media-worker -> packages/contracts`（受控参数与 lease）。根 workspace 配置必须排除 `downstream/`、`vendor/`、`paseo/`、`pi/`、`filmcraft/`、`references/`。

### 2.2 `store.ts` 拆分为五个 Repository（单库单事务协调器）

将原 `store.ts`（23 张表）与 `access.ts`（`access.json`）在**同一个 SQLite WAL 数据库与统一 `TransactionCoordinator`** 下拆分为五个职责清晰的 Repository，禁止拆成多个各写各的数据库：

| Repository | 负责的 SQLite 表（含迁移表） | 核心职责 |
| --- | --- | --- |
| `ProjectAssetRevisionRepository` | `projects`, `assets`, `constant_rate_streams`, `preview_sheets`, `contact_sheets`, `uploads`, `upload_receipts`, `upload_chunks`, `project_settings` | 项目创建/读取、不可变源资产登记、upload 分块收据与提交、revision 推进 |
| `PlanApprovalRepository` | `plans`, `approvals`, `mutations`, `model_policies` | 计划创建/哈希绑定、审批决策/撤销/过期校验、`requestId + expectedRevision` 幂等与 `get_mutation_result` |
| `JobOutboxRepository` | `jobs`, `artifacts`, `events`, `outbox`, `metadata` | Job 生命周期与 lease/恢复、产物登记、持久事件递增 `seq` 与 outbox 投递 |
| `ObjectEditRepository` | `object_edits`, `mask_tracking_jobs`, `tracked_mask_reviews`, `mask_anchors` | 对象编辑六态状态机、候选/决策/mask 审批/QA 与换素材失效校验 |
| `DeviceGrantRepository` | `project_grants`, `devices`（新增，迁移 `access.json`）, `invitations`（新增，迁移 `access.json`） | 设备配对、一次性邀请兑换、吊销与项目级角色授权 |

### 2.3 必须原样守住的领域不变量

1. **有理数时间与半开区间**：禁止浮点秒进入契约与 EditGraph 运算。
2. **不可变源资产**：`sourceNeverWritable: true`，原始素材只进 CAS 并以 SHA-256 寻址，不原地覆写。
3. **写幂等与乐观并发**：所有写操作绑定 `requestId + expectedRevision`；响应丢失后可通过 `get_mutation_result` 对账。
4. **哈希绑定与审批失效**：Plan/Mask/QA/Grant 绑定精确 `planHash`/`subjectHash`/`baseTimelineRevision`；修订推进或源素材变更后旧审批与对象决策自动失效。
5. **六态对象编辑状态机**：`analyzing -> awaiting_target_selection -> awaiting_mask_review -> awaiting_generation_review -> completed | failed`，且“全部保留（无 remove 目标）”允许直接进入 `completed`，禁止未审 mask 触发生成。
6. **持久恢复**：`snapshot + events(afterSeq) + outbox` 断线补拉与进程重启恢复；`agent_settled` 绝不等于 Job 完成。
7. **受控执行边界**：所有媒体进程使用参数数组与 `shell: false`，先写 staging 再原子提交 CAS。

---

## 3. 推荐垂直迁移顺序（R0–R5）

### R0 · 冻结行为基线
- **目标**：在不改动现有代码行为的前提下，冻结可被旧版与原生版共同检验的规范与样本。
- **交付物**：`conformance/r0-baseline/`（`fixtures.json`、`baseline-spec.json`、`generate_golden_media.py`、`verify_r0_baseline.py`、`README.md`），覆盖 198 条契约 fixture、63 个 `video.v1.*` RPC 方法、权限矩阵、17 个 Planner tool、24 个错误码、对象编辑六态机、故障恢复矩阵与 4 个黄金合成媒体样本（25/30fps CFR、VFR、多音轨+字幕 MKV）。
- **明确不做**：不新建产品源码，不修改 `downstream/paseo/`。
- **验收门**：`verify_r0_baseline.py` 全量比对通过并实际生成/probe/完整解码 4 个黄金样本；`check_project.py` 通过。

### R1 · 原生领域内核
- **目标**：建立不引用任何 Paseo/Pi 包的原生 `packages/contracts`、`packages/domain`、`storage/sqlite`、`storage/cas`。
- **关键改动**：初始化根 workspace（隔离 `downstream/` 等目录）；原样迁移 `v1.ts`/schema/bytes；实现有理数时间、`EditGraph` 校验、Plan 哈希与 Timeline 估算、6 态 ObjectEdit FSM；实现单库单事务协调器下的 5 个 Repository（含 `devices`/`invitations` 入库）与 `ContentAddressedStore`。
- **明确不做**：不做 WebSocket 服务器、Electron 壳、Planner 模型对接或 Python 推理。
- **验收门**：原生单元测试覆盖全部 198 条 R0 fixture、`requestId` 幂等、`REVISION_CONFLICT`、审批哈希绑定/过期/撤销、ObjectEdit 六态流转与换素材失效、CAS 校验/上传提交、中断 Job/Outbox 恢复；零 Paseo/Pi 依赖检查通过。

### R2 · 本地桌面确定性闭环
- **目标**：不依赖 Pi 和远程 relay，跑通原生桌面端导入、裁切、审批、预览、导出、QA 与崩溃恢复闭环。
- **关键改动**：实现 `packages/protocol`（WS 信封、分块 framing、错误码）、`packages/client-sdk`（typed RPC、重连、事件补拉、`get_mutation_result`）、`services/daemon`（方法注册表、Zod 入参校验、主体授权中间件、FFmpeg 确定性执行器与可选 `DeterministicBackend` 接口）、`apps/web`（迁入并去 Paseo 化现有桌面编辑器）、`apps/desktop`（Electron main/preload，`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`）。
- **明确不做**：不接入真实大模型 Planner，不做 SAM2/VACE 生成，不做 Android 与 `relay`。
- **验收门**：用 R0 黄金媒体在独立 `AVE_HOME` 启动原生 daemon + Web/Electron，端到端实测导入 → 裁切方案 → 人工审批 → 预览 → 最终导出 → `ffprobe` + 完整解码 QA + 源 SHA-256 不变 + kill/重启恢复。

### R3 · 原生 Planner
- **目标**：彻底替换 `agent/session.ts` 中的 `@earendil-works/pi-coding-agent`，跑通受控原生规划闭环。
- **关键改动**：实现 `services/planner-worker`（保持 stdio JSONL IPC 边界）：`startRun -> 构建有界快照 -> 单 Provider 严格 JSON Schema 模型请求 -> 校验工具调用 -> daemon 执行 17 个 inspect/query/propose 工具 -> 继续轮次或 submit_edit_plan 终止 -> 持久化 Run 状态与事件`，支持 `steer`/`followUp`/`abort`、有界上下文与 canonical snapshot 重注入。
- **明确不做**：不做多 Provider 全矩阵、MCP、插件扩展系统或复杂压缩引擎。
- **验收门**：确定性录制模型（及可选真实 Provider）端到端通过“自然语言 → EditPlan → 人工审批 → 创建 Job”，并通过封闭性负向测试（模型调用 `bash`/写文件/审批/跨项目访问均被拦截）。

### R4 · 对象编辑与生成闭环
- **目标**：将 Python 媒体/视觉 Worker 迁入 `services/media-worker`，打通人物候选、决策、mask 审批、生成闸门、长段窗口与 QA。
- **关键改动**：迁移 `plugins/video-editor/worker/*.py` 契约与内核，通过模型网关和 Worker profile（`shell: false`、staging）接入；不进入 daemon 进程；未安装 GPU/模型权重时明确报告 `CAPABILITY_UNAVAILABLE`。
- **明确不做**：不做未经基准验收的权重自动下载或默认启用。
- **验收门**：Python 内核契约与采样映射测试通过；使用确定性测试替身/录制响应打通 daemon ↔ media-worker ↔ UI 对象编辑全流程；真实 SAM2/VACE 依赖本机模型可用性做独立端到端验收或明确标记未验证项。

### R5 · Android、数据迁移与切换
- **目标**：完成移动端远程监督端、旧库迁移工具与仓库主线切换。
- **关键改动**：实现 `apps/mobile`（Expo，共享 `contracts` + `client-sdk` + 权限/轻量视图模型，聚焦预览/审批/取消/下载，优先认证直连；`services/relay` 视联调结果决定是否作为可选包实现）；实现旧 Paseo `video-editor` 数据库与 CAS 的版本化导出清单与原生导入校验工具；打 `legacy/paseo-based` 归档分支/tag；删除 `downstream/paseo/` 与旧构建脚本，同步更新 `demo.md`、`demo/01..09`、`AGENTS.md`、`scripts/check_project.py`、`research/upstream.json`、`ARCHITECTURE.svg`、`DIVISION.svg`。
- **验收门**：迁移工具跨库导出→导入一致性校验通过；`apps/mobile` 构建/契约/直连监督测试通过（真机未连接时明确标为未验证）；全仓零 Paseo/Pi/FilmCraft 源码与依赖，所有校验脚本与测试集全绿。

---

## 4. 关键风险与迁移护栏

1. **双库隔离硬约束**：原生 daemon 必须使用 `AVE_HOME`（默认 `~/.ave`），测试使用临时目录，绝对禁止与旧 `paseoHome/video-editor` 共用 SQLite 或 CAS 目录。
2. **保护本地未提交工作区**：迁移期间不修改 `vendor/paseo/`、`pi/`、`paseo/`、`filmcraft/`、`references/`。
3. **验证诚实原则**：任何未实际运行的平台安装包、真机或缺失 GPU 权重的模型推理，在每阶段与最终交付报告中明确列为未验证，不用模拟测试冒充真实媒体或真机验收。
