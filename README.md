# ave — Agentic Video Editor

本地优先、跨平台的 Agent 视频编辑工作台设计。桌面端完成导入、编辑、生成、预览和导出；Android 连接同一桌面 daemon，负责远程会话、审批、监控和交付。

> **[下载 AVE v0.1.0 桌面 Demo](https://github.com/player-Muteki/ave/releases/tag/v0.1.0)**，提供 macOS、Windows x64 和 Linux x64 未签名安装包。Windows 已测环境为 Windows Server 2025，Windows 11 未实测。发布页附安装说明、模型配置与测试素材。[实施与验证记录](implementation-progress.md) · [原始需求](research/demo.original.md)

## 恢复实现工作树

根仓库的 `downstream/paseo/` 收录相对锁定上游的全部新增和修改文件，不是指向本机提交的 gitlink。在全新克隆的根目录中执行以下命令；已有开发工作树时不要覆盖：

```bash
test ! -e vendor/paseo && (
  git clone --no-checkout https://github.com/getpaseo/paseo.git vendor/paseo &&
  git -C vendor/paseo checkout --detach c626bf37071491981fc8e11c3e2f4df093381d37 &&
  cp -R downstream/paseo/. vendor/paseo/
)
```

上游许可证随覆盖目录保留。依赖、参考检出、素材、权重和安装包不入库。

在 `vendor/paseo` 运行 `npm ci` 安装锁定依赖。已有依赖若是用 `--ignore-scripts` 安装的，请在同一目录先运行 `npm run postinstall`，再导出桌面 renderer。首屏的 `SheetHostScope` 依赖该步骤为 `@gorhom/bottom-sheet` 补齐的导出。

## 文档入口

从 [`demo.md`](demo.md) 开始。设计拆分为产品与验收、总体架构、Agent Runtime、媒体流水线、客户端与远程、接口契约、团队并行、测试发布、风险与实验九份文档。

- [总体架构 SVG](ARCHITECTURE.svg)
- [团队分工与实时统计 SVG](DIVISION.svg)
- [调研证据](findings.md)
- [执行与验证记录](progress.md)
- [路线图](ROADMAP.md)
- [贡献与并行开发规则](CONTRIBUTING.md)

## 本地初始化

要求：Git、Python 3.10+。文档和统计脚本没有第三方 Python 依赖。

```bash
# 根仓库已包含文档；恢复三个锁定版本的上游参考仓库。
python3 scripts/bootstrap_references.py --restore

# 启用提交前校验。
git config core.hooksPath .githooks

# 校验文档、链接、SVG、团队数据和统计图。
python3 scripts/check_project.py
```

`pi/`、`paseo/`、`filmcraft/` 是可复现的**只读参考 checkout**，版本由 [`research/upstream.json`](research/upstream.json) 锁定，不直接纳入当前 M0 根仓库。M1 实现 Paseo 内置插件前，先记录 ADR、建立团队可访问的 Paseo downstream fork，再由根 superproject 用精确 gitlink 管理；Pi 和 FilmCraft 默认保持上游只读。这样不会把嵌套仓库误提交成空目录，也不会产生两套不可追踪的上游改动。

FilmCraft 作为候选确定性编辑后端，与 FFmpeg 共用 EditGraph/命令契约；其原生 MCP、TCP 控制和 egui 不进入生产控制面。详见 [媒体后端路由](demo/04-media-pipeline.md#21-filmcraft-适配器与后端路由) 和 [E13 验收](demo/09-risks-research.md#2-必做实验)。`upstream.json` 的 `sparseCheckout` 仅用于轻量源码调研，不是可构建的完整源码包；E13 构建/验收需完整源码与依赖。

## 分工图与统计

成员职责和里程碑状态维护在 [`research/team.json`](research/team.json)。提交数、有效代码行和 SVG 由脚本从当前 Git 历史生成：

```bash
python3 scripts/update_division.py
python3 scripts/update_division.py --check
```

- **进度**：已完成工作流数 / 分配给该成员的工作流数；不能由代码行推导。
- **提交数**：当前分支可达的非合并、非 `chore(stats):` 提交，按 `research/team.json` 中的 Git 作者名或邮箱匹配。
- **有效代码数**：该快照中仍存活、经 `git blame` 归属的非空非注释源码行；含测试源码，排除文档、生成物、锁文件、依赖和参考仓库。对根仓库交付的 `downstream/paseo/`，与 `research/upstream.json` 固定的 Paseo 提交逐文件比较：新文件按根仓库 blame，已有文件只计新增/修改行，不把随文件复制的上游行归给导入者。运行统计前需按上节恢复 `paseo/`；不读取本地 `vendor/paseo/` 的未提交改动。M1 若根仓库以 `vendor/paseo` gitlink 管理 downstream，脚本会同时聚合该已初始化且 HEAD 与 gitlink 一致的 fork 的提交和 blame；未初始化或指针不一致时不计入。
- 提交功能改动后重新生成图，再以 `chore(stats): refresh division` 单独提交；统计提交不重复计数，避免自引用导致永远无法稳定。
- L、J、C 开始提交前必须补全各自 Git `names` / `emails`，否则只显示人工里程碑，不会冒领他人提交。

## 当前仓库结构

```text
demo.md                     # 设计入口
ARCHITECTURE.svg            # 架构图
DIVISION.svg                # 自动生成的团队图，禁止手改
demo/                       # 九份可执行设计文档
research/                   # 原始需求、上游锁、团队数据
scripts/                    # 参考仓库、统计与项目校验
.githooks/                  # 本地提交门
.github/workflows/          # 文档与统计 CI
findings.md                 # 一手资料与设计依据
task_plan.md / progress.md  # 执行状态和验证边界
```

M1 的目标实现位于 Paseo downstream fork：`plugins/video-editor/shared/contracts`（契约）、`plugins/video-editor/server`（daemon）、`plugins/video-editor/client`（共享/桌面/Android UI）、`services/generation-worker`（Python 模型 Worker），以及 Paseo 既有 desktop/app 测试和发布目录。路径只有出现真实实现时才创建，不用空目录或伪脚本冒充进度。
