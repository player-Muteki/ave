# 04 · 媒体、生成模型、Worker 与 QA

[返回总览](../demo.md) · [接口](06-interfaces.md) · [实验与风险](09-risks-research.md)

## 1. 核心原则

内部事实源是**版本化 EditGraph + Revision**；FilmCraft `.fcproj`、FFmpeg filtergraph、OTIO、EDL、VACE 输入和导出视频都是派生产物。任何生成模型只返回候选视觉资产，不能直接覆盖时间线或声称已保留音频、字幕、VFR、HDR 和附件。

执行顺序固定为：

`源资产 → presentation index → EditGraph/镜头 → 工作副本与 SamplingMap → mask/锚帧 → 生成候选 → 保护区合成 → 音频/字幕重接 → 编码 → QA → 人工批准`

## 2. 任务路由

| 操作 | 执行器 | 约束与降级 |
| --- | --- | --- |
| trim、concat、gap、crop、scale、rotate、显式变速、基础调色/音量 | EditGraph → FilmCraft 或 FFmpeg | 无 GPU；按 capability 与素材矩阵选后端；时间、流、实际 encoder 和色彩策略显式记录 |
| 字幕/转写辅助理解 | 独立音轨/cue timeline、转写 adapter | 无音轨或转写失败不阻塞纯画面编辑 |
| 对象点选、跟踪与修正 | SAM2.1 + 人工修正 | 每镜头独立 state；跨硬切重置 |
| 无新语义物体移除 | 独立补全后端，经许可和质量基准选择 | 未配置商业可用后端时能力不可用；ProPainter 只作非商业研究 |
| 局部重绘、对象替换、参考图驱动 | Wan2.1-VACE-1.3B MV2V | 480p 短段实验；保存 raw mask 和预处理输入 |
| 首/尾帧续写、全镜头重绘 | VACE frameref/R2V/T2V，显式高成本 | 不承诺任意中间锚帧严格满足 |
| 长镜头 | 时间段 DAG + overlap + 边界 QA | 不一次输入任意长视频；分段不冒充全局一致性 |
| 音频生成、配音、音乐 | 独立后端接口 | 不属于首版 VACE 能力 |
| 自动 HDR 生成、任意 VFR 直接输入、多稀疏关键帧严格一致 | 实验项 | 未验收前拒绝或转人工 |

### 2.1 FilmCraft 适配器与后端路由

FilmCraft 的 command-first、整数时基、copy-on-write 项目、CPU/GPU 渲染、代理、调色、音频和交换格式有复用价值；它仍是 alpha，因此不是替代所有 FFmpeg 工作的前提。

| 操作/素材 | 优先探针 | 约束 |
| --- | --- | --- |
| CFR、单视频/音频流的 trim/concat/crop/transform | FilmCraft | 与 FFmpeg 对照帧数、时间、画面、声音；全通过才标 capability |
| 效果、曲线调色、音频 mixing/响度、代理 | FilmCraft | 预览/最终一致性、CPU/GPU 对照、实际资源与 encoder |
| VFR 保留、多音轨/字幕/章节/附件、特殊封装、生成回合成 | FFmpeg/现有 Worker | FilmCraft 未证明完整映射前不宣称支持 |
| ffprobe、独立全片解码/PTS/音画 QA | FFmpeg/ffprobe | 不信任后端自报成功；输出 `offlineMedia` 非空即失败 |

每个 capability key 是 `(operation, codec/container, timeTopology, streams, color, resolution, backendVersion)`；不存在笼统的 `filmcraftSupported: true`。编译期间由白名单映射生成命令，不接受模型/客户端指定任意 command ID。

FilmCraft 的 254016000000 ticks/s 通过 `ticks = round(rationalSeconds × 254016000000)` 在边界换算，记录 rounding/frame snap；内部 Rational、原始 presentation index 和 SamplingMap 不变。整段执行前固定 `backendId + backendVersion + engineSnapshotHash`，输出 manifest 保存实际 encoder、warnings 和映射。若任何节点不能无损表达，整个对应执行计划拒绝，不靠丢流或重采样凑成功。

