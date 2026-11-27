# FilmCraft 升级审查：ba6fe105 → 7b8e522d

2026-11-27。**更新研究锁，不启用产品后端。** 新旧提交都自报 `0.20.1`，但媒体依赖、工程路径和导出实现都已改变。新版目前只有源码审查，没有构建或真实媒体验收。

| 对象 | 证据及适用范围 |
|---|---|
| 旧锁 `ba6fe10529c7bf5d2a9283f9de2e35c0ccff926c` | [旧版 E13](e13-filmcraft.md) 在 Linux headless CLI 双跑：单段 CFR trim/H.264+AAC 和纯音频导出达标；VFR 时间保真、字幕与多音轨透传不达标。结果仍属于这个构建。 |
| 新锁 `7b8e522d63f2e2c1617dea4939feb48e769d6f2f` | 审查时上游 `main` 与本机干净 checkout 一致；以[清单](upstream.json)的完整 SHA 为准。稀疏检出用于读源码，不等于完整构建。 |
| AVE 产品 | [daemon 能力表](../downstream/paseo/packages/server/src/server/video/rpc.ts)返回 FilmCraft `available: false`；[预览校验](../downstream/paseo/packages/server/src/server/video/preview-profile.ts)拒绝选择该后端。本次不改此行为，FFmpeg 继续承担确定性编辑。 |

## 上游端点差异与本地处置

在含两个提交对象与相应文件内容的 FilmCraft 检出中，从 AVE 根目录复算：

```sh
old=ba6fe10529c7bf5d2a9283f9de2e35c0ccff926c
new=7b8e522d63f2e2c1617dea4939feb48e769d6f2f
git -C filmcraft diff --shortstat "$old" "$new"
git -C filmcraft diff --shortstat "$old" "$new" -- '*.rs'
git -C filmcraft diff --shortstat "$old" "$new" -- crates/ui-egui
git -C filmcraft log --first-parent --oneline "$old..$new"
```

两棵树间净变更 **398 个文件，+25,248 / −8,221 行**；其中 286 个是 Rust 文件（含测试），225 个变更位于 `crates/ui-egui`，二者有重叠。`main` 第一父链从旧锁到新锁有 20 步。端点树差不是 PR 补丁行数的累加，也不依赖当前稀疏工作目录中有哪些文件。

