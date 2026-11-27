# 02 · 总体架构

[返回总览](../demo.md) · [Agent](03-agent-runtime.md) · [媒体](04-media-pipeline.md) · [接口](06-interfaces.md)

## 1. 架构图

[![Agentic Video Editor 总体架构](../ARCHITECTURE.svg)](../ARCHITECTURE.svg)

[打开 SVG 原图](../ARCHITECTURE.svg)。图内描述的是目标边界，不表示进程已经实现。

## 2. 架构原则

1. **本地优先**：素材、项目 DB、会话和产物默认留在桌面；远端只接收用户明确批准的镜头/图片/audio/prompt。
2. **一个领域事实源**：video-daemon 独占 Project/Revision/Plan/Approval/Job；客户端和 Agent 不各自维护可写副本。
3. **对话与任务分离**：Pi 管理会话；JobRunner 管理持久任务。停止对话不取消任务，模型轮次结束不等于任务完成。
4. **非破坏与可重放**：Asset 不可变，EditOperation 和生成节点形成 Revision；任何输出可追溯到输入、参数和运行环境。
5. **信任边界在进程和服务端**：prompt、前端隐藏按钮、插件声明和模型 annotations 都不是权限控制。
6. **按能力调度**：确定性任务无需 GPU；生成 Worker 必须声明已验证能力，未配置时不伪造结果。

## 3. 技术栈与职责

| 层 | 技术选择 | 职责 | 状态/限制 |
| --- | --- | --- | --- |
| 桌面宿主 | Electron，复用 Paseo main/preload/updater | 文件授权、daemon 生命周期、签名、更新 | 复用路径已调研，新产品未构建 |
| 共享 UI | Expo Web + React Native 组件/视图模型 | 会话、计划、任务、审批、预览 | mask/复杂时间线只桌面 |
| Android | Expo + EAS/Gradle | 远程监督、上传下载、审批、取消 | minSdk 29 是上游配置，真机未验收 |
| 领域插件 | Paseo built-in plugin、TypeScript、Zod RPC/subscription | video API、权限、项目/任务服务 | 内置插件不沙箱，import allowlist |
| Agent | 独立 Node agent-worker、Pi `createAgentSession` | 规划、会话、事件、受控工具 | 自有 IPC；不直接暴露原始 Pi RPC |
| 领域存储 | SQLite WAL + 本地 CAS | Revision、审批、Job、outbox、资产索引 | `node:sqlite` 仅候选，需三 OS packaged 探针 |
| 确定性媒体 | FFmpeg/ffprobe + FilmCraft Rust adapter | 共享 EditCommand → 后端路由、编辑、效果、混音、导出 | FilmCraft 候选；按操作/素材矩阵验收，未验证用 FFmpeg |
| 探测/生成媒体 | FFmpeg/ffprobe、Python media worker | 探测、时间映射、生成前后处理、合成、独立 QA | 构建/硬件路径逐平台实测 |
| 视觉模型 | SAM2.1、Wan2.1-VACE-1.3B | mask、短镜头生成候选 | CUDA/质量/VRAM/许可均需验收 |
| 契约 | Zod → JSON Schema + golden fixtures | TS/Python 共用 wire 契约 | 只有一个源 schema，生成物需校验 |
| 观测 | 结构化本地 JSONL、可选 OTel exporter | 日志、trace、指标、崩溃与诊断 | 默认不上传 |

## 4. 进程边界

### 4.1 客户端

Electron renderer/Expo Web 不直接访问源路径、SQLite、Pi 或 Worker。原生文件选择/拖放把授权交给 MediaService；首版播放器使用 WebSocket 分块媒体读取，桌面直连可选认证 HTTP Range，relay 不依赖 HTTP 隧道。

Android 只调用远程 video RPC。viewer 与 operator 的权限在 daemon 判定；角色来自认证上下文，不来自请求体。

### 4.2 video-daemon / Paseo 插件

