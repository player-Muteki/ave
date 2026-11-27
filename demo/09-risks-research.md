# 09 · 风险、许可与实验决策

[返回总览](../demo.md) · [调研证据](../findings.md) · [验收](08-delivery.md)

## 1. ADR 注册表

以下“接受”表示设计决策已确定，不表示代码已验证。实现探针推翻假设时必须写新 ADR  supersede，而不是悄悄改文档。

| ADR | 决策 | 状态 | 重新打开条件 |
| --- | --- | --- | --- |
| 001 | 本地单 daemon + 持久 Job，不做云端多租户 | 接受 | 出现真实多用户/多租户需求 |
| 002 | video-daemon 独占项目、审批和任务状态 | 接受 | 无法避免双写时先改架构，不能 eventual 双事实源 |
| 003 | 独立 agent-worker 使用 Pi SDK，自有 IPC | 接受（待探针） | SDK 无法封闭资源或自有生命周期成本高于收益 |
| 004 | Plan 用 strict structured tool，审批由 daemon | 接受（待 provider 矩阵） | 目标模型均不支持严格 constrained sampling |
| 005 | EditGraph + Rational + SamplingMap 为内部时间事实源 | 接受 | 探针证明无法覆盖 VFR/音频；不得退回浮点秒 |
| 006 | FilmCraft/FFmpeg 可插拔确定性后端；VACE 只负责短镜头生成候选 | 接受（待 benchmark） | FilmCraft conformance 不达标则该操作留在 FFmpeg；VACE 不达标不启用生成 |
| 011 | GUI/Agent 共享 EditCommand，FilmCraft 仅独立后端，不直暴露 MCP/egui | 接受（旧 CLI 的部分样本达标；产品未启用 FilmCraft） | 无法维持单写者、路径限制、时间/媒体保真时退出 FilmCraft |
| 007 | SQLite WAL + CAS + outbox + lease fencing | 接受（待 packaged 探针） | node:sqlite 打包/并发不满足要求，替换 DB 实现而协议不变 |
| 008 | Paseo 内置视频插件 + 独立 Python Worker | 接受（待插件探针） | 内置插件所有权/依赖限制无法承载领域服务 |
| 009 | 根 superproject 管精确上游 commit，各自保留 lockfile | 接受 | M1 fork 和 gitlink 工作流实测失败 |
| 010 | 首版不做 HA；使用隔离、恢复、备份和 roll-forward | 接受 | 可用性需求改变 |

## 2. 必做实验

