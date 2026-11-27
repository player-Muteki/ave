# ADR 012: AVE 原生架构收敛与去宿主化策略

## 状态

Accepted（2026-11-27，按用户 `/goal` 指令进入 R0–R5 垂直迁移实施；R5 切换时同步归档旧实现并更新基线文档）。

## 背景

当前 Agentic Video Editor（AVE）的大部分视频领域能力已经自主实现在 [downstream/paseo](../../downstream/paseo/plugins/video-editor/shared/contracts/v1.ts) 中（领域、媒体、Agent、契约、Python Worker 与客户端共约 16,680 行），Paseo 与 Pi 主要承担通用宿主进程、连接鉴权、桌面/App 壳和模型会话包装。

对当前仓库的实测耦合盘点表明，去宿主化的边界已经非常集中：

1. **Paseo 宿主耦合**：仅集中在 8 个 `video/` 之外的宿主文件（[bootstrap.ts](../../downstream/paseo/packages/server/src/server/bootstrap.ts)、[session.ts](../../downstream/paseo/packages/server/src/server/session.ts)、[websocket-server.ts](../../downstream/paseo/packages/server/src/server/websocket-server.ts)、[session-admission-auth.ts](../../downstream/paseo/packages/server/src/server/session-admission-auth.ts)、[operation-permissions.ts](../../downstream/paseo/packages/server/src/server/authorization/operation-permissions.ts)、[builtin/index.ts](../../downstream/paseo/packages/server/src/server/plugins/builtin/index.ts)、[messages.ts](../../downstream/paseo/packages/protocol/src/messages.ts)、[daemon-client.ts](../../downstream/paseo/packages/client/src/daemon-client.ts)）；`server/video/` 内部只有 [authorization.ts](../../downstream/paseo/packages/server/src/server/video/authorization.ts) 引用 Paseo 类型 `DaemonPermission` 并检查 `daemon.manage`，[service.ts](../../downstream/paseo/packages/server/src/server/video/service.ts) 仅引用路径选项 `paseoHome`。
2. **客户端插件耦合**：`plugins/video-editor/client/` 下 8 个 TSX 视图仅从 `@getpaseo/plugin/client` 导入 `{ useRpc, type PluginSurfaceProps }`，[index.client.tsx](../../downstream/paseo/plugins/video-editor/index.client.tsx)（18 行）为唯一插件注册壳；其余 6 个纯 TS 客户端模块零 Paseo 依赖。
3. **Pi 耦合**：严格收敛在 1 个生产文件 [agent/session.ts](../../downstream/paseo/packages/server/src/server/video/agent/session.ts)（256 行，导入 `@earendil-works/pi-coding-agent`）和 1 个探针脚本 [closed-session.mjs](../../downstream/paseo/plugins/video-editor/worker/closed-session.mjs)；而 [controller.ts](../../downstream/paseo/packages/server/src/server/video/agent/controller.ts)、[ipc.ts](../../downstream/paseo/packages/server/src/server/video/agent/ipc.ts)、[worker-main.ts](../../downstream/paseo/packages/server/src/server/video/agent/worker-main.ts)、[tool-broker.ts](../../downstream/paseo/packages/server/src/server/video/tool-broker.ts) 已是 AVE 自有边界。
4. **FilmCraft**：在 `downstream/paseo/` 中有 0 处生产代码导入，仅以版本锁和 E13 对比脚本存在。

因此，AVE 不需要推翻视频编辑领域设计与契约，而应去掉通用宿主与外部 Agent 框架，收敛为独立原生产品。

## 决策

### 1. 目标架构：AVE 专用模块化单体 + 独立 Worker

采用以下根目录分层架构，首版不做通用插件系统、不做微服务拆分：

