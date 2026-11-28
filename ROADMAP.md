# 路线图

实时职责与证据状态见 [`DIVISION.svg`](DIVISION.svg)，原生收敛架构决策见 [ADR 012](docs/adr/0012-native-ave-architecture.md)，R0–R5 完整实施记录见 [原生迁移计划](demo/11-native-migration-plan.md)。

| 阶段 | 目标 | 代码完成 | 本机验证（CI 可复现） | 实机验证 |
| --- | --- | --- | --- | --- |
| R0 | 冻结 196 条契约 fixtures、63 RPC、权限矩阵、17 工具、4 个黄金媒体样本 | ✅ `conformance/r0-baseline/` | `verify_r0_baseline.py` + ffprobe/FFmpeg 完整解码，`native-tests.yml` 每次 push/PR 必跑 | — 契约基线无实机界面；黄金媒体样本随 v0.1.0 发布包分发 |
| R1 | 原生 `packages/contracts`、`packages/domain`、`storage/sqlite`（5 repo）、`storage/cas` | ✅ | 单测 + `check_native_boundaries.py`（126 文件零 Paseo/Pi/FilmCraft 耦合）+ CAS 校验，CI 全过 | — 纯本地存储/契约层，无实机项 |
| R2 | 原生 `packages/protocol`、`packages/client-sdk`、`services/daemon`（FFmpeg 后端）、`apps/web`、`apps/desktop` | ✅ | 真实 FFmpeg 导入→裁剪→审批→渲染→QA→导出解码（daemon e2e + FFmpeg 版本矩阵 CI）；Electron 安全单元 | 未跑过：无显示服务实机 GUI；Windows 安装包已发布但未在真机实测 |
| R3 | 原生 `services/planner-worker`（stdio JSONL、17 封闭工具） | ✅ | 本地 HTTP 确定性 E2E、越权拒绝矩阵（`authorization.test.ts` 穷举 63 RPC）、abort 与重启恢复，CI 全过 | 未跑过：云端/真机模型供应商未联调 |
| R4 | 迁移 `services/media-worker`（11 个 Python 内核）并打通对象编辑/推码/VACE 提议链 | ✅ | `pytest` 核心 + `AvePyWorker` + `inspect_frame` + 解码 H.264 + 6 态对象编辑全链路 e2e，FFmpeg 6.x/9 双版 CI 全过 | 未跑过：真实 GPU SAM2/VACE 权重未在本机运行 |
| R5 | `apps/mobile` 远程监督、`services/relay` 边界、旧库只读迁移工具、归档 `legacy/paseo-based` 删除 `downstream/paseo/` | ✅ | `mobile-supervisor` 单元 + 真实 daemon E2E，离线/迁入工具实现校验，CI 全过 | 未跑过：Android `.apk` 构建与真机联调 |

> 说明：“代码完成”不等于被当作证据使用。引用路线时请看后两列：“本机验证”可在 CI 中每次复现（单测/e2e/FFmpeg 版本矩阵/R0 基线）；“实机验证”仅在真实设备（GUI 、GPU 权重、手机 APK、云端联调）上跑过才算，未跑过则写 未跑过。