- **SessionService**：拥有 agent-worker 生命周期和项目 session 映射。
- **Project/Plan/Approval Store**：事务、Revision diff、审批 grant、migration。
- **MediaService**：导入 hash、presentation index、代理、上传下载、资产授权。
- **ToolGateway**（Agent 侧实现接口名 `VideoToolBroker`）：工具 schema/语义校验；不包含 approve/apply。
- **JobRunner/Scheduler**：DAG、lease、队列、资源准入、取消、恢复、outbox。

Paseo 通用 Pi provider 不再拥有视频会话，避免双会话状态。内置插件本身不是沙箱，敏感操作仍须独立 Worker 和服务端校验。

### 4.3 agent-worker

使用封闭 ResourceLoader 和 `createAgentSession`，只开放 inspect/propose/query 工具。daemon 通过自有 `AgentRunController` IPC 执行 start/steer/followUp/abort 和事件订阅。进程崩溃只影响 planning run，不回滚已接受 Job。

### 4.4 确定性编辑后端与 Python Worker

FFmpeg 用参数数组直接启动，`shell:false`。Python Worker 通过版本化 stdio/localhost job protocol 接收 BlobRef、受控参数和 lease，不执行模型生成的 Python 或 shell。远程 Worker 使用认证传输、同协议和相同 hash/manifest 验证。

FilmCraft 是独立 Rust `deterministic-engine-worker`，通过本项目自有协议接收 canonical `EditCommand`，不是直接开放 MCP/control channel。每个后端 session 单写者；`.fcproj` 仅是绑定 `approvedRevisionHash` 的后端私有快照，FilmCraft job ID 映射到 daemon attempt，不能替代 SQLite Job/lease。

- 源文件只读，MediaService 为 Worker 提供授权路径/沙箱句柄；导出只能进入独立 staging，验证后导入 CAS。禁止原始 `ui_control`、绝对路径导入、任意 `file.*`、偏好设置、下载和删除命令。
- 预检 `media.status/findMissing`，完成时 `offlineMedia` 必须为空，否则即使 FilmCraft 返回成功也失败；占位画面永不进入 completed。
- GUI 与 Agent 写同一 Revision。FilmCraft undo 只用于后端命令事务/专家探针，产品撤销由新 Revision 实现；不得让桌面 egui、headless MCP 和 daemon 同时写同一 `.fcproj`。
- 后端不可用时保留失败及诊断。FilmCraft ↔ FFmpeg 的切换会改变色彩、效果或帧网格语义，必须产生新 Plan diff 并重新审批，不在同一 attempt 静默切换。

## 5. 数据与一致性

### 5.1 两层存储

SQLite WAL 保存事务性元数据和事件顺序；CAS 保存源、proxy、mask、帧、模型输入输出和导出。CAS 对象由 Revision/Job pin，临时文件不进入可读资产。

核心表：projects、assets、timelines、plans、approvals、jobs、job_attempts、artifacts、events、outbox、agent_sessions、agent_runs。事件发布与状态更新在同一事务写 outbox，避免 DB 已变而客户端永远收不到事件。

### 5.2 Revision 与审批

- 修改已运行计划会 fork 新 Revision；旧节点可产生缓存，但不能挂到新 Revision。
- grant 绑定 `projectId + planHash + baseRevision + device + expiry`；执行时重新校验。
- mutation 使用 `requestId + expectedRevision`，响应可重放；重复点击不重复生成或扣费。
- 远程生成先保存 idempotency key，获得 providerJobId 立即持久化；未知结果进入 reconciliation。

### 5.3 事件一致性

每个项目有单调 `seq` 和唯一 `eventId`。客户端先取 snapshot，再从最后 seq 拉事件；缺口触发重新同步。文本 delta 不作为持久事实，Job 事件只来自 Scheduler outbox。

## 6. Job 状态机

```text
draft → analyzing → awaiting_plan_approval → awaiting_inputs
      → rendering_preview → awaiting_review → rendering_final
      → validating → awaiting_delivery_approval → completed

允许的执行状态 → cancel_requested → cancelled
允许的执行状态 → pausing → paused → 重新排队到暂停前状态
执行/验证状态 → failed（retryable 或 terminal）
```