## 3. EditGraph 与时间模型

### 3.1 有理数和 presentation index

持久时间统一使用 `{ num: string, den: string }`，分母为正；区间是半开 `[start, start + duration)`。大整数用十进制字符串，禁止 JS 二进制浮点秒和 `seconds * avg_frame_rate` 作为执行事实。

导入时保存：

- packet DTS/PTS 用于诊断；
- 解码后的 presentation PTS、duration、time_base、关键帧索引用于查找和合成；
- 流稳定 `streamUid`、色彩、旋转、SAR、音频 sample clock 和字幕 cue；
- proxy→source、model sample→source 的双向 SamplingMap。

VFR 转模型 CFR 工作副本是显式预处理。生成结果帧数/时长不符合 SamplingMap 时默认失败，不能用一次 `setpts=PTS-STARTPTS` 隐藏错误。只有时间拓扑未改变的结果可重新绑定原 PTS；插帧、抽帧和变速必须是独立 EditOperation。

### 3.2 Clip、TimeMap 与流策略

每个 Clip 记录：不可变源/生成节点、`sourceRange`、`recordRange`、TimeMap、effects、audioPolicy、subtitlePolicy、colorPolicy。TimeMap 由分段 `outputRange + sourceStart + rate` 组成，并绑定源 presentation index 或生成 SamplingMap hash。

音频拥有独立 sample-clock：trim、offset、gain、crossfade、resample、channel layout 和期望输出 sample 数。视频 cut 派生对应音频段；显式处理 encoder delay/padding 和尾部，不使用 `-shortest` 修补同步。

字幕保留 cue ID、语言、样式、起止时间和源映射。多音轨、字幕、章节、附件、disposition 全部显式 `-map`；容器不兼容时失败或要求用户选择转码/烧录，不静默丢弃。

### 3.3 OTIO/EDL 的定位

OTIO 可作为交换导出，`ExternalReference` 指向只读资产 URI，生成参数、CAS 和 mask lineage 放命名空间 metadata + sidecar manifest。CMX3600 不支持本项目的全部多轨/effects/复杂 speed 语义，只作有损 interchange；重新导入必须新建 Revision 并显示 diff。

## 4. Proxy、CAS 与 mask lineage

### 4.1 内容寻址

所有 BlobRef 含 `sha256/bytes/mediaType`。写入采用临时文件 → 完整 flush/hash 校验 → 原子 rename；输出文件自身 hash 与派生缓存键不同。Job lease 和 Revision pin 住引用，GC 只回收未 pin 对象。

缓存键包含：

`schema + canonical op/params + sorted input hashes + PTS-map hash + mask lineage root + model/weights/runtime digest + color/time policy + seed`

相同 seed 不承诺跨 GPU bitwise 一致；不同运行环境 digest 不共享“确定一致”的缓存结论。

### 4.2 MaskRevision 与 DerivedMask

原始多对象/二值 mask 永久保留，包含：

- `maskRevisionId/parentIds/shotId/objectId`；
- 源 presentation index hash、尺寸、旋转、SAR 坐标空间；
- 点击/框选/人工修正事件；
- 引擎版本、权重 digest、rawLabelMask、审批人。

union、dilate、feather、resize、VACE 灰化/白黑化和采样丢帧都生成 DerivedMask，不覆盖人工修正。VACE 预处理后的 mask 必须与模型工作视频同形状、同采样映射。

## 5. SAM2 交互跟踪

每个镜头创建独立 `SAM2VideoPredictor` state。持久检查点保存源帧索引、prompts/correction log、模型 digest 和已输出 mask；`inference_state` 中的帧、对象映射和 memory features 视为易失执行上下文。

首版不序列化整个 predictor 字典作为稳定跨版本格式。崩溃后从 prompts/corrections 重放或重跑该镜头；最后一张 mask 不能被称为完整跟踪状态。遮挡、出画/重现、身份切换或镜头边界要求用户追加提示或拆分。