- `apps/desktop/`：Electron 主进程、preload（强制 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`）、打包与更新。
- `apps/web/`：React 桌面编辑器工作台 UI。
- `apps/mobile/`：Expo Android 远程监督端（聚焦预览、审批、取消与下载；不强行共享桌面时间线与精细掩码编辑）。
- `packages/contracts/`：AVE wire schema、fixtures 与版本兼容规则。
- `packages/domain/`：有理数时间模型、EditGraph、Plan、Approval、对象编辑六态状态机与核心校验逻辑。
- `packages/protocol/`：WebSocket 消息信封、二进制分块 framing 与错误码。
- `packages/client-sdk/`：类型化 RPC、断线重连、`snapshot + events(afterSeq)` 补拉与 `get_mutation_result` 对账。
- `services/daemon/`：唯一项目事实源、事务协调、权限中间件、任务调度、方法注册表与服务组装。
- `services/planner-worker/`：独立规划 Worker 进程，执行模型对话与受控工具循环，不接触数据库、CAS 与媒体路径。
- `services/media-worker/`：独立媒体与模型 Worker（FFmpeg、Python 检测/分割/生成/QA），仅接收 lease、`BlobRef` 与受控参数（`shell: false`、参数数组、staging 原子提交）。
- `services/relay/`：可选远程密文转发（不进入首版本地闭环）。
- `storage/sqlite/`：单 SQLite WAL 数据库 + 单事务协调器，将原 3,009 行 `store.ts` 拆为 5 个职责清晰的 Repository，并将原 `access.json` 迁入 SQLite。
- `storage/cas/`：源素材、代理、掩码与产物的内容寻址存储，严格校验 SHA-256 与 Revision pin。

### 2. 固定依赖方向

1. UI（`apps/*`）只允许调用 `packages/client-sdk`，禁止访问 SQLite、CAS 私有路径或直接操作 Worker。
2. `services/daemon` 独占 Project、Revision、Approval、Job、ObjectEdit 与 Device/Grant 状态。
3. `services/planner-worker` 首版仅接入 1 个明确支持严格 JSON Schema 工具调用的 Provider，仅获得 17 个 inspect/query/propose 工具与终止型工具 `submit_edit_plan`；严禁通用 shell、文件系统、MCP、扩展加载、审批或直接渲染。
4. `services/media-worker` 以 FFmpeg/ffprobe 为唯一确定性后端起步；FilmCraft 退出关键路径，仅保留可选未来 `DeterministicBackend` 适配接口。

### 3. 第三方依赖边界

- **剥离移除**：Paseo（`@getpaseo/*`、`downstream/paseo`、`vendor/paseo`）、Pi（`@earendil-works/pi-coding-agent` 等包与源码）、FilmCraft（从关键路径与核心构建依赖中移除）。
- **允许保留的通用第三方依赖**：FFmpeg/ffprobe、SQLite（`node:sqlite`）、Zod、Electron、React、Expo、`ws`、ONNX Runtime、`scenedetect`（BSD-3-Clause，仅限镜头切分内核）、NumPy、Pillow、OpenCV、PyTorch、SAM2、diffusers/transformers；所有模型权重与媒体组件仍受 [风险与许可门](../../demo/09-risks-research.md) 约束。

### 4. Wire 命名策略

R0–R5 迁移期内保持现有 `video.v1.*` 方法名不变，以降低客户端改动成本并支持旧/新实现直接做契约对照；是否重命名为 `ave.v1.*` 作为独立命名决策处理，不与本轮去宿主重构捆绑。

### 5. 并存过渡与切换策略

- R0–R4 期间原生目录（`apps/`、`packages/`、`services/`、`storage/`）在仓库根目录与 `downstream/paseo/` 并存，根 workspace 配置严格排除 `downstream/`、`vendor/`、`paseo/`、`pi/`、`filmcraft/`、`references/`。
- 运行时数据目录强制隔离：原生 daemon 使用独立 `AVE_HOME`（默认 `~/.ave`），严禁旧 Paseo daemon 与原生 daemon 共享或同时写入同一 SQLite 数据库与 CAS 目录。
- R5 完成旧项目版本化导出/导入迁移工具与端到端验收后，打 `legacy/paseo-based` 归档分支/tag，并删除 `downstream/paseo/` 及上游补丁脚本。

### 6. 与既有 ADR 的关系

- **延续**：ADR 001（本地单 daemon）、ADR 002（daemon 唯一状态所有者）、ADR 004（strict structured tool 提议 + daemon 审批）、ADR 005（EditGraph + 有理数时间 + SamplingMap）、ADR 007（SQLite WAL + CAS + outbox + lease fencing）、ADR 010（隔离/恢复/roll-forward）。
- **由本 ADR 取代（R5 生效后归档旧条款）**：ADR 003（Pi SDK → 原生 `planner-worker`）、ADR 006 & ADR 011（FilmCraft 现役双后端 → FFmpeg 起步 + 可选 `DeterministicBackend` 接口）、ADR 008（Paseo 内置插件 → AVE 原生 daemon/WS/SDK/客户端）、ADR 009（以 Paseo/Pi/FilmCraft superproject 锁作为构建前提 → 原生代码独立构建，参考仓仅作设计档案）。

## 后果与可逆性

- **正面影响**：消除通用宿主与外部 Agent 框架束缚；16.6k 行视频核心资产直接进入一等原生模块；R0–R5 每一步均产出可运行、可验证的垂直切片。
- **代价与约束**：R0–R4 存在双目录并存期，需严守 `AVE_HOME` 隔离及契约对照测试；完整实施详见 [原生化迁移计划（R0–R5）](../../demo/11-native-migration-plan.md)。
- **可逆性**：R5 最终切换前 `downstream/paseo/` 保持完整可运行状态；R5 切换时通过 `legacy/paseo-based` tag/分支保留完整历史对照。