| 变化 | 对 AVE 的决定 |
|---|---|
| [Cargo.toml](https://github.com/storytold/filmcraft/blob/7b8e522d63f2e2c1617dea4939feb48e769d6f2f/Cargo.toml) / [Cargo.lock](https://github.com/storytold/filmcraft/blob/7b8e522d63f2e2c1617dea4939feb48e769d6f2f/Cargo.lock)：主 `craft-libs` 从 `33be3562` 升至 `a4db7995`，`craft-fcproj-format` 保持 `3af2280e`；egui fork 从 `6d518fc7` 升至 `f5025284`，锁文件新增 VectorCraft 来源。顶层双许可证不变，[署名清单](https://github.com/storytold/filmcraft/blob/7b8e522d63f2e2c1617dea4939feb48e769d6f2f/ATTRIBUTION.md)增加剧本窗口截图与 nightly 图标等。 | 正式锁更新主依赖 pin。按源码和构建摘要区分两版；若将来分发 CLI，再按目标平台、启用的 features 和实际资源生成 SBOM/NOTICE，不把整个 workspace 等同于安装包。 |
| [工程路径](https://github.com/storytold/filmcraft/blob/7b8e522d63f2e2c1617dea4939feb48e769d6f2f/crates/engine/src/doc_path.rs)保存时可将素材与代理路径改写为能解析回同一文件的相对路径，打开时按工程位置恢复；[重连处理](https://github.com/storytold/filmcraft/blob/7b8e522d63f2e2c1617dea4939feb48e769d6f2f/crates/engine/src/relink.rs)亦有变化。相对路径可含 `..`。 | 工程更易搬迁，但 `.fcproj` 不是授权凭据。仍从 daemon 授权的资产生成私有工程；以最终解析出的文件核对素材映射，不以是否相对路径作许可判断。 |
| [导出任务](https://github.com/storytold/filmcraft/blob/7b8e522d63f2e2c1617dea4939feb48e769d6f2f/crates/engine/src/export_tools.rs)改用[独立线程池](https://github.com/storytold/filmcraft/blob/7b8e522d63f2e2c1617dea4939feb48e769d6f2f/crates/export/src/run.rs)；[响度处理](https://github.com/storytold/filmcraft/blob/7b8e522d63f2e2c1617dea4939feb48e769d6f2f/crates/export/src/audio_out.rs)可将混音写入 [MixStore](https://github.com/storytold/filmcraft/blob/7b8e522d63f2e2c1617dea4939feb48e769d6f2f/crates/export/src/mix_store.rs)，后续遍次回读。临时目录未指定时可选系统临时目录，正常释放时删除文件。 | 增加响度样本和异常退出测试；不能从普通 trim 或正常释放推断取消、崩溃、磁盘不足时的结果。上游任务成功不等于 AVE 可发布。 |
| [控制桥](https://github.com/storytold/filmcraft/blob/7b8e522d63f2e2c1617dea4939feb48e769d6f2f/crates/automation/src/bridge.rs)细分断连、错误协议与响应 ID 不符；[CLI](https://github.com/storytold/filmcraft/blob/7b8e522d63f2e2c1617dea4939feb48e769d6f2f/apps/filmcraft-cli/src/main.rs)明确拒绝桌面 Launcher 的 `--launch-profile`、`--profile-root`。 | 适配探针继续用 headless CLI，不从桌面启动参数推断 CLI 隔离能力；原生 MCP/TCP 不进入生产。 |
| 新增[剧本实体](https://github.com/storytold/filmcraft/blob/7b8e522d63f2e2c1617dea4939feb48e769d6f2f/crates/project/src/script.rs)，示波器计算移到[后台线程](https://github.com/storytold/filmcraft/blob/7b8e522d63f2e2c1617dea4939feb48e769d6f2f/crates/ui-egui/src/scope_worker.rs)，另有播放、导出预览及 nightly 打包改动。[VA-API](https://github.com/storytold/filmcraft/blob/7b8e522d63f2e2c1617dea4939feb48e769d6f2f/crates/platform/src/vaapi/va.rs)可导出 DMABUF，但合成器侧导入尚未实现。 | 不移植 egui 工作台或引入第二套工程状态；不能据此声明 AVE 具有端到端零拷贝、GPU 加速或三桌面发布能力。 |

## AVE 修缮顺序与验收条件

**文档已对齐。** [总览](../demo.md)、[架构](../demo/02-architecture.md)和 [ADR 011 / E13](../demo/09-risks-research.md)将当前锁、旧 CLI 结果和产品状态分开。以下是后续代码工作，**本次不实施**：

1. **先解决“测的是哪一个 CLI”。** [E13 探针](../scripts/check_filmcraft_e13.py)核对 checkout HEAD，但 `--cli` 可指向任意二进制。在独立、干净、完整的新 SHA 源码树运行 `cargo build --locked -p filmcraft-cli`；构建时记录源码 SHA、Cargo.lock 和 CLI 的 SHA-256、构建参数与工具版本；探针在执行前校验该记录。**验收：**换入同为 `0.20.1` 的旧 CLI 必须失败，不得产出新版 PASS。
2. **再解决“样本究竟保留了什么”。** E13 的 `media_failures()` 已断言 CFR 帧数和音频参数，但末尾的 VFR/多轨结论是固定文字。借用 [E06 的 `measure()` 与负对照](../scripts/check_media_timebase.py)记录有理数时间戳、轨道数与类型、字幕 cue 和源 hash；对 trim 按裁剪范围核对期望时间线，不要求有损重编码字节相同。保留 FFmpeg 对照和逐流完整解码，报告输入/产物 hash、实际编码器和警告。**验收：**刻意移时或丢第二音轨能被识别；未测、保真、归一化和丢流由实测结果区分，不能只看退出码。
3. **最后决定能否接入。** 在授权工作区搬迁和重连素材/代理，应仍指向同一授权资产；解析到授权范围之外的引用须拒绝。用真正启用响度处理的素材测试独立任务目录、磁盘不足、并发、取消及强杀重启：不得发布半成品、混用另一 attempt 的结果，遗留临时音频须能清理。缺素材即使能渲染占位也不得交付。新版 CLI 重跑 CFR/音频、VFR、多流/字幕、kill/restart、离线矩阵后单独落档，不能改写旧 E13。**产品门：**现有[预览拒绝测试](../downstream/paseo/packages/server/src/server/video/preview-profile.test.ts)和[真实 daemon 能力测试](../downstream/paseo/packages/server/src/server/video/editor.e2e.test.ts)保持原预期。将来如拟开放某个组合，再按[验收矩阵](../demo/08-delivery.md)补适配、契约和集成测试；Linux CLI 的结果不外推至桌面包或 Android。
