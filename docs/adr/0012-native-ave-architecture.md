# ADR 012: AVE 原生架构收敛与去宿主化策略

## 状态

Accepted & Implemented（2026-11-27，R0–R5 已全部完成；旧 Paseo 基线已归档于 `legacy/paseo-based` 分支与 `legacy-paseo-based` 标签）。

## 背景

Agentic Video Editor（AVE）的核心视频领域能力（契约、EditGraph、审批、幂等恢复、对象编辑六态状态机、FFmpeg/Python 媒体流水线与桌面端交互逻辑）此前已自主成型于归档分支 `legacy/paseo-based` 的 `downstream/paseo/` 覆盖层中，通用宿主 Paseo、Agent 框架 Pi 与候选后端 FilmCraft 的实际耦合边界极度集中：

1. **Paseo 宿主耦合**：仅分布在 8 个宿主适配文件及客户端插件注册壳 `index.client.tsx`；核心 `server/video/` 内部仅引用了 `DaemonPermission` 类型与 `paseoHome` 目录名。
2. **客户端插件耦合**：视图仅通过 `@getpaseo/plugin/client` 的 `useRpc` 发起 RPC，其余纯 TS 核心逻辑零 Paseo 依赖。
3. **Pi 耦合**：严格收敛在 `agent/session.ts`（`createAgentSession` 等）与探针脚本 `closed-session.mjs`；`controller.ts`、`ipc.ts`、`worker-main.ts`、`tool-broker.ts` 均属 AVE 自有协议边界。
4. **FilmCraft**：在 `downstream/paseo/` 生产代码中零导入，仅作为版本锁和对照脚本保留。

因此，AVE 不推翻既有视频领域设计与契约，直接去除通用宿主与外部 Agent 框架，收敛为独立原生产品。

## 决策

### 1. 目标架构：AVE 专用模块化单体 + 独立 Worker

采用以下根目录分层架构，首版不做通用插件系统、不做微服务拆分：

- `apps/desktop/`：Electron 主进程、preload（强制 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`）、打包与更新。
- `apps/web/`：React 桌面编辑器工作台 UI（含导入、裁剪、审批队列、对象编辑操作与成片校验播放器）。
- `apps/mobile/`：Expo Android 远程监督端（聚焦配对、预览、审批、取消与下载；不强行共享桌面时间线与精细掩码编辑）。
- `packages/contracts/`：AVE wire schema（63 个 `video.v1.*` RPC）、fixtures 与版本兼容规则。
- `packages/domain/`：有理数时间模型、EditGraph、Plan、Approval、对象编辑六态状态机、主体授权与核心校验逻辑。
- `packages/protocol/`：WebSocket 消息信封、二进制分块 framing 与错误码。
- `packages/client-sdk/`：类型化 RPC、断线重连、`snapshot + events(afterSeq)` 补拉与 `get_mutation_result` 对账。
- `services/daemon/`：唯一项目事实源、事务协调、权限中间件、任务调度、方法注册表与服务组装。
- `services/planner-worker/`：独立规划 Worker 进程，执行模型对话与受控工具循环，不接触数据库、CAS 与媒体路径。
- `services/media-worker/`：独立 Python 媒体/视觉/生成内核（SamplingMap、镜头/人像检测、SAM2/VACE 与保护合成），仅收受控参数与 CAS 摘要。
- `services/relay/`：可选远程密文转发边界文档（不进入首版本地直连闭环）。
- `storage/sqlite/`：单 SQLite WAL 数据库 + 单事务协调器 + 5 个职责清晰的 Repository + 旧库只读迁移工具。
- `storage/cas/`：源素材、代理、掩码与产物的内容寻址存储，严格校验 SHA-256 与 Revision pin。

### 2. 固定依赖方向

1. UI（`apps/*`）只允许调用 `packages/client-sdk` 与 `packages/contracts`，禁止访问 SQLite、CAS 私有路径或直接操作 Worker。
2. `services/daemon` 独占 Project、Revision、Approval、Job、ObjectEdit 与 Device/Grant 状态。
3. `services/planner-worker` 首版接入单个明确支持 strict JSON Schema 工具调用的 OpenAI 兼容 Provider，仅获得 17 个 inspect/query/propose 工具与终止型工具 `submit_edit_plan`；严禁通用 shell、文件系统、MCP、扩展加载、审批或直接渲染。
4. `services/daemon` 以 FFmpeg/ffprobe 为唯一确定性后端起步；FilmCraft 退出关键路径，仅保留可选未来 `DeterministicBackend` 适配接口。

### 3. 第三方依赖边界

- **剥离移除**：Paseo（`@getpaseo/*`、`downstream/paseo`、`vendor/paseo`）、Pi（`@earendil-works/pi-coding-agent` 等包与源码）、FilmCraft（从关键路径与核心构建依赖中移除）。
- **允许保留的通用第三方依赖**：FFmpeg/ffprobe、SQLite（`node:sqlite`）、Zod、Electron、React、Expo、`ws`、ONNX Runtime、`scenedetect`（BSD-3-Clause，仅限镜头切分内核）、NumPy、Pillow、OpenCV、PyTorch、SAM2、diffusers/transformers；所有模型权重与媒体组件仍受 [风险与许可门](../../demo/09-risks-research.md) 约束。

### 4. Wire 命名策略

保持 `video.v1.*` wire 方法名不变以维持契约与测试 fixture 稳定；未来若重命名为 `ave.v1.*`，须作为独立协议版本变更处理。

### 5. 数据隔离与历史归档

- 运行时数据目录强制隔离：`AVE_HOME`（默认 `~/.ave`）禁止指向历史 `.paseo/video-editor`；旧项目迁移仅通过只读清单导出 + 哈希校验导入完成（`scripts/migrate_legacy_project.mjs`）。
- R5 已于切换前创建 `legacy/paseo-based` 分支与 `legacy-paseo-based` 标签保存完整 Paseo 时代对照快照，主线已移除 `downstream/paseo/`。

## 后果

- **正面影响**：彻底消除通用宿主与外部 Agent 框架束缚；所有 63 个 RPC、24 错误码、17 受控工具、5-Repository 存储、桌面与移动监督端均由原生 TS/Python 测试持续门控。
- **尚未覆盖的平台/硬件项**：真实 GPU SAM2/VACE 权重端到端推理、Linux 无头环境下的 Electron GUI 实屏渲染、Android `.apk` 打包与真机验证及 Windows/macOS 安装包仍按 `AGENTS.md` 诚实标为未验证。详见 [原生化收敛与 R0–R5 迁移记录](../../demo/11-native-migration-plan.md)。
