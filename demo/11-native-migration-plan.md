# 11 · 原生化收敛与 R0–R5 垂直迁移记录

[返回总览](../demo.md) · [ADR 012](../docs/adr/0012-native-ave-architecture.md) · [总体架构](02-architecture.md) · [接口契约](06-interfaces.md) · [风险与 ADR](09-risks-research.md)

> 状态：**R0–R5 全部完成（2026-11-27）**。旧基于 Paseo 的覆盖层已归档至 Git 分支/标签 `legacy/paseo-based`（`legacy-paseo-based`），并从原生主线移除 `downstream/paseo/`。

## 1. 历史耦合盘点总结（归档分支 `legacy/paseo-based` 对照结论）

- **Paseo 耦合**：收敛在原宿主 8 文件及插件注册壳 `index.client.tsx`；已由原生 `services/daemon` WS 网关、`packages/protocol`、`packages/client-sdk` 与独立 `apps/web` / `apps/desktop` / `apps/mobile` 完全替代。
- **Pi 耦合**：收敛在原 `agent/session.ts`（256 行）与探针脚本 `closed-session.mjs`；已由 `services/planner-worker/` 原生状态循环 + 单 strict Provider 客户端 + JSONL stdio IPC + 17 封闭工具替换。
- **FilmCraft 耦合**：生产代码 0 导入；已在 `DeterministicBackendRegistry` 中移除主动后端实现，仅保留可选 `DeterministicBackend` 接口（运行时明确报告 `available: false`）。
- **Python Worker 资产**：原 11 个 Python 内核已无 Paseo/Pi 引用并完整迁移至 `services/media-worker/`，`pyproject.toml` 与 `services/media-worker/README.md` 明示全部第三方依赖与开源许可。

---

## 2. 目标原生架构与存储拆分

```text
apps/
  desktop/             Electron 主进程、preload（sandbox + contextIsolation）、daemon 启动器
  web/                 React 桌面编辑器 UI（裁剪、审批、任务、对象编辑工作流、审片播放）
  mobile/              Expo Android 远程监督端（配对、预览、审批、取消与校验下载）
packages/
  contracts/           AVE wire schema（63 个 video.v1.* RPC）、bytes 帧编码与错误码
  domain/              有理数时间、EditGraph、Plan、Approval、对象编辑六态 FSM 与主体授权
  protocol/            WebSocket 消息信封、二进制分块 framing
  client-sdk/          类型化 RPC、重连、events(afterSeq) 补拉与 get_mutation_result 对账
services/
  daemon/              唯一项目事实源、授权、FFmpeg 确定性后端、任务监督与 Worker 编排
  planner-worker/      独立规划子进程，严格 JSON Schema 工具校验，不接触 SQLite/CAS/路径
  media-worker/        FFmpeg/Python 媒体与视觉内核，shell:false 参数数组执行
  relay/               可选远期 E2EE 密文转发边界（首版直连不依赖）
storage/
  sqlite/              单 SQLite WAL + TransactionCoordinator + 5 Repositories + 只读迁移工具
  cas/                 SHA-256 内容寻址存储与分块校验
```

| Repository | 负责 SQLite 表 | 核心职责 |
| --- | --- | --- |
| `ProjectAssetRevisionRepository` | `projects`, `assets`, `constant_rate_streams`, `preview_sheets`, `contact_sheets`, `uploads`, `upload_receipts`, `upload_chunks`, `project_settings` | 项目、不可变源资产、分块上传收据与 Revision 推进 |
| `PlanApprovalRepository` | `plans`, `approvals`, `mutations`, `model_policies` | Plan 哈希绑定、审批决策/撤销/过期、`requestId + expectedRevision` 幂等与对账 |
| `JobOutboxRepository` | `jobs`, `artifacts`, `events`, `outbox`, `metadata` | Job 状态与重启恢复、产物登记、持久递增 `seq` 事件与 outbox |
| `ObjectEditRepository` | `object_edits`, `mask_tracking_jobs`, `tracked_mask_reviews`, `mask_anchors` | 对象编辑六态状态机、候选/决策/mask 审批/QA 与换素材失效校验 |
| `DeviceGrantRepository` | `project_grants`, `devices`, `invitations` | 设备配对、一次性邀请兑换、即时吊销与项目级授权（取代 `access.json`） |

---

## 3. R0–R5 阶段交付明细

| 阶段 | 状态 | 核心交付物与实测证明 |
| --- | --- | --- |
| **R0** | 已完成 | `conformance/r0-baseline/`：196 条冻结 fixtures、`baseline-spec.json`、4 个黄金媒体样本及完整解码校验 |
| **R1** | 已完成 | `packages/contracts`、`packages/domain`、`storage/cas`、`storage/sqlite` + 边界脚本 `scripts/check_native_boundaries.py` |
| **R2** | 已完成 | `packages/protocol`、`packages/client-sdk`、`services/daemon`（FFmpeg 后端、63 RPC）、`apps/web`、`apps/desktop`、真实 FFmpeg E2E 与解码验证 |
| **R3** | 已完成 | `services/planner-worker`（17 封闭工具、strict JSON Schema、stdio IPC、`steer`/`followUp`/`abort`）+ `AvePlannerController` + 本地 HTTP 模型闭环与越权拦截 E2E |
| **R4** | 已完成 | `services/media-worker`（11 个 Python 内核 + pytest）+ `AveMediaWorkerBridge` + `AvePyWorker` + Web 对象编辑控制 + 录制适配追帧/H.264 审片/VACE 提议与 6 态 FSM E2E |
| **R5** | 已完成 | `apps/mobile` 远程监督端 + 实时配对/审批/取消/下载/吊销 E2E + `services/relay/README.md` + `ave.migration/v1` 只读迁移工具（`scripts/migrate_legacy_project.mjs`）+ 归档 `legacy/paseo-based` 并删除 `downstream/paseo/` |

## 4. 明确标为未验证的范围

- 真实 GPU 环境下的 SAM2 Tiny 与 Wan2.1-VACE-1.3B 权重端到端推理（当前环境无可用 GPU 权重与完整可选包，未配置时服务层诚实返回 `CAPABILITY_UNAVAILABLE`）。
- Electron 实屏 GUI 窗口渲染（当前为无显示服务器的 Linux 环境，已验证主进程安全策略 `contextIsolation:true`/`nodeIntegration:false`/`sandbox:true` 与真实 daemon 子进程拉起）。
- Expo Android `.apk` 构建、Android 真机联调以及 Windows `.exe` / macOS `.dmg` 桌面安装包。