| 实验 | 问题 | 方法 | 通过/退出条件 |
| --- | --- | --- | --- |
| E01 Pi 封闭性 | 项目资源/MCP/通用工具能否真正不可达 | 恶意项目 + faux model + 启动工具断言 | 任一逃生口可达则阻止生产集成 |
| E02 structured Plan | 各 provider 是否支持 schema/terminate/事件完整结果 | strict require + invalid/duplicate/settle 矩阵 | 不支持模型不进自动规划；无 accepted Plan 不执行 |
| E03 agent-worker 崩溃 | DB/tool result/provider job 各点是否幂等恢复 | kill -9 故障注入 | 无重复计划/扣费，未知结果进入 reconciliation |
| E04 Paseo 插件 | built-in RPC、二进制、进程和打包是否满足 | 最小 video 插件 + 真 daemon/桌面/Android | 不通则调整插件边界，不能绕过权限 |
| E05 SQLite/CAS | 三 OS DB、文件锁、原子 rename、迁移是否可靠 | packaged + 并发/磁盘满/损坏测试 | 不满足则换受支持 DB，协议不变 |
| E06 媒体时间 | VFR、非零 PTS、音轨、字幕和旋转能否正确往返 | 小样本 ffprobe + 全解码 + 人工检查 | 失败组合显式不支持，不静默修正/丢流 |
| E07 SAM2 | 目标镜头交互延迟、遮挡修正和恢复是否可用 | tiny/small 对比 + prompt 重放 | 达不到交互要求则缩小镜头/对象范围 |
| E08 VACE | 1.3B 在目标 GPU 的质量、VRAM、时间和许可 | 固定 corpus/seed/digest，对比 no-op/逐帧/VACE | 无真实输出或质量门不过则不启用生成 |
| E09 跨段一致性 | overlap、首尾帧、锚点策略能否降低漂移 | 运动/遮挡/形变/多人物矩阵 | 仅支持已验证场景，其余转人工 |
| E10 远程传输 | Range/分块、E2EE、弱网和重连是否稳定 | 大文件、断网、relay 重启、双客户端 | 无重复审批，下载 hash 一致，事件可补拉 |
| E11 安装包 | Pi/FFmpeg/Worker 的签名闭包与启动是否正常 | 三桌面最终包 + Android 真机 | 任一平台未验证则该平台不发布 |
| E12 自动 QA | 时序/身份/语义指标是否能作硬门 | 人工标注集标定阈值和误报/漏报 | 未标定只报告，最终人工审批不可移除 |
| E13 FilmCraft 适配 | headless 操作、时间/媒体保真、取消恢复与打包是否可复用 | 固定 commit 构建 CLI；白名单命令与 FFmpeg 双跑 CFR/VFR/多流/音频/字幕样本；kill/restart/离线素材测试 | 仅合格能力开放；双事实源、路径逃逸、占位成功或关键样本不符则不采用该后端 |
| E14 专家窗口 | 派生副本的人工 FilmCraft 精修是否有价值 | 独立项目副本 + token + 显式重导入，检查主 Revision/源 hash | 首版非必需；无法封闭文件/状态边界则不提供 |

2026-11-25 的[旧锁 E13](../research/e13-filmcraft.md)只验证了 `ba6fe105` 的 Linux headless CLI：单段 CFR trim/H.264+AAC 及纯音频导出达标，VFR 时间保真、字幕与多音轨透传不达标。[新锁升级审查](../research/filmcraft-ba6fe105-to-7b8e522d.md)是源码审查，新构建待复验。

## 3. 模型与组件许可

| 组件 | 当前证据 | 发布策略 |
| --- | --- | --- |
| Pi | 本地锁定仓库 MIT | 保留 LICENSE；升级重新审计 |
| Paseo | Apache-2.0，第三方各自许可 | downstream fork 保留 NOTICE/版权与修改说明 |
| FilmCraft | [当前锁](../research/upstream.json)，MIT OR Apache-2.0；新锁增加 nightly 图标等署名项 | 保留 LICENSE/NOTICE/ATTRIBUTION；移除 ArtCraft 品牌，不继承其性能/成熟度声明 |
| Photo/Effect/SoundCraft | 官方分别为 early alpha/alpha/pre-alpha | 首版不打包；未来独立评估各自版本、依赖和命令/文件安全 |
| VACE 代码 | `LICENSE.txt` Apache-2.0 | 固定 commit，审计全部依赖 |
| Wan2.1-VACE 权重 | 模型表指向 Wan Apache-2.0 | 按实际权重 URL/hash 审计，不从代码许可证外推 |
| LTX 版本 | RAIL-M | 不与 Wan 混为同一分发配置，首版排除 |
| SAM2 | 主体 Apache-2.0；可选组件 BSD-3-Clause、demo 字体 OFL | 按实际文件生成 notices |
| ProPainter | NTU S-Lab 非商业限制 | 仅研究 baseline，不进入默认商业发行 |
| I2VEdit | 本次未独立确认许可 | 未确认前禁止默认分发 |
| PySceneDetect | BSD-3-Clause | 保留许可，固定版本 |
| FFmpeg | 默认 LGPL；GPL/nonfree 组件改变义务 | 审核 configure、链接、对应源码、专利和 NOTICE |

