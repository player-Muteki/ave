# 07 · 团队分工与并行开发

[返回总览](../demo.md) · [贡献规范](../CONTRIBUTING.md) · [交付路线](08-delivery.md)

## 1. 分工图

[![K、L、J、C 团队分工与实时进度](../DIVISION.svg)](../DIVISION.svg)

[打开 DIVISION.svg](../DIVISION.svg) · [编辑团队源数据](../research/team.json) · [更新脚本](../scripts/update_division.py)

所有成员只使用代号。Git 统计按各自配置的 author name/email 归属，不根据当前拉取仓库的人推断身份。

## 2. 责任矩阵

| 成员 | 主责 | 独占工作包 | 必须协作/评审 |
| --- | --- | --- | --- |
| K | 总体架构、后端、跨端集成 | ADR、contracts、Agent Runtime、Plan/Approval、根 CI 与发布决策 | L 评审后端；契约至少再由 J/C 一方评审 |
| L | 后端与媒体 Worker | JobRunner、SQLite/CAS、FFmpeg、SAM2/VACE、QA、资源基准 | K 评审契约；C 验证预览/导出；远程时 J/C 联调 |
| J | Android 与远程控制 | mobile UI、配对/relay 测试、Android native、APK 和真机证据 | C 共同拥有共享远程协议；K/L 评审 API |
| C | 桌面与远程控制 | Electron、共享视图模型、桌面时间线/mask/导出、三桌面安装包 | J 共同远程联调；L 验证媒体；K 评审集成 |

远程控制不是 J、C 各写一套协议：daemon 只有一份 RPC/权限实现，J 负责移动传输和生命周期，C 负责桌面宿主和共享 UI，双方共同完成双端联调。

## 3. 目标代码所有权

M1 建立 Paseo downstream fork 后，目标路径如下；当前尚未创建，不代表已有实现。

| 路径 | 写入 owner | 说明 |
| --- | --- | --- |
| `plugins/video-editor/shared/contracts/**` | K | Zod、JSON Schema、fixtures、capability 和兼容测试 |
| `plugins/video-editor/server/agent/**`、`pi-extension/**` | K | agent-worker、封闭 ResourceLoader、工具与事件 |
| `plugins/video-editor/server/jobs/**`、`storage/**` | K + L | 状态机、审批、SQLite/outbox、恢复 |
| `plugins/video-editor/server/media/**` | L | Asset、TimeMap、FFmpeg、合成、导出、QA |
| `services/generation-worker/**` | L | Python SAM2/VACE、lease、checkpoint、资源指标 |
| `plugins/video-editor/client/core/**` | C | 共享远程视图模型；J 评审移动行为 |
| `plugins/video-editor/client/desktop/**`、`packages/desktop/**` | C | Electron、编辑器、安装包和 updater |
| `plugins/video-editor/client/mobile/**`、Android native/e2e | J | 移动监督、权限、配对、APK 和真机测试 |
| 根 `demo/**`、ADR、上游锁和发布决策 | K | 各 owner 更新所属模块事实和验证边界 |

上游 `pi/`、`paseo/` 当前是只读参考。不得在开发机 dirty checkout 中直接积累产品代码；M1 将 Paseo fork 以 gitlink 纳入后，所有权才落到上述真实路径。

## 4. 工作包与依赖

| ID | 工作包 | Owner | 前置依赖 | 交付证据 |
| --- | --- | --- | --- | --- |
| W0 | 需求、架构、分工和工程基线 | K | 无 | 本文档、SVG、校验脚本 |
| W1 | Zod/JSON Schema、fixtures、FakeVideoService conformance | K | W0 | v1 contract PR、双向兼容测试 |
| W2 | Pi SDK 封闭工具与 structured Plan 探针 | K | W1 初版 | 禁用工具证明、strict model 矩阵、崩溃点报告 |
| W3 | Paseo 插件、SQLite/CAS、JobRunner、FFmpeg/FilmCraft 探针 | L | W1 初版 | 真实插件/DB/两后端小样本对照、kill/restart 报告 |
| W4 | 桌面项目/时间线/审批/预览 | C | W1 fake；真实集成验收另需 W3 | fake UI 初验 + 真实 daemon Playwright + Electron 截图/视频 |
| W5 | Android 会话/进度/审批/下载 | J | W1 fake；真实集成验收另需 W3 | fake/emulator 仅作开发证据；M4/M10 必须真机 |
| W6 | 确定性桌面端到端 | K + L + C | W2、W3、W4 | 三 OS 导入→审批→编辑→导出，源 hash 不变 |
| W7 | 远程权限、配对、弱网、双客户端 | J + C | W4、W5、daemon API | viewer 越权、重连、重复/过期审批测试 |
| W8 | SAM2/VACE 短镜头与 QA | L | W3、媒体契约 | 实际输出视频、资源/质量报告、失败样例 |
| W9 | 生成预览桌面集成 | C + L | W4、W8 | mask/锚帧/候选/QA 的真实界面 |
| W10 | Android 完整远程版 | J + C | W6、W7 | 真机控制真实任务，杀 App 不影响 Job |
| W11 | 发布候选 | K + L + J + C | 对应平台全部功能门 | 安装包、签名、SBOM、升级和 roll-forward |

