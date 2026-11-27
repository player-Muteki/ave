# 路线图

实时职责与证据状态见 [`DIVISION.svg`](DIVISION.svg)，原生收敛架构决策见 [ADR 012](docs/adr/0012-native-ave-architecture.md)，R0–R5 完整实施记录见 [原生迁移计划](demo/11-native-migration-plan.md)。

| 阶段 | 目标 | 当前状态 | 验收范围 |
| --- | --- | --- | --- |
| R0 | 冻结 196 条契约 fixtures、63 RPC、权限矩阵、17 工具、4 个黄金媒体样本 | 已完成 | `verify_r0_baseline.py` 与 `ffprobe`/完整解码通过 |
| R1 | 原生 `packages/contracts`、`packages/domain`、`storage/sqlite`（5 repo）、`storage/cas` | 已完成 | 零 Paseo/Pi/FilmCraft 耦合；单测、幂等与 CAS 校验全过 |
| R2 | 原生 `packages/protocol`、`packages/client-sdk`、`services/daemon`（FFmpeg 后端）、`apps/web`、`apps/desktop` | 已完成 | 真实 FFmpeg 导入→裁剪→审批→渲染→QA→导出解码；Electron 安全单元过（无显示服务实机 GUI 未运行） |
| R3 | 原生 `services/planner-worker`（stdio JSONL、单 strict Provider、17 封闭工具） | 已完成 | 本地 HTTP 确定性模型 E2E、越权拒绝、abort 与重启恢复通过 |
| R4 | 迁移 `services/media-worker`（11 个 Python 内核）并打通对象编辑/掩码/VACE 提议链 | 已完成 | `pytest`（核心 7 过，2 项可选依赖跳过）、`AvePyWorker`、`inspect_frame`、录制适配追帧与 6 态对象编辑全过（真实 GPU SAM2/VACE 权重未在本机运行） |
| R5 | `apps/mobile` 远程监督、`services/relay` 边界、旧库只读迁移工具、归档 `legacy/paseo-based` 并删除 `downstream/paseo/` | 已完成 | `mobile-supervisor` 单元与实时 daemon E2E 过；只读导出/隔离导入全过（Android `.apk` 构建与真机联调未运行） |
