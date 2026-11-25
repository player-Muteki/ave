# K 实施执行记录

本文件只记录产品实施与实测，不修改 M0 调研记录。

## 2026-11-25 · M1 启动

- [x] 等 FilmCraft 调研 Phase 14 完成：根提交 `21c2892` 与统计提交 `8a6954c`，18 份 Markdown、2 份 SVG 和三个锁定参考校验通过。
- [x] 完整阅读产品、架构、Agent、媒体、远程、接口、交付与风险规划。
- [x] 精读 Pi SDK/ResourceLoader、Paseo 插件/协议/权限/测试/构建、FilmCraft Session/CLI/control/export、VACE 推理入口。
- [x] 在 `vendor/paseo` 建立独立 `k/video-editor` downstream；原 `paseo/`、`pi/`、`filmcraft/` 保持只读。
- [x] 使用 `npm --prefix vendor/paseo ci --ignore-scripts` 安装锁定依赖。
- [x] 确认 Node 22 自带 SQLite 3.51.2 可用，FFmpeg 8.0.1 有 libx264/AAC/NVENC，GPU 为 RTX 5060 Laptop 8 GiB。
- [x] 建立 ADR 0001 和 `plugins/video-editor/shared/contracts/v1.ts` 第一版共享契约。
- [x] 实现 daemon 独占 SQLite/CAS、项目授权、幂等审批和持久 Job：`packages/server/src/server/video/`。
- **M1 单段裁剪的本地交付链路**：隔离 daemon 的 `editor.e2e.test.ts` 现已覆盖二进制上传 → preview 审批 → 预览 → 独立 final 审批 → 源尺寸候选 → 独立 export 审批 → 分块下载成品及 manifest。每次均验证用途错误/已消费的 grant 被拒。测试下载成品后重新完整解码：320×180 H.264、30 帧、1 秒；AAC 48 kHz 时间轴 48000 ticks；两流从 PTS 0 开始。逐块校验、下载总 hash、final candidate hash、QA 关联和源 hash 均通过。审批由测试客户端提交，不是人工画质验收。
- 当前 `store.test.ts` 3/3、上述端到端用例 1/1，最新 server typecheck、生产构建、产物 JS 临时库 smoke 与 21 文件 lint 通过。普通插件 API 回归 7/7 在前一版已通过。
- 修复生产构建的 TS6059：单独从原位共享 schema 编译到 server 包内，生产运行使用包内模块。server typecheck、生产 build、变更范围 lint（21 文件，0 警告/错误）通过；直接加载产出的 JS，在全新临时目录启动 editor 并创建 SQLite 项目成功。不是安装包测试。
- 异步 store 工厂已用于启动/恢复测试；普通插件权限表和运行时与 upstream HEAD 一致。当前预览 profile 只开放单段 FFmpeg trim；FilmCraft、多段和其它未验证操作不能作为已支持功能。受限设备专用远程入口尚未开放。
- E06 独立媒体基线：`python3 -I scripts/check_media_timebase.py` 已通过。合成 19 帧 VFR（40/80 ms）、非零首 PTS（2 s）、双 PCM 音轨与 1 条字幕；FFmpeg stream copy 保留逐包时间和内容以及完整解码 A/V 哈希。重置 PTS 的副本虽有相同解码哈希，时间比较仍能识别；丢失第二音轨的副本也被区分。临时素材不入库，此结果不覆盖 daemon、FilmCraft 或生成 Worker。
- 预览时长回归：25 fps 原片的 `[0.120, 1.400)` 恰为 32 帧；旧预览强制 30 fps 后实测视频 38 帧、19/15 秒，音频仍为 32/25 秒。去掉强制重采样、预览编码采用滤镜时基，独立 FFmpeg 对照得到逐帧 PTS `i/25`、视频与音频均为 1.280 秒、首 PTS 均为零，完整解码且原文件 SHA-256 未变。`scripts/check_media_timebase.py` 新旧对照均通过，未放宽输出时长 QA。已在 `editor.e2e.test.ts` 增加 25 fps 用例并保留 30 fps；浏览器验收改回上述原始区间。媒体实现与 daemon E2E 文件 lint 通过，本轮 daemon 25 fps 用例和 server typecheck 在执行前被拦截，独立 FFmpeg 探针不替代产品或浏览器验收。
- 镜头边界：`plugins/video-editor/worker/shot_index.py` 的输入是连续解码的 BGR 图与各自源 PTS/duration；检测器延迟返回的帧序号仅用作查找键，镜头区间用源 tick，不用平均 FPS 推算。`scripts/check_scene_cuts.py` 配固定 PySceneDetect `a696070d`，准备了硬切、无切点及重复 PTS 用例。独立 FFmpeg 全片解码实测验收原片为 19 帧纯黑、18 帧纯白，40/80 ms 相邻间隔，首 PTS 2 s，首白帧（序号 19）PTS 3.040 s，末帧结束 3.960 s。专用 Python 3.14 环境中安装了 OpenCV headless 4.13.0.92 和 NumPy 2.4.4；执行真实检测器的命令被权限模式拦截。以上切点是样片真值，不是检测器预测；未接入 daemon 调度或 SAM2。
- E06 导入：新写入的 `video.presentation-index/v2` 关联源 SHA-256、流时基与 stream_index，逐帧保留十进制整数 PTS 与探测时长。独立 6 帧 VFR 样本首 PTS 2 s、步长 40/80 ms、帧 duration 均为 40 ms。`editor.e2e.test.ts` 已验证两个相邻超大 tick 可区分，并从实际导入的 3 秒 CFR 素材读回 CAS 索引，核对源哈希、流时基、90 帧和首末 PTS；未验收 VFR 成品导出。
- W1 可移植契约：从 Zod 源生成 `plugins/video-editor/shared/contracts/v1.schema.json`，39 个 JSON Schema 定义，重新生成内容一致。TypeScript/Zod 和不联网的 Python/jsonschema 对相同 14 个正反样例全部通过；覆盖零分母、浮点时间、超大序号、非法审批值和两种 Job 形状。不是全版本兼容认证。
- 上传重放：`create_upload` 同一声明返回原 ID；`commit_upload` 把素材、项目修订、提交回执和删除上传记录放进一个 SQLite 事务。成功后同一请求重放返回原素材，不推进项目或事件；修改哈希或 requestId 被拒。`upload.test.ts` 2/2：重开后续传；真实媒体在 ffprobe 不可用时保留已确认源字节，重开后完成提交，再次重开且禁用 ffprobe 时仍返回原回执。相同字节导入两个项目共享 CAS 原片，各有独立素材 ID 与名称，不能从项目 A 用 B 的 ID 读取。更新后的真实 WS/媒体 E2E 3/3、server typecheck 及相关 lint 均通过。测试覆盖成功后重发，未实际切断网络、强杀 daemon 或模拟断电。
- 只读设备回环 WS：owner 兑换并授予项目 A；viewer 只能读 A 的最小摘要，读取 B、修改项目和普通插件调用被拒；撤销后原连接再次读取及重新连接均被拒。首次验收在握手超时，原因是视频连接没有普通 Session，普通回复分派丢弃了 `server_info`。已改为仅向当前视频 socket 定向发送受限回包，未放宽普通 Session 出站检查。移除诊断标记后 `editor.e2e.test.ts` 3/3 通过（大整数精度、真实媒体交付、设备只读用例），server typecheck、相关 lint 通过。仍仅是回环连接，非手机独立配对或 protected relay。
- 桌面工作台（Chrome 隔离宿主）：已实测打开测试客户端导入的原片、输入入出点、提交提案。项目持久化了半开区间，仅生成 pending preview 审批，未创建 Job。增加批准按钮后，真实点击未创建 Job；已观察到点击落在页面而不是按钮，尚未区分滚动、遮挡或驱动定位。用例已增加受信点击目标、控件矩形、视口及滚动容器诊断；本轮定向 Vitest 被执行权限拦截，没有新的浏览器结果。server 与插件 typecheck、两个改动文件 lint 均通过；server `npm run build` 通过，产出的 `builtin-plugins/video-editor/client/edit-desk.tsx` 与源码逐字节一致。不是 Electron 或安装包验收。
- 内置工作台发现：先前只把插件目录复制进 server 产物，生产 `builtinPlugins` 未列入 `video-editor`，测试宿主直接编译客户端入口掩盖了缺口。现已注册内置 ID 并提供必需的服务端入口，不重复注册视频 RPC。定向 `plugins/builtin/index.test.ts` 的真实回环 daemon 目录用例通过（1 passed、4 skipped）：禁用用户插件、无目录安装，客户端仍收到非空的 `video-editor` bundle，用户插件列表为空。Chrome 宿主改为从 daemon 目录获取 bundle 并校验 hash，不再直接编译客户端文件。目录通过不等于 Electron/Chrome 已显示界面；本次 lint 被拦截，未重启主 daemon。
- 拒绝预览：工作台展示操作数及审批摘要，拒绝分支仅发送 `decision=reject`，重新读取项目后展示已拒绝的方案，不调用创建 Job。新增 `store.test.ts` 覆盖重开 SQLite 后重放同一拒绝、无 grant、无 Job、迟到批准被拒且快照不再变化；Chrome 用例也增加了独立拒绝路径。定向 store 用例在启动前被权限模式拦截，没有本轮行为通过记录。
- Job 取消：旧版生产 JS 的临时 SQLite 探针复现了等待审片时取消不一致：首次及重放的 seq 都为 8，重开后行状态是 `cancelled`，唯一事件却是 `cancel_requested`。现将无 Worker 的取消终态、事件、outbox 与命令回执放入同一事务；监督器只对首次应用的命令 abort/enqueue。`job-events.test.ts` 改为检查事件 payload、命令响应及同请求重放后的事件全量；`job-supervisor.test.ts` 新增重复 retry 不启动第二个 Worker 的用例。修订后 server typecheck 通过一次，lint 报出的两个遮蔽变量已重命名；最终 lint/typecheck 复查和两个单文件行为用例被权限模式拦截。尚未据此关闭缺陷，未实测强杀或迁移旧事件。
- 工作台选片导入（实现已写，未通过界面验收）：web 工作台分为“选择本机视频”和“导入所选视频”两步，单文件上限 64 MiB；上传使用原片及分块 SHA-256，只发送字节，不传本机路径。工作台保留当前选择时，重试从 daemon 已确认的偏移继续；提交回包丢失时重放同一提交。`writeUploadChunkRpc.input` 修正为真实的二进制帧，帧内 JSON 头与线上协议不变。`upload.test.ts` 增加分别丢失写块确认和提交回包的用例；FFmpeg 独立生成的测试原片为 386956 字节、H.264 + PCM，跨越 262144 字节边界。本轮导入集成用例和插件 typecheck 均在执行前被拦截，没有通过记录。浏览器用例拆分为空项目从界面导入、预置素材后审批两项，不能用后者替前者验收。早先生产构建不包含这次导入改动。
- 选片取消审查：旧实现等待隐藏文件控件的 `change`，当用户取消且没有 `change` 时，`perform` 不会释放工作台忙锁。现用工作台自身的可见文件控件，仅选择文件不会调用 RPC，也不持有忙锁；只有点击“导入所选视频”才开始传输。Chrome 导入用例增加了选中后、提交前项目素材仍为空且 revision 不变的断言。本次 lint 未获执行；尚无真浏览器取消文件框或本次导入用例通过的证据。
- 候选文件短读：旧 CAS 分块读取忽略 Node 的 `bytesRead`，提前 EOF 可能返回补零字节。独立 Node 临时文件对照实际请求两字节，只读到一字节，缓冲区为 `6500`，下次读取返回零。现按实际读取量推进，未到声明区间末端却遇到 EOF 时抛 `ARTIFACT_HASH_MISMATCH`。新增 `cas.test.ts` 分别检查合法的最后短块和磁盘文件截断；定向用例在执行前被拦截，Node 对照不代替产品测试。
- 工作台审片（待实机）：已接入源素材无声代理与等待审阅的 preview 候选播放器。原有分块读取接口对 `:candidate` 逐次校验项目、Job 类型/状态、候选 revision 和 artifact 身份，不读取 final 候选。播放器限定 64 MiB MP4，匹配分块偏移、长度、revision、分块哈希和整片哈希后才创建本机播放 URL，关闭时释放。新增 `review-bytes.test.ts` 的两块成功样本和三种损坏/错版样本；daemon 用例覆盖 final 候选不能从预览路径读取，Chrome 用例检查候选解码元数据 640×360、1280 ms、final 审批仍待定。新增分块单测和 lint 未获执行，没有新的浏览器/daemon 实测结果，不能据此称审片已验收。
- [ ] 手机与 relay 上的 viewer/operator 授权、取消/暂停终态事件和 daemon/Worker 故障矩阵。
- W2 Pi 本地探针：在独立进程加载 `fcc33744` 的真实 SDK 源码，未使用 `pi/` 里与源码不一致的历史 dist。依赖装在 `references/pi-sdk-probe`，模型目录数据按该提交的 SHA-256 pin 验证；原 `pi/` 工作树干净。`scripts/check-video-planner.mjs` 实测启动及 reload 后 active/callable/all 三组工具均仅有 5 个视频工具，项目上下文标记未进入 prompt，经 IPC 从真实 daemon 领域服务取得 SQLite 项目快照。未调用模型、未实测 OS 级沙箱。
- `tool-broker.test.ts` 在真实 SQLite/CAS 上通过：拒绝跨项目、身份注入、通用命令及审批/创建 Job；校验不落库，重复提交只形成一个 proposed plan 和一个 pending 审批，Jobs 为空。当前 schema 已增加到 40 个定义，生成一致性、14 条 Python fixtures、server 构建/typecheck 和本轮 lint 均通过。
- 成品渲染审批（未通过界面验收）：工作台在对应预览候选旁展示版本、内容哈希及单独的“批准渲染成品候选”。按钮核对审批、授权与项目绑定，仅创建 final Job，不发送 export 决策。Chrome 用例新增播放后 final 仍 pending、单独点击后 final 等待交付审批且 export 仍 pending 的断言。内置插件和 server typecheck 通过；本轮 Chrome 用例及两文件 lint 在启动前被权限模式拦截。未验收成品审片或导出下载界面。
- Linux 桌面打包核查：实际主入口 `packages/desktop/dist/main.js` 和 renderer `packages/app/dist/index.html` 均不存在，根 `node_modules/electron/dist/electron` 也未找到。server dist 的生产注册表含 `video-editor`，外置插件输入存在，但本次工作台改动后 `client/edit-desk.tsx` 的源码与 dist 副本已不同。主进程编译及插件双 bundle 对照均未获执行；没有创建安装包或启动桌面窗口。
- 已交付文件的工作台下载（未实机验收）：仅完成的 export Job 显示成品及清单入口。点击准备后按 artifact revision 读取，分别限定 MP4 / JSON 和 64 MiB，逐块及整片 SHA-256 校验后提供保存链接；关闭时撤销 Blob URL。此路径不批准导出，也不读取未交付的 final 候选。本轮内置插件 typecheck 通过；新增的两个交付读取用例及相关 lint 在启动前被拦截。尚无 Chrome/Electron 将文件保存到磁盘的结果。
- 候选音轨 QA：独立生成并全片解码三个 1 秒、两路流的真实 MP4（正常 AAC 48 kHz、第二视频流替代音轨、AAC 44.1 kHz）。三者均满足旧版流数量、视频尺寸和精确时间检查。`video/media.ts` 的候选检查新增对照源音轨数、已知声道数及 AAC/48 kHz 编码要求。`editor.e2e.test.ts` 添加实际媒体对照；两文件 lint 0 警告/错误。本轮 Vitest 及 server typecheck 在启动前被拦截，未据此认定新版生产 QA 已通过。
- 解码阶段的任务控制：源码审查发现旧 `decodeAll` 将 FFmpeg 的所有错误转为 `ok:false`，调用方再统一报 `QA_FAILED`，丢掉暂停/取消依赖的 `CANCELLED`。现从 CAS 引用启动全片解码，保留真实错误类型，已取消的任务在启动子进程前退出。新增 `job-supervisor.test.ts` 用例区分坏文件、预先取消和解码中的暂停/取消；定向 Vitest 和本次 lint 均在启动前被拦截，尚无修订后状态行为通过记录。本轮还尝试在独立临时目录仅导出离线 Electron renderer；权限模式在 Expo 启动前拦截，未生成可验收的页面。
- 局部编辑的编码前保护区合成：已核对固定版 VACE 的白色生成/黑色保留语义及其二值化代码。`worker/protected_composite.py` 在同尺寸、已对齐的 RGB24 工作帧上使用独立批准区域和 8 位羽化权重；非零权重越出批准区域即拒绝。`python3 -I scripts/check_protected_composite.py` 实跑通过：4 帧中故意让候选改变每个像素，2592 个保护像素逐通道与源一致，完全编辑区和 128/255 羽化边缘符合独立计算，无损 FFV1 全片回读一致且源 hash 未变；尺寸错误及越界权重负例均被拒。同参数 H.264/yuv420p 基线对照也已实测：此样片保护区解码后的 RGB 通道绝对差均值 5.131/255，最大 221/255；没有用这个样片设定通用画质阈值。以上不含 SAM2/VACE 推理、色彩转换或 daemon 调度。
- 源帧到模型工作帧的时间映射：`worker/sampling_map.py` 根据源 PTS、duration 和有理数时基按半开区间采样；v2 索引读取入口校验索引字节摘要、源 hash、流和帧范围。`python3 -I scripts/check_sampling_map.py` 实跑通过：2 s 起点、8 个 VFR 帧得到 9 个 25 Hz 样本，源序号 1 采样两次；FFV1 工作副本的逐帧 PTS、时长和全片 RGB 回读一致。重复采样结果不能隐式绑回源轴；丢帧、偏移一 tick、尾帧时长错误、源帧间隙及索引绑定错误均被拒。1:1 对照保留超过 2^53 的相邻源 tick。v2 索引样本由实测 ffprobe 结果构造，未通过 daemon 提交 Job、调用模型或导出 VFR 成品。
- VFR 成品的 daemon 验收用例：`editor.e2e.test.ts` 在原有上传、三次独立审批和成品分块下载流程上增加 VFR 样片。校验源索引、预览及下载成品的每个视频 PTS，而不仅是帧数/总时长。独立 FFmpeg 对照实测：25 Hz 网格删去序号 5 后，1 s 半开裁剪的 preview/final 均保留 24 帧，0.160 s 后下一帧是 0.240 s；两条编码路径时长均为 1 s。本轮 server typecheck 和定向 lint 通过，VFR 定向 Vitest 在启动前被权限模式拦截，未观察到实际 daemon 交付这份样片。
- 成品审片与交付：工作台可请求由 final 候选派生的 640×360 代理，导出审批记录绑定候选哈希、代理和 QA；播放不交付，用户需单独批准。新增 Chrome 下载回读、成品 hash 与解码断言。五文件 lint 已通过；本轮 Chrome 和类型检查在启动前被策略拦截，未观察到最终界面验收。
- 接续实测：服务端类型检查通过。真实 daemon 上的 `editor.e2e.test.ts` 与 `job-supervisor.test.ts` 共 14 个用例通过，覆盖 VFR 成品交付、音轨 QA 和解码任务控制。独立 Chrome 上的 `edit-desk.browser.e2e.test.ts` 三个场景通过，包含本机文件选择、拒绝预览和完整审片交付。成品审片代理实际播放后，导出审批仍为 pending。单独批准导出后，从工作台下载的 MP4 完整解码为 160×90、32 帧 H.264 和 48 kHz AAC，两流从零开始，均长 1.28 秒。源文件哈希保持一致，成品哈希等于审批绑定值。浏览器下载的 JSON 清单与该审批、版本、方案及成品哈希一致。
- Linux x86_64 开发包：使用锁定的 Electron 44.2.0、Paseo 桌面主进程、生产 renderer 和重新构建的 daemon 生成 `packages/desktop/release/Paseo-x86_64.AppImage`，SHA-256 为 `bfbb59f128bdbeb31f8c29a03b96d5f0a12f1e94d1101ced7119b98e5a1bea9f`。Metro 默认配置在转换 11 MiB 的协议校验模块时耗尽 Node 堆；在 app 目录以 `NODE_OPTIONS=--max-old-space-size=6144 PASEO_WEB_PLATFORM=electron EXPO_OFFLINE=1 npx --no-install expo export --platform web --max-workers 1` 完成 production export。解包后的插件工作台与根仓库源码逐字节相同。在独立 Xvfb 中从 AppImage 以 `--appimage-extract-and-run` 启动，包内 CLI 冷启动、真实窗口的 renderer/preload、桌面启动的 daemon、内置插件及终端回读全部通过。此开发包使用上游 Paseo 名称和更新源；包内视频编辑全流程、干净机器上的媒体依赖、更新和签名仍待验证。
- 手机/relay 设备通道授权（代码已写，未运行）：隔离设备通道从「loopback 只读摘要」升级为按角色分发 `video.v1` RPC。`websocket-server.ts` 允许 relay transport 携带 `videoDevice` 凭据接入（direct 仍限 loopback，producer/插件 socket 拒绝）；viewer 报 `["video.read"]`、operator 报 `["video.read","video.write"]`；`plugin.rpc.invoke.request`（pluginId=video-editor）经 `EditorRpcService.invoke` 走与桌面会话相同的角色/项目授权，二进制输出按 hello 的 `plugin_binary_payloads` 能力以 `encodePluginOutputFrame` 发送，完成时重查 `activePrincipal`。`access.ts` 新增 `onRevoke` 监听，撤销即时关闭对应 reader socket；`authorization.ts` 把 `read_asset_chunk` 纳入 viewer 可读方法（store 仍校验项目范围、候选版本与待审状态）。客户端 `daemon-client.ts` 允许 videoDevice 走 relay URL。`editor.e2e.test.ts` 更新 viewer 拒绝断言为真实角色错误，并新增 operator 审批/控制可达、设备管理仍拒的用例。本轮按用户指示优先写代码，未运行 Vitest/typecheck/lint，未据此认定授权矩阵已通过；relay 真机路径未验收。
- 包内剪辑复验：上述开发包能启动 daemon，但首屏渲染遇到 React #130。恢复上游安装补丁后，首屏加载；随后真实插件宿主报告入口缺少清理回调。视频插件现返回屏幕及侧栏项的注销函数，桌面启动测试也从侧栏进入工作台检查项目输入框。修复包 SHA-256 为 `22e3091d77e57c5dd0d41609b73a4854d024c172cc1fd7b546efadd304a36d75`。从 AppImage 的 Electron 窗口创建项目、导入 320×180 的 25 fps 带音轨素材、裁剪 0.120–1.400 秒、播放两级审片代理并单独批准导出。窗口下载的 MP4 全片解码通过，视频为 32 帧 H.264，AAC 为 48 kHz、61440 ticks，音视频均从零开始并持续 1.28 秒。成品 SHA-256 `4662347b604c09d1ec9b4706ff276ab4a1dd3c2e02c1cebd556a8165c7c15eeb` 与成品审批及下载的 JSON 清单一致。此验收使用本机 FFmpeg，通过 AppImage 解包运行模式执行。
- E07 实测：新增单对象 SAM2.1 镜头跟踪内核，按帧接收正负点提示，为每个镜头初始化 state，从最早提示帧双向传播，并输出源尺寸的 0/255 掩码。RTX 5060 Laptop、PyTorch 2.13.0+cu130、BF16；Tiny 和 Small 均跑过同一段 320×192、9 fps、18 帧 FFV1 视频。两镜头之间重新选对象，第一个镜头有局部遮挡并在第 6 帧追加点。与逐像素标注比较，Tiny 最低 IoU 为 0.9833，Small 为 0.9666。每个配置重建两个镜头的 state 并重放提示，18 帧掩码均与本配置首次结果逐像素一致。两镜头首次跟踪各耗时 0.826/0.557 秒（Tiny）和 0.844/0.656 秒（Small），PyTorch 峰值 allocated 分别为 599/626 MiB；这些是本次小样片的单次值。原片 SHA-256 保持不变，PNG 掩码回读及审片叠色视频完整解码通过。自然视频、完整遮挡后的重现、daemon 调度、MaskRevision 审批与 VACE 生成仍待验收。[复验脚本](scripts/check_sam2_shot.py)
- E07 自然视频复验：`check_sam2_shot.py --bedroom` 读取固定上游示例的前 32 帧，按官方 notebook 在第 0 帧先点短裤，再点上衣。Tiny 的首帧前景面积从 2,181 增至 16,234 像素，第二个点击位置从背景变为前景。第 0、15、31 帧的叠图可见修正掩码跟随左侧人物的衣服及可见身体；首帧部分裸露腿脚未覆盖。重建跟踪状态、按顺序重放两次点选后，32 张二值掩码均逐像素一致。示例未提供真值，此项记录点击修正、传播及重放行为。
- E08 已接入固定版本 VACE 1.3B 的离线单镜头实验入口。它读取 E07 的源片与 SAM2 掩码，按两个独立约束（跟踪对象与样片指定的可编辑区域）生成 832×480 输入，并把候选裁回源网格。CPU 上的横竖画幅、边距、掩码极性回归通过。在独立纯蓝候选对照中，18 帧成品全片解码通过；编码前 1,073,516 个保护像素与源片一致，导出音轨解码后与 no-op 对照一致。RTX 5060 Laptop GPU 上已生成平移遮挡样片和自然卧室靠枕样片。两者均完成 20 步采样、逐帧 PTS 校验和全片解码；视觉阶段分别用时 59.53 s 和 61.34 s，显存峰值均为 5.04 GiB。[实测报告](research/e08-vace.md)。[画幅回归](scripts/check_vace_canvas.py) · [E08 复验脚本](scripts/check_vace_shot.py)
- [ ] 面向用户的生产 agent-worker 监督、真实模型调用、共享桌面/Android UI、打包与真实生成模型验收。
- 已实现待验收（2026-11-25，未跑真实模型/e2e）：独立 agent-worker 进程与守护 IPC——`packages/server/src/server/video/agent/`（`ipc.ts` JSONL 协议、`prompt.ts` 固定签名系统提示、`tools.ts` 封闭 5 件白名单工具、`session.ts` 锁定 ResourceLoader + `createAgentSession`、`worker-main.ts` 子进程入口、`controller.ts` 守护端 AgentRunController：每 run 一个子进程、事件经 store 持久化、重启 reconcile 标记 interrupted 不盲重放）。RPC 新增 `video.v1.start|steer|follow_up|stop|get_planning_run`（operator+，viewer 只读 `get_planning_run`），契约 v1 追加 4 个 schema 且 `v1.schema.json` 已重新生成（纯增量）。客户端 `edit-desk.tsx` 新增 Agent 规划面板（开始/继续/停止 + 事件流）。依赖新增 `@earendil-works/pi-coding-agent@1.5.2`（pin 见 `research/upstream.json` 的 `fcc33744`）。
- 已实现待验收（2026-11-25，分析链路已本地冒烟，未跑 daemon e2e）：`video.v1.analyze_asset`（operator+，viewer 不可写）创建免审批的 `analysis` Job（按 asset+源 hash 幂等去重），`media.executeAnalysisJob` 校验源 hash 后读取 CAS 内不可变 presentation-index，经 `py-worker.ts` 调用新增的 `worker/daemon_cli.py`（`support` 能力探测 + `sampling-map`，纯 JSON stdio、`-I` 隔离运行、超时/abort 收口），结果以 `qa` artifact 写回 CAS 并落 Job 完成态。契约新增 `AnalyzeAssetInputSchema`、`JobSnapshot.analysisAssetId?`，`v1.schema.json` 重生成（纯增量 45 defs）。客户端素材卡片新增「分析采样」按钮。`daemon_cli.py` 冒烟：4 帧 25fps 索引采样为 4 个样本 identity 映射，篡改 source hash 被拒（rc=1）。
- 已实现待验收（2026-11-25，多段拼接已用本机 FFmpeg 按相同 filter_complex 实跑验证）：preview profile 放开为"同一素材同一视频流的连续多段 trim"（record 区间从 0 密铺、禁止重定时/跨素材/其他操作类型），render 改为每段一个 -i + trim/setpts + concat，checkCandidate 按各段 record 时长求和校验；本机实测 2 段 1s 拼接输出 2.000s/50 帧/音频 2.000s 全解码无错，VFR 源 likewise 连续。客户端新增「删除中段并拼接」（proposeCutOut 生成两个连续 trim op）。
- 已实现待验收（2026-11-25，联系表管线已用固定 FFmpeg 实跑验证）：planner 白名单扩展到 7 件（新增 get_contact_sheet 有界元数据、get_qa_report 只读 QA artifact 引用，像素永不入 prompt）；新增 RPC `video.v1.contact_sheet`（operator+），media.contactSheet 按 presentation index 均匀取序号、select 精确取帧、tile 拼接写入 CAS，几何校验 width/height 必须等于网格；契约新增 ContactSheetRequest/Result、ArtifactRef kind+contact，schema bundle 重生成（47 defs）。本机实测 12 格 4x3 输出 1280x540 mjpeg。客户端素材卡片新增「生成联系表」。
- 已实现待验收（2026-11-25，烧录链路已用固定 FFmpeg 实跑验证）：preview profile 放开 burn-in 字幕（≤64 条、mode=metadata 仍拒），render 在 concat/scale 之后用临时 SRT + subtitles 滤镜烧录（cue range 落在输出时间线）；本机实测 2 段拼接 + 烧录输出 2.000s 全解码无错。客户端 proposeCut 支持可选字幕，UI 新增字幕文本/起止字段。注意：沙箱无 fontconfig 字体时 ffmpeg 会告警，生产环境需装字体包。
- 已实现待验收（2026-11-25，增益链路已用固定 FFmpeg 实跑验证）：preview profile 放开同素材 audioOperations（≤64，仅 gainMilli/mute），render 在每段 atrim 后按 clipId 追加 volume=<mB/1000>dB（mute 为 -inf）；本机实测 -6dB 烧录后 volumedetect 生效、全解码无错。客户端新增音量增益输入。
- 已实现待验收（2026-11-25，跨素材拼接已用固定 FFmpeg 实跑验证）：preview profile 放开跨素材连续 trim（record 仍从 0 密铺、禁重定时），render 改为每段各自 -i（来自该 op 的 asset CAS 路径），几何不符时按首段归一化，视频/音频分别 concat；checkCandidate 按"1 video + 有音频则 1 audio"校验流数。本机实测 asset A[0.5-1.5s] + asset B[0-1s] → 2.000s/50 帧 640x360 全解码无错。
- 已实现待验收（2026-11-25）：export manifest 追加 segments（opId/assetId/hash/streamUid/source+record 区间）、subtitleCues、audioOperations 清单，交付溯源完整；客户端新增 proposeConcat + 「拼接：选中片段 + 首个素材全程」按钮（跨素材连续拼接提案）。
- 已实现待验收（2026-11-25，已随分支 rebase 合入最新 main）：在 main 的音频塑形（audioProfile/anullsrc/settb 时钟）之上叠加——每片段 transform（crop/scale/rotation）、crossfade/fade 转场（xfade/acrossfade）、v2 叠加轨（overlay 合成）、跨素材音频（独立 -i 输入）、planner 新增 get_analysis 工具并把能力清单写进锁定 prompt；checkCandidate 按 v1 轨时长与首段变换后几何校验。各路径均已用本机 FFmpeg 实跑验证（拼接/转场/黑场/缩放/旋转/双轨/音乐 全解码无错）。未跑真模型/e2e。
- 已实现待验收（2026-11-25）：客户端 edit-desk 补充计划操作摘要行（片段/转场/变换/音频/字幕计数）与转场类型切换（叠化/黑场，透传 proposeConcat 的 transitionKind）。未跑真模型/e2e。
- 已实现待验收（2026-11-25）：get_project_snapshot 新增 job 摘要（jobId/kind/state/revision/analysisAssetId，限 64 条），planner 可直接 get_job_status/get_analysis 跟踪；prompt 同步说明。未跑真模型/e2e。
- 已实现待验收（2026-11-25，软字幕 sidecar 已用本机 FFmpeg 实跑验证）：subtitleOperations 支持 mode=metadata（mov_text 软字幕 sidecar 轨），burn-in 仍走录；render 写 SRT 作为额外 -i 映射，checkCandidate 增校 mov_text 流校验（字幕轨自带时钟，不参与时长校验）；prompt 同步。本机实测 2s 视频+aac+mov_text 三轨，软字幕可回转 srt，音视频全解码无错。未跑真模型/e2e。
- 已实现待验收（2026-11-25）：客户端 proposeCut 支持 bgmAssetId（BGM 跘过素材音频，UI 点击循环选择音频素材）。未跑真模型/e2e。
- 已实现待验收（2026-11-25）：转场时长增加整帧对齐验（xfade 按帧贴入，不对齐会导致整体时长 QA），render 在转场前拒绝；合并后全路径本机实测（变换+xfade+overlay+BGM(-6dB)+mov_text）。
- 已实现待验收（2026-11-25）：客户端字幕模式切换（烧录/软字幕 mov_text），proposeCut 增加 subMode 参数。未跑真模型/e2e。
- 已实现待验收（2026-11-25）：agent tool_execution_start 事件的 payload 携带 tool 名，客户端事件流展示工具名。未跑真模型/e2e。
- 已实现待验收（2026-11-25）：store.validatePlan 增加 CFR 整帧对齐校验（trim 时长与转场时长均必须整帧对齐），提前拒绝 PLAN_SEMANTIC_INVALID；prompt 同步。未跑真模型/e2e。
- 已实现待验收（2026-11-25）：素材卡片显示该素材最新 analysis job 状态及 qa 是否已生成。未跑真模型/e2e。
- 已实现待验收（2026-11-25）：preview profile 增加字幕 cue 非负且不超过 v1 输出时长的校验。未跑真模型/e2e。
- 已实现待验收（2026-11-25）：export manifest 血缘补充 trackId/transitions/transforms/跨素材音频完整源信息；preview profile 实测 12 项正/反案用例全 PASS。未跑真模型/e2e。