`awaiting_inputs` 包括选对象、修 mask、确认锚帧、选择后端或补充歧义。只有 JobRunner 迁移状态；Agent 只能提议或查询。Node 使用 pending/leased/running/checkpointing/interrupted/succeeded/retryable_failed/blocked/cancelled；`interrupted` 表示 daemon/Worker 重启后尚未确认可重试的 attempt，reconciler 会转 retryable_failed 或 succeeded。

daemon 重启后过期 lease 被新 epoch 接管；运行中节点先标 interrupted/retryable_failed，未提交产物永不进入时间线。暂停是安全边界释放并重新排队，不是跨平台冻结 CUDA。

## 7. 部署形态

### 单桌面本地模式

Electron 管理 daemon、agent-worker 和本地 Worker；模型/provider 按用户配置。无生成后端时只禁用生成 capability，确定性编辑不受影响。

### 显式远程 GPU 模式

daemon 保持项目所有权，远程 Worker 只获得已批准任务所需 BlobRef。审批界面列出实际上传内容和目的地；默认不转发整个工作区。Worker 断线通过 lease/reconciliation 处理，不假设 exactly-once。

### Android 远程模式

Android 通过配对后的直连或 E2EE relay 连接同一 daemon。手机退出不影响 Job；relay 只转发密文，不替代项目权限。workspace-scoped 授权未完成前，不接入不可信设备或宣传多用户隔离。

## 8. 故障与恢复边界

| 故障 | 系统行为 | 禁止行为 |
| --- | --- | --- |
| Agent 进程崩溃 | planning run interrupted，从 canonical state 重驱 | 自动重放未知工具副作用 |
| daemon 崩溃 | 从 SQLite/CAS 恢复，旧 lease 过期后接管 | 把半成品标为完成 |
| Worker 崩溃/OOM | attempt 失败，有限重试或缩小任务 | 无限自动重试、隐瞒资源不足 |
| 远程完成重复/迟到 | event/lease 去重，stale epoch 拒绝 | 重复扣费、覆盖新 Revision |
| 磁盘不足 | 准入失败或安全取消，保留已 pin 资产 | 删除源片/正在使用缓存 |
| 手机断线 | Job 继续，重连 snapshot + events | 手机本地伪造进度 |
| QA 失败 | 定位阶段、生成新修正 Revision 或人工接管 | Agent 自行降低阈值 |

## 9. 上游与代码边界

M0 根仓库以[上游清单](../research/upstream.json)锁定 Pi/Paseo/FilmCraft，参考 checkout 被忽略，避免将嵌套仓库误提交为空目录。FilmCraft 的两个提交虽同为 0.20.1，源码与依赖却不同（见[升级审查](../research/filmcraft-ba6fe105-to-7b8e522d.md)）；发行前须按实际构建审计 Cargo.lock、依赖与 SBOM，不按版本字符串继承验收。

M1 若按当前设计实现 Paseo 内置插件，需要建立团队可访问的 Paseo downstream fork，并由根 superproject 以精确 gitlink 管理；Pi 默认上游只读，FilmCraft 优先保持无修改的独立二进制/库依赖。两套 Node 上游分别保留自己的 lockfile 和 `npm ci`，FilmCraft 保留 Cargo workspace，不强行合并构建系统。上游 bump 是独立 PR，必须通过兼容和发布矩阵。

## 10. 设计诊断

按本地单 daemon 范围，当前设计评分 **8/10**：需求、异步队列、SQLite/CAS、缓存键、观测和部署策略明确；尚未满足的两项是**实测容量**与**组件冗余**。

- 容量：M1/M3 用真实硬件 benchmark 填入资源表，调度只采用实测 resource class。
- 冗余：首版有意不做云端 HA；以进程隔离、备份、lease 接管、崩溃恢复和 roll-forward 降低单点风险，不宣称高可用。
