# 执行与验证记录

## 历史基线记录（2026-11-24 ~ 2026-11-26）

- 已完成 `demo.md`、`demo/01..09`、`findings.md`、参考仓库锁与 Chrome + server/video 审片验证；该阶段 Paseo 覆盖层已归档于 `legacy/paseo-based` 分支与 `legacy-paseo-based` 标签。

## 原生化收敛 R0–R5 执行记录（2026-11-27）

- **P · 架构决策与计划**：新增 [`docs/adr/0012-native-ave-architecture.md`](docs/adr/0012-native-ave-architecture.md) 与 [`demo/11-native-migration-plan.md`](demo/11-native-migration-plan.md)。
- **R0 · 行为基线**：建立 `conformance/r0-baseline/`（196 fixtures、63 RPCs、17 tools、24 error codes、4 黄金样本）。
- **R1 · 原生领域与五仓 SQLite**：实现 `packages/contracts`、`packages/domain`、`storage/cas`、`storage/sqlite` 与 `scripts/check_native_boundaries.py`。
- **R2 · 桌面确定性闭环**：实现 `packages/protocol`、`packages/client-sdk`、`services/daemon`、`apps/web`、`apps/desktop`，通过真实 FFmpeg 导入→裁剪→审批→渲染→QA→导出与 `ffprobe`/全片解码测试。
- **R3 · 原生 Planner**：实现 `services/planner-worker` 替换 Pi SDK，跑通本地 mock strict-schema 模型端到端提交方案、`bash`/越权审批拦截、`abort` 与重启恢复。
- **R4 · 媒体内核与对象编辑**：迁移 11 个 Python 模块至 `services/media-worker/`，接线 `AvePyWorker` 与 `AveMediaWorkerBridge`，通过 `pytest`（核心 7 项）、`inspect_frame`、6 态 FSM、录制适配追帧（含真实 H.264 审片视频编码与 ffprobe 时钟验证）和 VACE 预览提议 E2E。
- **R5 · Android 监督、旧库迁移与切换**：实现 `apps/mobile`、`services/relay/README.md`、`storage/sqlite/src/legacy-migration.ts` 与 `scripts/migrate_legacy_project.mjs`，完成 `legacy/paseo-based` 归档与 `downstream/paseo/` 移除。

## 明确未验证项（诚实边界）

1. 真实 GPU 模型权重（SAM2.1 Tiny、Wan2.1-VACE-1.3B）与可选 Python ML 运行时（`scenedetect`、`cv2`、`onnxruntime`、`torch`、`sam2`、`diffusers`）未在当前无 GPU 环境端到端推理；未配置时系统正确返回 `CAPABILITY_UNAVAILABLE` 并按 `pytest.importorskip` 跳过可选测试。
2. Electron 真实图形窗口渲染（无显示服务器的 headless Linux 宿主），仅验证了安全选项（`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`）与拉起真实原生 daemon 进程。
3. Expo Android `.apk` 构建、Android 真机联调以及 Windows / macOS 安装包打包签名。
