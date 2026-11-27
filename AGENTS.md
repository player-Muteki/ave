# AGENTS.md

本文件约束在本仓库工作的编码 Agent。

## 先读

1. `README.md` 与 `demo.md`：原生产品结构与文档地图。
2. `docs/adr/0012-native-ave-architecture.md`：原生 AVE 架构与去宿主化约束。
3. `demo/06-interfaces.md`：跨端唯一契约来源（`packages/contracts`）。
4. `demo/11-native-migration-plan.md`：R0–R5 迁移规范与不变量清单。

## 工程边界

- AVE 已完成原生架构收敛（R0–R5）：不再携带 Paseo、Pi 或 FilmCraft 源码、运行时依赖或宿主进程；历史版本归档于 `legacy/paseo-based`。
- 依赖方向严格固定为：
  - `apps/*`（`desktop`、`web`、`mobile`）只能调用 `@ave/client-sdk` 与 `@ave/contracts`，严禁直接访问 SQLite、CAS 或 `services/*`。
  - `services/daemon` 独占项目事实源（`storage/sqlite` 五个 Repository 共享单库单事务协调器与 `storage/cas`）、权限校验、审批与任务调度。
  - `services/planner-worker` 仅依赖 `@ave/contracts` 与单一 strict JSON Schema Provider，仅获得 17 个受控只读/提议工具与 `submit_edit_plan` 终止工具，严禁 shell、任意文件 I/O、MCP 或审批/渲染权限。
  - `services/media-worker` 通过参数数组 + `shell:false` + staging 目录运行 FFmpeg/Python 内核，不进入 daemon SQLite 事务。
- 禁止使用 `check_native_boundaries.py` 禁用的 `@getpaseo/*`、`@earendil-works/pi-*`、`downstream/paseo`、`vendor/paseo` 或 FilmCraft 导入。
- 运行时数据目录 `AVE_HOME`（默认 `~/.ave`）必须与历史 `.paseo/video-editor` 严格隔离；旧项目迁移仅通过 `scripts/migrate_legacy_project.mjs`（只读导出 + SHA-256 校验导入）完成。
- 会话、EditJob、审批、渲染进度分别以真实服务状态为准；`agent_settled` 不等于任务完成。
- 密钥、素材、生成媒体、模型权重、缓存、构建产物（`dist/`）和安装包不得提交。

## 验证

- 构建与类型检查：`node apps/web/scripts/build.mjs && npm run typecheck`
- 全量自动化测试：`npm test && pytest services/media-worker/tests`
- 架构与基线门禁：`python3 scripts/check_native_boundaries.py && python3 scripts/check_native_rpc_surface.py && python3 conformance/r0-baseline/verify_r0_baseline.py`
- 文档与统计校验：`python3 scripts/check_project.py`
- 实事求是：未运行的 GPU 权重（SAM2/VACE）、Electron 实机窗口渲染、Android APK/真机与 Windows/macOS 安装包必须在汇报中明确标为未验证。

## 团队统计

- `DIVISION.svg` 只能由 `python3 scripts/update_division.py` 生成；人员职责与任务状态改 `research/team.json`。
- 功能提交后单独提交统计刷新，提交主题使用 `chore(stats): refresh division`。
