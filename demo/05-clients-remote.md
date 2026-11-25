# 05 · 桌面、Android 与远程控制

[返回总览](../demo.md) · [接口](06-interfaces.md) · [平台验收](08-delivery.md)

## 1. 复用边界

复用 Paseo 的 Expo Router 应用壳、Electron 封装、workspace/agent panels、typed RPC/subscription、daemon 重连、桌面安装包和 Android 构建链。**不复用整文件 file.read 作为媒体协议，不复用 daemon.manage 作为视频权限，不把 plugin subscription 当任务恢复。**

Expo Web/Android 共享 DTO、状态选择器、基础 RN 组件和面板壳，不共享整个编辑器：桌面时间线、DOM/canvas/WebCodecs、键盘和 mask 精修走 `.electron.tsx`/web adapter；Android 使用独立 ProxyPlayer、ApprovalInbox、DecisionSheet。

## 2. 桌面工作台

### 2.1 页面结构

1. **项目/镜头栏**：导入、媒体/后端状态、镜头列表、任务队列和磁盘/GPU 指标。
2. **预览与时间线**：原/结果、并排、帧步进、时间码、音频、mask/锚点叠加、失败区间。
3. **Agent 会话**：消息、工具摘要、计划 diff、候选帧、澄清和审批卡；进度只来自 daemon。
4. **检查器**：操作参数、mask 修正、确定性后端/模型/seed、QA、导出 profile、Revision 历史。

FilmCraft 支持的手动动作（trim、效果、调色、混音等）与 Agent 生成的操作使用同一 command schema、后端路由和 Revision。按钮只提交领域操作，不直接调用 FilmCraft MCP、TCP 或 `filmcraft-cli`；执行结果返回同一 Job/预览/QA 面板。首版不嵌入 FilmCraft egui/WASM 作为第二编辑器，也不让它持有独立 `.fcproj` 主项目。

后续如提供“FilmCraft 专家窗口”，它只编辑当前 Revision 的派生副本，使用本地 token、受限工作区和显式“重导入为新 Revision”；不能绕审批修改主项目、访问原始素材目录或由手机直接控制。

`PluginTab.state` 只保存选中轨道、缩放、滚动和预览模式；Project/EditGraph/Job 永远存 daemon。组件只发 command，不持有任务生命周期。

### 2.2 Electron 适配

- 通过 contextBridge 提供最小文件对话框、通知、外部播放和 daemon 生命周期 API；renderer 保持 `contextIsolation:true`、`nodeIntegration:false`。
- 上游主窗口未显式 `sandbox:true`；视频实现需要开启并验证 preload 能力，而不是继承较宽 renderer 权限。
- 文件授权后由 MediaService 导入/hash，renderer 不把任意绝对路径交给 Agent。
- Electron 主进程不是 Job owner；桌面退出、更新和多窗口不能杀错共享 daemon 或终止其他窗口正在使用的任务。
- CPU/解码/生成在独立 Worker；插件注册层不能阻塞 daemon。

### 2.3 播放与帧修

桌面可直接使用本地受控代理或新增 HTTP Range adapter。若实现 Range，必须支持 206/416、Content-Range、Accept-Ranges、ETag/If-Range、`createReadStream({start,end})` 和 principal+asset+revision 授权；不能复用当前一次性下载 token。

WebCodecs/canvas 只作可选预览/标注加速，先验证目标 Chromium/GPU；正确性事实仍来自 FFmpeg presentation index 和 mask 坐标映射。

### 2.4 自然语言规划审批验收

工作台向当前项目发送剪辑意图。「刷新事件」同步本次规划的工具活动、阶段以及项目的方案和审批。首次模型请求由 Worker 补充已授权的项目 ID，因此用户可以直接描述要保留的时间范围。点击「批准并渲染预览」才会创建预览 Job。

在已恢复并构建宿主依赖的 `vendor/paseo/packages/server` 中执行以下命令。需要 `ffmpeg`、`ffprobe` 和当前 Pi 环境可用的 strict tool calling 模型。

```bash
VIDEO_EDITOR_LIVE_PLANNER_TEST=1 \
  npx --no-install vitest run src/server/video/agent/planning-approval.real.e2e.test.ts
```

用例通过 daemon WebSocket 导入两秒的 25 fps 视频，向真实模型请求保留前一秒。它检查模型提交的源范围、关联方案哈希的待审批记录、审批前的 Job 列表，以及源文件哈希。C 本机的规划事件单测 2/2 通过。真模型端到端用例与实际界面待验收，本机缺少锁定依赖、FFmpeg 和可用模型配置。

