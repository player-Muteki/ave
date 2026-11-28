# ave — Agentic Video Editor（原生独立版）

本地优先、跨平台的 Agent 视频编辑工作台：模块化单体 AVE daemon + 独立原生 Planner Worker + FFmpeg/Python Media Worker + Electron/React 桌面工作台 + Expo Android 远程监督端。

按照 [ADR 012](docs/adr/0012-native-ave-architecture.md) 与 [原生迁移计划](demo/11-native-migration-plan.md)，本仓库已完成 R0–R5 原生化收敛：不再携带 Paseo、Pi 或 FilmCraft 的源码、包依赖或宿主进程（历史 Paseo 形态归档于 Git 分支/标签 `legacy/paseo-based` / `legacy-paseo-based`）。

## 目录结构

```text
apps/
  desktop/             Electron 主进程与 preload（sandbox + contextIsolation + nodeIntegration:false）
  web/                 React 桌面编辑工作台 UI
  mobile/              Expo Android 远程监督端（配对/预览/审批/取消/校验下载）
packages/
  contracts/           AVE wire schema（63 个 video.v1.* RPC）、分块字节帧与错误码
  domain/              有理数时间模型、EditGraph、审批哈希、对象编辑六态状态机与主体授权
  protocol/            WebSocket 消息信封与二进制帧编解码
  client-sdk/          类型化 AVE Client SDK、重连、afterSeq 事件补拉与 get_mutation_result 对账
services/
  daemon/              唯一项目事实源、授权中间件、任务调度、FFmpeg 确定性后端与方法注册表
  planner-worker/      原生 AVE 规划 Worker（JSONL stdio IPC、strict JSON Schema、17 受控工具）
  media-worker/        Python 媒体内核（SamplingMap、镜头/人像检测、SAM2/VACE 掩码与保护合成）
  relay/               可选远期 E2EE 密文转发边界说明（首版直连不依赖）
storage/
  sqlite/              单 SQLite WAL 数据库 + 事务协调器 + 5 Repositories + 旧版只读迁移工具
  cas/                 SHA-256 内容寻址存储与分块上传暂存
conformance/
  r0-baseline/         冻结的 196 条契约 fixtures、基线规格与 4 个黄金媒体样本生成器
```

## 快速构建与验证

前置环境：Node.js 22+（内置 `node:sqlite`）、Python 3.11+（`pytest`、`numpy`、`Pillow`）、`ffmpeg`、`ffprobe`。本原生仓库可直接独立构建，无需恢复任何外部参考仓库。

浏览器端到端测试使用 Chromium。安装依赖后可运行 `npx playwright-core install chromium`，或将 `AVE_TEST_CHROMIUM` 指向已有的 Chromium 可执行文件。

```bash
npm install --offline --no-audit --no-fund --legacy-peer-deps
node apps/web/scripts/build.mjs
npm run typecheck
npm test
pytest services/media-worker/tests
python3 scripts/check_native_boundaries.py
python3 scripts/check_native_rpc_surface.py
python3 conformance/r0-baseline/verify_r0_baseline.py
python3 scripts/check_project.py
```

### 旧版项目迁移（只读导出 → 隔离导入）

严禁旧版与原生版共享同一数据库或 CAS 目录。迁移旧版 `video-editor` 项目使用只读清单工具：

```bash
node scripts/migrate_legacy_project.mjs export --legacy-dir /path/to/legacy --out ./migration.json
node scripts/migrate_legacy_project.mjs import --manifest ./migration.json --legacy-cas /path/to/legacy/cas --target-home ~/.ave
```

## 文档入口

- [架构图 SVG](ARCHITECTURE.svg) · [团队分工与实时统计 SVG](DIVISION.svg)
- [ADR 012：原生 AVE 架构](docs/adr/0012-native-ave-architecture.md) · [R0–R5 迁移计划](demo/11-native-migration-plan.md)
- [设计总览](demo.md) · [路线图](ROADMAP.md) · [调研证据](findings.md) · [执行记录](progress.md)