## 6. VACE 短镜头节点

### 6.1 输入与输出事实

- `src_video`：保留区为真实像素，待生成区灰值 127。
- `src_mask`：白色生成、黑色保留，与工作视频形状一致。
- `src_ref_images`：已审批参考图，不等于任意数量关键帧的硬约束。
- Wan 默认 81 帧且要求 `4n+1`；官方长视频策略是约 5 秒分段和 `firstclip` 延续。
- 官方脚本写无声 `out_video.mp4` 及预处理输入；没有源音频/字幕/时间线合成。

### 6.2 执行步骤

1. 固定 `approvedRevisionHash`，按源 PTS 切镜头，生成源帧↔模型样本映射。
2. 转到固定 SDR/BT.709、尺寸和 CFR；保存全部转换参数与 hash。
3. 执行 SAM2 prompts/corrections，形成已审批 MaskRevision，再派生 VACE mask。
4. 提交原 prompt、已审批参考图、seed、steps、frame_num、sample_fps 和预处理资产。
5. 保存 VACE 输出、实际输入、stdout/stderr、代码/权重/runtime digest 和资源指标。
6. 用 ffprobe 实测输出帧数/fps/时长，不能采用请求值作为结果事实。
7. 依据 SamplingMap 放回时间线；局部编辑在编码前从确定性源渲染恢复保护区，feather 明确属于编辑区。
8. 从 EditGraph 重接音频/字幕，完成色彩与编码，运行 clip + 全片 QA；人工批准后才生成新 Revision。

### 6.3 失败回退

`诊断同参数失败 → 有限的新 seed → 缩小语义/编辑区域（需新审批）→ 缩短段并增加已审批锚点 → 首/尾帧分段 → 确定性替代或人工`

每次回退产生新 Revision 和原因码。禁止静默丢 mask/锚帧、自动扩大区域、源片冒充生成、Agent 降低 QA 或沿用旧审批。

## 7. Worker 执行、取消与恢复

Scheduler 独占 SQLite 状态迁移，Worker 只接收 TaskLease。`WorkerHello` 声明协议、操作白名单、模型 digest、设备、最大已验证尺寸/帧数和 FFmpeg build hash；Scheduler 不分配未声明能力。

每次 lease 增加 `leaseEpoch`，心跳只续租不证明结果正确。progress 以 `seq` 去重；complete/checkpoint 至少一次投递，daemon 幂等提交并拒绝 stale epoch。Worker 输出先进入临时 CAS，daemon 验证 hash/manifest/approvedRevisionHash 后在一个 DB 事务中提交节点和 artifact。

| 阶段 | 恢复点 | 不承诺 |
| --- | --- | --- |
| probe/proxy/镜头 | 不可变派生 artifact | 写回源片 |
| SAM2 | prompts/corrections + 已输出 mask | 完整 memory state 可移植 |
| 关键帧 | 已审批图像与参数 | 未审批图进入最终版 |
| VACE preprocess | src_video/src_mask/ref_images | 预处理等于生成完成 |
| VACE sampling | 完整短镜头输出 | mid-diffusion checkpoint |
| 合成/编码 | 原子短 clip、最终完整输出 | 任意 GOP/filter 内部续跑 |
| QA | 绑定 subject hash 的报告 | 旧 Revision 报告复用 |

取消先写 `cancel_requested`，发送带 epoch 的取消，grace period 后终止独立进程组。首版 VACE 未完成短镜头从头重跑；“暂停”是释放 Worker 并重新排队，不是冻结 CUDA 上下文。

## 7.1 确定性分析与渲染配方（FFmpeg 路径，已本地实现）