## 5. 并行方式

### Gate A：契约先合并

W1 至少定义 capabilities、project、plan、approval、job、artifact、events、upload/download、cancel。所有 mutation 带 `requestId + expectedRevision`，actor/role 来自认证上下文。

同一 PR 包含 TS 类型、生成 JSON Schema、golden fixtures、重复/过期/未知字段测试，以及 fake 与 server 共用 conformance。此后 fake 只用于开发，最终 E2E 必须真实。

### Gate B：四条切片并行

Gate A 的初版契约合并后，W2–W5 可以并行做最小探针与 fake 驱动开发，不要求先把整个 M1 做完。K/L 的上游探针结论汇总为 M1 ADR；C/J 的真实 daemon 集成验收仍分别依赖 W3。

- K：固定样例 Plan → Pi structured submit → 审批防伪。
- L：同样例 Plan → SQLite Job → FilmCraft/FFmpeg 对照导出 → 恢复。
- C：FakeVideoService → 桌面项目、预览、审批、导出 UI。
- J：同一 fake → Android 列表、进度、审批、断线重连。

任何 wire 变化回到同一 contract PR，不允许在个人分支私改字段后让其他端适配。

### Gate C：真实集成

契约 → daemon/Worker → 桌面/Android → 双端联调 → 生成能力 → 发布。功能通过 capability flag 逐步开放；未验证后端只返回 unavailable，不以 fake 填充发布链路。

## 6. 日常协作规则

1. 短分支、小 PR；每日同步最新 main，冲突由契约 owner 和受影响端共同解决。
2. 开始任务把 `research/team.json` 状态改为 `in_progress`；完成必须有 `evidence`，阻塞必须写明原因和解除条件。
3. PR 按 [模板](../.github/PULL_REQUEST_TEMPLATE.md) 给命令、输出、截图/视频、日志、平台覆盖和未验证项。
4. 跨端 PR 需要 K/L + J/C 对应 owner；模型与媒体由 L、桌面由 C、Android 由 J 验收。
5. 不允许删测试、缩窄样本、伪进度、静态图冒充视频来通过门。
6. GitHub 账号确定后，将责任矩阵映射成真实 CODEOWNERS 和分支保护；当前不伪造账号。

## 7. 分工图实时更新

源数据是 [`research/team.json`](../research/team.json)，执行：

```bash
python3 scripts/update_division.py
python3 scripts/update_division.py --check
```

统计口径：

- **工作情况/进度**：workstream 的 `status` 和完成数；状态只能由证据改变。
- **提交数**：按 Git 作者名或邮箱匹配成员 identities 的非合并、非 `chore(stats):` 提交。
- **有效代码数**：最新非统计快照中仍存活、git blame 归属的非空非注释源码行；含测试，排除文档、锁文件、生成物、依赖和参考仓库。当前根仓库的 `downstream/paseo/` 统计相对锁定 Paseo 基线的新增/修改行，再按根仓库 blame 归属，不把复制的上游原文计给导入者。M1 的 `vendor/paseo` gitlink 初始化且 HEAD 一致时，脚本会聚合 downstream fork 的提交和源码，因此 J/C/L 的产品活动不会只显示根文档仓库数据。

功能提交后单独以 `chore(stats): refresh division` 提交 SVG。统计提交不重复计数，避免图记录自身造成无限变化。提交数和代码行只表示活动，不用于排名、绩效或完成度。

K、L、J、C 分别维护自己的 Git identities；同一成员使用多个 Git 邮箱时全部加入该成员配置，不能修改他人映射或把当前克隆者当成固定成员。
