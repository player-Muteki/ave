# AVE 任务清单与状态

## 历史设计与调研阶段（已完成）

- [x] Phase 0–14：需求重写、Pi/Paseo/FilmCraft/CVPR 调研、团队分工基线、SVG 与文档校验门，以及 Chrome + 服务端媒体审片/下载验证。

## 原生化收敛 R0–R5（ADR 012，已完成）

- [x] **规划基线**：产出 `docs/adr/0012-native-ave-architecture.md` 与 `demo/11-native-migration-plan.md`。
- [x] **R0 · 冻结行为基线**：建立 `conformance/r0-baseline/`（196 条契约 fixtures、`baseline-spec.json`、4 个黄金合成媒体样本与校验器）。
- [x] **R1 · 原生领域内核**：建立 `packages/contracts`、`packages/domain`、`storage/cas`、`storage/sqlite`（单库五 Repository）。
- [x] **R2 · 本地桌面确定性闭环**：建立 `packages/protocol`、`packages/client-sdk`、`services/daemon`（FFmpeg 后端、63 RPC）、`apps/web` 与 `apps/desktop`。
- [x] **R3 · 原生 Planner**：建立 `services/planner-worker`（JSONL IPC、单 strict Provider、17 封闭工具）并在 `services/daemon` 跑通完整闭环与安全拦截。
- [x] **R4 · 对象编辑与媒体内核**：迁移 `services/media-worker`（11 个 Python 内核），接线 `AveMediaWorkerBridge`、`AvePyWorker` 与 Web UI 对象编辑控制。
- [x] **R5 · Android 监督、旧库迁移与切换**：建立 `apps/mobile`、`services/relay/README.md`、`ave.migration/v1` 只读迁移工具，打 `legacy/paseo-based` 归档分支/标签，移除 `downstream/paseo/` 并更新全仓基线。