- 导入即自动跑只读 analysis job（按 asset+hash 去重）：全帧 `lavfi.scene_score` 切点（阈值 0.3、最小间隔 0.5s、≥64 条、按源平均帧率整帧对齐，artifact `video.scene-cuts/v1`）+ 首音轨 8kHz mono PCM 每 100ms RMS 波形（≤120s，artifact `video.waveform/v1`）；Python 采样为 best-effort，无 python 也能完成。
- 渲染时记录 `renderRecipeHash`（完整 ffmpeg argv、临时/输出路径脱敏后 SHA-256），写入 QA 报告与 export manifest；同一方案两次渲染 candidate SHA-256 一致（已实测）。
- `video.v1.preview_frames` 为候选渲染生成 ≤36 格确定性故事板（定时采样+tile，几何经 ffprobe 校验，CAS 内哈希后引用）。
- QA 报告含 `audioLoudness`（volumedetect mean/max dB）、ffmpegBuildHash、probe；QA 失败时错误带 ffmpeg stderr 尾部（800 字符）。

## 8. 色彩与硬件边界

生成 MVP 固定 SDR/BT.709 工作空间。`setparams` 只改标签，真正像素转换用 colorspace 等滤镜。HDR 确定性剪辑、HDR 生成、HDR→SDR tone map 和往返一致性分别验收。

每个平台锁定 FFmpeg/ffprobe 构建，保存 SHA-256、configure、对应源码和第三方许可。运行时探测 buildconf、decoder、encoder、filter、hwaccel 和实际硬件帧路径；硬件失败可软件回退，但不能静默改变 codec、色彩或帧率策略。

## 9. QA 门

| 门 | 机器检查 | 人工/实验检查 |
| --- | --- | --- |
| G0 导入 | hash、probe、流、presentation index、色彩/旋转/SAR、源只读 | 未知/损坏流处理 |
| G1 执行前 | Revision、区间、TimeMap、流映射、mask 坐标/PTS、模型许可/digest、grant | 计划/mask/锚帧审批 |
| G2 生成 clip | 全解码、实际帧数/fps/时长、manifest/hash、空帧、SamplingMap | 语义、身份、关键帧符合度 |
| G3 合成前 | 编码前保护区像素一致、尺寸/色彩一致、段无重叠/遗漏 | 边缘、闪烁、遮挡、跨段持久性 |
| G4 最终文件 | 全片音视频解码、PTS、时长/sample 数、音画偏移、流/字幕/色彩 | 最终观看、唇同步、文字/品牌 |
| G5 发布 | 硬检查通过，报告绑定 output hash/Revision | 生成内容最终批准 |

编码后 mask 外比较使用同 Revision、同编码器、生成 clip 换回源 clip 的 baseline，区分有损编码噪声和真实越界。black/freeze/silence detect 只作有上下文告警。VMAF 只用于同源编码对照，不衡量生成语义。

光流 warp error、邻帧 LPIPS、身份 embedding、VLM 语义和唇同步阈值需要人工标注集标定；未标定前只报告，不自动放行。所有阈值来自统一 `thresholdsVersion`，Worker 不得自带另一套放行标准。

## 10. 资源准入与 MVP

调度估算按设备×模型×分辨率×帧数×steps 建冷/热 benchmark，记录 p50/p95、模型加载、mask、生成、合成、编码、QA、峰值 RAM/VRAM、磁盘和重试。长视频段数为：

$$N_{\text{seg}}=\begin{cases}1,&D\le L\\\left\lceil\frac{D-O}{L-O}\right\rceil,&D>L\end{cases}$$

其中 $L$ 为实测模型段长、$O<L$ 为重叠。VRAM 由权重、文本编码器、activation、临时张量、CUDA context 和 allocator 共同决定，不能由 1.3B 参数量直接推断。磁盘准入包含 pinned、raw、encoded、model temp、final、retry 和 reserve；默认每 GPU 一个生成 Worker。

首版仅实验 Wan2.1-VACE-1.3B、480p、短段、`4n+1`。14B、LTX、I2VEdit、ProPainter 不进入生产依赖；无兼容 GPU 时确定性编辑照常可用，生成能力显示未配置/不兼容。