## 环境与错误

| 问题 | 处理 |
| --- | --- |
| 首次 `npm ci` 在根会话目录执行，因无 lockfile 失败 | 改用 `npm --prefix vendor/paseo ci`，已安装成功；未生成根依赖文件 |
| SAM2/VACE/PySceneDetect 的 blob:none 检出多次遇到 HTTP/2 EOF | 保留原检出；使用固定 commit 源码归档逐 blob 核对 Git 对象后，在 `references/sam2-verified`（`2b90b9f5`，569 项）和 `references/pyscenedetect-verified`（`a696070d`，220 项）恢复独立工作树。两者状态干净，已禁止联网验证 `git archive HEAD`；结论仅限固定提交，不涵盖全部历史对象或运行时。已读 ContentDetector 的相邻帧加权打分与 AdaptiveDetector 的延迟返回逻辑；切点应使用返回的目标时码，不能使用回调当前帧。 |
| FilmCraft 固定提交的源码与构建 | 原只读克隆 `ba6fe105` 的 1263 个唯一 blob 在离线审计时缺 947 个。已从同一提交的公开归档恢复 `references/filmcraft-verified/`，逐路径核对 Git blob ID 与可执行位，独立读回复验 1265 个文件，无缺失或额外文件。归档 SHA-256 `7d46e64cd6df247deb4c592403852ef2367ed5a4192aba0de8a0b1789e8a7883`。这是完整源码快照，不含 Git 历史；原克隆未改动。Cargo.lock 的整个工作区含 826 个包，745 个 registry 条目有校验和，另外有 4 个 Git 来源/修订组合；不是 CLI 实际链接组件清单。隔离执行 `cargo build --locked -p filmcraft-cli --no-default-features` 在启动前被权限模式拦截，无 CLI 二进制或媒体符合性验收。 |
| Android SDK、Xvfb、系统签名工具未预装 | 后续在隔离目录安装并实测；Linux/浏览器结果不替代 Android/Windows/macOS 验收 |