## 3. Android 监督端

### 3.1 功能

- 项目/任务列表、真实阶段、进度、错误和 Worker 状态。
- 压缩 proxy 播放、计划/QA 查看、approve/reject、追加指令、暂停/取消、下载成品。
- 前台/冷启动拉取 ApprovalInbox；断网后按 event seq 恢复，不依赖 push 保证正确性。

不提供多轨拖动、复杂 mask/关键帧精修、源片写入、视频转码或后台渲染。Android App 退出不影响 daemon/Worker。

### 3.2 播放依赖

当前 Paseo 依赖中没有 `expo-video`，只有 expo-audio；新增 `expo-video` 前必须在 SDK 57 真机验证。它只是播放器，不是剪辑/转码引擎。`expo-background-task` 的 WorkManager 调度不适合持续渲染或实时审批同步，不用于这些任务。

小 proxy 经 WebSocket 分块下载到 app cache，再以本地 URI 播放；长预览使用 range RPC + 本地缓存。预览和成品查看默认不传原片；用户主动上传原视频时仍走同一受控分块上传协议。不依赖当前 DocumentFrame/WebView 支持 MP4。

F-Droid 变体没有 QR/push 时支持 pasted-link pairing 和冷启动/前台同步，不把这些缺失能力当错误。

## 4. 插件贡献点与限制

可用 `addWorkspacePanel/addAgentPanel/addCommandCenterItem/addSlashCommand/addComposerItem/addAttachmentSource` 注册 UI。Composer attachment 最终会成为文本附件，只传：

```text
asset://<project>/<asset>?revision=<revision>&in=<rational>&out=<rational>
```

daemon 将其解析为资产和区间引用；不传视频字节或 base64。普通附件 50 MiB 限制和图片 base64 路径也不用于视频。

`defineRpc/defineSubscription` 的 Zod 校验和顶层 `Uint8Array` 二进制帧可复用。单值上限不等于推荐块大小，首版采用几百 KiB 分块、流式写盘和背压；Android 大帧/队列风险必须实测。

subscription 断线不重放，插件 disable/reload/daemon stop 会影响进程，所以 Job/Revision/Approval 由 daemon 持久化，恢复使用 snapshot + event seq。`agent.permission.before` 通知 hook 不是阻塞审批门；自定义 render/export 走 ApprovalStore，不伪装成 provider permission。

外部插件 server 无沙箱，client bundle 经 `globalThis.eval` 执行；首版只启用签名应用内的 first-party 视频插件，禁止安装来源不明插件。

## 5. 专用 video 协议与授权

当前 `plugin.rpc.invoke.request` 和 `plugin.rpc.subscribe.request` 都要求 `daemon.manage`，不能直接暴露给 viewer/operator。M1 在 Paseo downstream 中新增 first-party `video.v1.*` 协议和 `EditorAuthorizationBroker`，不是给手机授予 daemon.manage。

每次入站 RPC、出站 snapshot/event、二进制输出都检查：

- principal/device 是否有效、是否被撤销；
- project/workspace grant 是否覆盖目标资源；
- viewer/operator/owner 是否允许该操作；
- asset/job/approval 是否属于同一项目；
- revision/planHash/leaseEpoch 是否仍有效；
- connected-host 转发时 caller 与 link 权限取交集。

`EditorProjectStore` 提供 `applyCommand(requestId + expectedRevision)`；`EditorJobSupervisor` 提供 submit/cancel/get/list；`EditorApprovalStore` 提供 `decide_approval(ApprovalDecision)`，其中 `requestId + approvalId + expectedRevision + decision` 唯一确定一次 approve/reject。拒绝与撤销是不同操作；所有响应可按 requestId 重放，审批与后续状态在同一事务提交。

## 6. 媒体读取与上传

### 6.1 统一 AssetStore seam

```ts
read({
  ref: { projectId, assetId, revision },
  offset: string,
  length: string,
  expectedRevision: string
}): AsyncIterable<Uint8Array>
```

首版统一实现 WebSocket `video.v1.read_asset_chunk`：请求含 offset/length/revision，响应含 offset/bytesLength/totalBytes/revision/chunkSha256/assetSha256，支持单块上限、取消、断点续传和 revision 验证。接收端校验每块 hash、流式写临时文件，最终校验完整 asset hash，不拼完整字节数组。

