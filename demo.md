# Agentic Video Editor 设计总览

> 状态：**原生独立版架构 R0–R5 已落地（2026-11-27）**。原生收敛决策见 [ADR 012](docs/adr/0012-native-ave-architecture.md)，迁移与实测清单见 [原生迁移计划](demo/11-native-migration-plan.md)。历史原始需求见 [`research/demo.original.md`](research/demo.original.md)，调研证据见 [`findings.md`](findings.md)。

## 项目一句话

构建一个本地优先的跨平台 AI 视频编辑工作台：原生模块化单体 AVE daemon 独占项目、Revision、Approval 与 Job 状态；独立 `planner-worker` 通过受控 17 工具循环生成可审计、可撤销的 `EditPlan`；FFmpeg + Python `media-worker` 执行真实媒体与视觉流水线；桌面工作台与 Android 远程监督端均通过类型化 `client-sdk` 连接同一 daemon。

## 原生收敛成果（R0–R5）

| 原目标 | 原生实现与所在目录 | 已运行验证 |
| --- | --- | --- |
| 去宿主化与去外部框架 | 无 Paseo/Pi/FilmCraft 源码与包依赖；旧版归档于 `legacy/paseo-based` | `check_native_boundaries.py`、`check_native_rpc_surface.py`、`verify_r0_baseline.py` |
| 领域契约与单库五仓 | `packages/contracts`、`packages/domain`、`storage/sqlite`、`storage/cas` | 196 条 R0 fixture、幂等与修订冲突、CAS SHA-256 校验、只读旧库迁移 |
| 本地桌面闭环 | `services/daemon`（FFmpeg 后端）、`packages/protocol`、`packages/client-sdk`、`apps/web`、`apps/desktop` | 上传、分析、计划审批、预览/成品/导出、完整 `ffprobe` + 解码 QA、Electron 安全壳 |
| 受控原生 Planner | `services/planner-worker`（stdio JSONL IPC + 单 strict JSON Schema Provider + 17 工具） | 本地确定性模型闭环、`bash`/越权审批拦截、`abort` 与重启恢复 |
| 媒体内核与对象编辑 | `services/media-worker`（Python）、`AvePyWorker`、`AveMediaWorkerBridge` | `pytest` 核心内核、真实帧检查、六态对象编辑、录制适配追帧/H.264 审片/VACE 提议 |
| Android 远程监督与迁移 | `apps/mobile`、`services/relay/README.md`、`scripts/migrate_legacy_project.mjs` | 配对/只读/operator/审批/下载/事件补拉/设备吊销实时 E2E |

## 专题文档地图

| 文档 | 内容 | 主要读者 |
| --- | --- | --- |
| [01 产品与交付标准](demo/01-product.md) | 用户、范围、功能/非功能需求、平台和完成定义 | 全员 |
| [02 总体架构](demo/02-architecture.md) | 进程、数据、状态、部署、所有权和故障边界 | K、L |
| [03 Agent Runtime](demo/03-agent-runtime.md) | 受控规划、工具边界、prompt 与事件恢复 | K、L |
| [04 媒体与生成流水线](demo/04-media-pipeline.md) | EditGraph、FFmpeg、SAM2、VACE、Worker、QA | K、L、C |
| [05 客户端与远程控制](demo/05-clients-remote.md) | 桌面、Android、传输、权限和联调 | J、C |
| [06 接口与数据契约](demo/06-interfaces.md) | DTO、RPC、事件、错误、Worker 消息和兼容策略 | 全员 |
| [07 团队分工与并行开发](demo/07-team-workflow.md) | K/L/J/C 工作包、依赖、里程碑与统计 | 全员 |
| [08 测试、发布与验收](demo/08-delivery.md) | 测试矩阵、benchmark、CI/CD、发布与回滚 | 全员 |
| [09 风险、许可与实验](demo/09-risks-research.md) | ADR、实验问题、许可、隐私与风险门 | K、L |
| [11 原生收敛与 R0–R5 计划](demo/11-native-migration-plan.md) | 去 Paseo/Pi/FilmCraft 原生化架构、存储拆分与验收记录 | 全员 |

## 快速导航

[架构 SVG](ARCHITECTURE.svg) · [分工 SVG](DIVISION.svg) · [README](README.md) · [ADR 012](docs/adr/0012-native-ave-architecture.md) · [路线图](ROADMAP.md) · [执行记录](progress.md)