发布采用默认拒绝的模型注册表：`id/version/sourceUrl/codeLicense/weightsLicense/commercialUse/redistribution/outputRestrictions/attribution/sha256/modelCard/reviewer`。关键字段 unknown 就阻止自动下载和 release。

FFmpeg 不只写“LGPL”：保存精确来源、hash、完整 buildconf、对应源码和链接方式。`libx264` 是 GPL，`libvmaf_cuda` 官方示例涉及 nonfree；是否采用由发布政策/legal 审批，不能偷偷进入 LGPL-only 包。

## 4. 风险登记

| 风险 | 影响 | 缓解与退出 |
| --- | --- | --- |
| VACE 质量/显存不满足消费级设备 | 核心生成体验无法交付 | 短镜头 benchmark、远程 Worker；不达标只能交付明确标注的确定性基础版，阻断完整 P0/M5 发布 |
| 任意关键帧思路被高估 | 闪烁、身份漂移、跨段不一致 | mask + 时序传播 + 锚点自适应 + 分段 QA；禁止逐帧拼接 |
| SAM2 长遮挡/镜头切换跟丢 | 错误区域被生成 | 每镜头 state、人工修正、prompt 重放；失败转人工 |
| VFR/音画/色彩错误 | 导出不可交付 | Rational、presentation index、独立音频/cue timeline、全片 QA |
| Agent 权限过大/提示注入 | 文件、凭据或费用损失 | 无通用工具、封闭资源、独立 IPC、服务端授权和预算 |
| 远程 daemon-wide grant 越权 | 不可信设备访问其他项目 | 每 RPC 项目/操作校验；workspace 隔离前不接不可信设备 |
| 双客户端重复/过期审批 | 重复生成、覆盖新版本 | requestId、expectedRevision、planHash grant、幂等消费 |
| 崩溃导致重复扣费/半成品 | 数据和成本损失 | outbox、provider reconciliation、lease fencing、CAS 原子提交 |
| 内置插件/Worker 不是沙箱 | 供应链和宿主权限风险 | 默认未知插件禁用、受控依赖、进程隔离、最小 egress |
| 安装包签名闭包变化 | 无法启动或发布 | 最终包 smoke、nested binary 审计、证书和 Gatekeeper 验证 |
| 模型/FFmpeg 许可不完整 | 法律与分发风险 | SBOM/NOTICE/模型注册表默认拒绝，独立升级审查 |
| 上游 API 漂移 | 并行返工 | commit 锁、contract fixtures、独立 bump PR、完整兼容矩阵 |
| FilmCraft alpha 或双事实源 | 丢流、占位导出、覆盖编辑、语义漂移 | 单写者、白名单、E13 对照、offlineMedia 硬失败、私有快照绑定、无静默后端切换 |
| 代码行指标误导团队 | 虚报完成度 | 进度只按有证据 workstream，提交/行数仅活动记录 |

## 5. 隐私与安全实验边界

- 默认不发送素材；任何云端模型、转写或远程 Worker 必须列出上传的镜头、图片、音频、prompt 和目的地。
- 密钥放系统凭据或受限 daemon 配置，不进 prompt、manifest、会话导出、日志或移动端。
- relay TLS 与 E2EE 是两层；设备可撤销，邀请短时一次性。
- 日志/minidump/logcat 也可能含路径或敏感内容，默认本地，诊断分享前列文件并脱敏。
- 非可信文本、字幕、转写和 MCP 内容均视为数据；不得触发系统级指令。

## 6. 未验证声明清单

当前没有运行应用构建、模型、转码、真机或安装包。以下均不得写成事实：VACE 对任意锚帧/mask 外/跨段的严格满足；SAM2 state 可移植；mid-diffusion 恢复；跨 GPU 同 seed 位级一致；生成输出保留 VFR/HDR/音频/字幕；三桌面原生生成性能；硬件零拷贝；自动 QA 通用阈值；OTIO/EDL 无损往返；任何安装包已签名/公证/验收。