HTTP Range 只是桌面直连的可选 adapter，与 WS 共用 AssetStore；relay 只转发 WebSocket，不能假设 HTTP endpoint 自动穿 relay。

### 6.2 上传

手机上传经认证分块接口：初始化声明 size/hash/mediaType/project，逐块 offset/hash，完成后长度 + SHA-256 校验并原子提交。支持配额、断点、取消和重复块幂等；视频不转为聊天 base64。

代理、waveform、thumbnail、mask、QA 和导出都是独立派生 asset，带内容 hash 和 Revision；播放器授权不暴露 CAS 私有路径。

## 7. 配对、设备凭据与 E2EE

### 7.1 上游现状不能当作完成

当前 ConnectionOfferV2 只有 serverId、daemon public key、relay 和 minimumSecurityMode；没有 invitation ID、expiry、single-use nonce、client identity 或 grants。指纹确认是信任确认，不是设备授权；密码/local credential 登录目前得到完整 owner。

因此 M1 必须新增：短时单次 invitation、独立 device credential、可撤销 principal/device grant、approval-only operator 和 viewer。不能把共享 owner 密码当移动审批权限。

HostProfile 当前密码可存 AsyncStorage 整体 JSON，不是 Keystore/Keychain 专用保护。设备凭据迁移到 `expo-secure-store`，并测试升级、卸载、备份恢复和 biometric 设置变化。

### 7.2 Relay

protected 模式使用 Noise NK + fresh ephemeral + record authentication；legacy 没有同等 replay protection，且上游 `daemon.relay.requireProtectedSecurity` 默认 false。远程审批上线前必须强制 protected，禁止 legacy downgrade。

Noise NK 绑定 daemon static key，不等于持久客户端身份/撤销；设备授权仍需上面的 credential/grant。relay 只转发密文，不替代 RPC 授权。

## 8. 重连与结果未知

现有 client 有指数 backoff、前台活性验证和订阅重建，但 plugin subscription 不重放，未响应 mutation 结果是 unknown，普通 mutation 不自动 replay。

- submit/cancel/approve 统一使用 requestId；不同客户端使用不同 requestId 时，Job 仍受 `(planHash, baseTimelineRevision, kind)` 活跃唯一约束，避免语义重复的付费任务。
- 断线后先调用 `get_mutation_result(projectId, requestId)` 对账，不直接重试可能已执行的 mutation。
- 项目事件 seq 持久且永不重置；afterSeq 太旧或缺口无法补齐时返回 snapshotRequired，不另设客户端可见 epoch。
- UI 将超时显示为“结果未知，正在对账”，不能显示“任务失败”或“审批未执行”。
- 手机后台只依赖 OS 允许期间连接；回前台立即验证并补 snapshot/events。

## 9. 权限矩阵

| 能力 | viewer | operator | owner |
| --- | --- | --- | --- |
| 项目、代理、进度、QA 查看 | 是 | 是 | 是 |
| 上传、追加指令 | 否 | 是 | 是 |
| 批准计划、付费生成、导出 | 否 | 是，显式确认 | 是 |
| 暂停/取消 | 否 | 是 | 是 |
| 配对设备、撤销凭据、后端/网络配置 | 否 | 否 | 是 |

手机批准界面显示模型/权重、上传目的地和范围、费用上限、作用 Revision 和过期时间。修改任一内容后必须重审。高费用/公开发布可要求桌面二次确认。

## 10. 联调验收

1. direct 与 relay 的 RPC、下载 hash、权限结果一致；Range 越界/416 和 revision 改变正确处理。
2. viewer 所有写操作、跨项目 asset/job/approval 和二进制读取均被服务端拒绝。
3. submit/approve 响应丢失不重复执行；旧 App/新 daemon、新 App/旧 daemon 可诊断。
4. daemon/plugin/Worker crash 后无永久 running；手机杀进程、冷启动、Wi-Fi/cellular 切换可恢复。
5. 三桌面验证长路径/UNC/空格/非 ASCII、文件锁、进程树、GPU 回退和多窗口/更新。
6. Android API 29 与近期版本验证 proxy 播放/seek/旋转/前后台、SecureStore、F-Droid pasted-link 和 APK 签名。

以上是对锁定源码的静态调研与目标设计，尚未运行 build、视频编解码或真机测试。