## 2026-11-25 · 集成回归（62bffe6）

- 隔离工作树中的 `src/server/video` 实跑 10 套、33/33 通过（含 3 个 Chrome 场景）。上次失败的 30 fps 逐帧时间戳、撤销 viewer 后断连、无目标 analysis 错误三项均通过；25 fps CFR/VFR、工作台审片和下载仍通过。根仓库 downstream 文件与测试副本逐字节一致。
- 范围不含真实模型、Android 真机或后续 96b741b 的跨素材音频/字幕功能。

## 2026-11-25 · 跨素材交付回归（1b87e06）

- 集成 `96b741b` 后，在隔离工作树运行完整 `src/server/video` 回归：10 个文件，34/34 通过，含 3 个 Chrome 工作台场景。新增 `silent then tone` 走真实 daemon、两次素材导入、独立审批、渲染、下载和清单核对；下载 MP4 的 PCM 检查验证第一秒静音、第二秒起始窗口有声。本轮不作为真机、模型效果或安装包验收。

## 2026-11-25 · 规划 Worker 生命周期

- 修复前用真实 Pi SDK 子进程复现：收到 hello 后发送 SIGTERM，进程退出码 0，独立临时目录仍残留。修复后显式 dispose、父进程 stdin 关闭、SIGTERM 三种路径都观察到同一 PID 完成 hello 并退出，工作目录已清除。开发模式直接启动 Node，不再通过 npx 间接监督。
- SQLite/控制器回归验证同请求回执相同、握手前停止不产生媒体 Job、重开数据库可将遗留运行标记 interrupted。真实视频与浏览器全量 11 文件、38/38 通过，server 类型检查通过。无 API 密钥、无真实模型请求，此记录不是自然语言生成剪辑方案的验收。
