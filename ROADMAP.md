# 路线图

实时职责与证据状态见 [`DIVISION.svg`](DIVISION.svg)，原生收敛架构决策见 [ADR 012](docs/adr/0012-native-ave-architecture.md)，R0–R5 完整实施记录见 [原生迁移计划](demo/11-native-migration-plan.md)。

证据按三级记录，互不替代：

- **代码完成**：实现与契约已进入 `main`，没有用测试适配器冒充生产路径。
- **本机验证**：在开发机（Linux）上由 CI 或列出的命令真实执行并通过。
- **实机验证**：在目标分发包、设备或真实模型权重上验收。

只有**实机验证**为「通过」的阶段，才能作为对外交付证据引用。

| 阶段 | 目标 | 代码完成 | 本机验证 | 实机验证 |
| --- | --- | --- | --- | --- |
| R0 | 冻结 196 条契约 fixtures、63 RPC、权限矩阵、17 工具、4 个黄金媒体样本 | 通过 | 通过 · `verify_r0_baseline.py`（fixtures / RPC / 工具 / 黄金样本生成与完整解码） | 不适用（基线不产出分发包） |
| R1 | 原生 `packages/contracts`、`packages/domain`、`storage/sqlite`（5 repo）、`storage/cas` | 通过 | 通过 · `contracts`／`domain`／`cas`／`sqlite` 单测，幂等与 CAS 哈希校验 | 不适用 |
| R2 | 原生 `packages/protocol`、`packages/client-sdk`、`services/daemon`（FFmpeg 后端）、`apps/web`、`apps/desktop` | 通过 | 通过 · 真实 FFmpeg 导入→裁剪→审批→渲染→QA→导出解码；`desktop-security` 单元 | 未通过 · Electron 窗口与安装包未运行（无显示服务实机） |
| R3 | 原生 `services/planner-worker`（stdio JSONL、单 strict Provider、17 封闭工具） | 通过 | 通过 · 确定性 provider E2E、越权拒绝、abort 与重启恢复 | 未通过 · 真实模型 provider 未接入验收 |
| R4 | 迁移 `services/media-worker`（11 个 Python 内核）并打通对象编辑/掩码/VACE 提议链 | 通过 | 通过 · `pytest` 9/9（无跳过）、`AvePyWorker`、`inspect_frame`、6 态对象编辑 E2E | 未通过 · 真实 SAM2／VACE 权重与 GPU 推理未运行（E2E 用录制／测试适配器） |
| R5 | `apps/mobile` 远程监督、`services/relay` 边界、旧库只读迁移工具、归档 `legacy/paseo-based` 并删除 `downstream/paseo/` | 通过 | 通过 · `mobile-supervisor` 单元与实时 daemon E2E、只读导出／隔离导入 | 未通过 · Android `.apk` 构建与真机联调未运行 |

R2–R5 的实机列需要先由 `.github/workflows/desktop-*.yml`（手动触发）产出安装包，再在目标平台验收；该链路在 R0–R5 期间未被本机执行，因此不对应任何「通过」。
