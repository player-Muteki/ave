# 06 · 接口与数据契约

[返回总览](../demo.md) · [架构](02-architecture.md) · [并行规则](07-team-workflow.md)

## 1. 契约治理

M1 的唯一源是 Paseo downstream fork 中 `plugins/video-editor/shared/contracts/v1.ts`。Zod 生成 TypeScript 类型和 JSON Schema；Python Worker 只消费生成的 schema 与 fixtures，不维护第二份手写 DTO。

- wire 字段使用 camelCase；ID、hash、大整数和序号均为字符串。
- 所有时间使用 Rational，禁止浮点秒；所有 Blob 用内容 hash，不把宿主路径当资产标识。
- mutation 带 `requestId + expectedRevision`；actor、role、device 来自认证上下文。
- 响应含 `protocolVersion`；事件含 `eventId + seq`，客户端可去重和补拉。
- v1 只新增 optional 字段、feature 和 RPC；破坏性变更创建 v2。

## 2. 基础类型

```ts
type Rational = { num: string; den: string }; // den > 0
type TimeRange = { start: Rational; duration: Rational }; // 半开区间

type BlobRef = {
  sha256: string;
  bytes: string;
  mediaType: string;
};

type AssetStreamRef = {
  assetId: string;
  assetContentHash: string;
  streamUid: string;
  probeRevision: string;
};

type CapabilitySet = {
  protocolVersion: "1";
  features: string[];
  operations: string[];
  workerProfiles: Array<{
    profileId: string;
    engine: "ffmpeg" | "filmcraft" | "sam2" | "vace";
    backendVersion: string;
    backendBuildDigest: string;
    modelDigest?: string;
    maxFrames?: string;
    maxWidth?: number;
    maxHeight?: number;
    colorSpaces: string[];
  }>;
  deterministicBackends: DeterministicCapability[];
};

type DeterministicCapability = {
  backendId: string; // 注册表 ID，不是路径或 URL
  engine: "ffmpeg" | "filmcraft";
  backendVersion: string;
  backendBuildDigest: string;
  operations: string[]; // 仅本项目白名单操作，不是上游 command catalog
  codecs: string[];
  containers: string[];
  timeTopologies: Array<"cfr" | "preserve-vfr" | "explicit-retime">;
  streamPolicies: string[];
  colorSpaces: string[];
  validationEvidence: string; // 指向可复现 conformance 报告
  verifiedAt: string;
};
```

没有 `validationEvidence` 的 FilmCraft 操作对生产 UI/Agent 不可见；能力检查使用完整 `(operation, codec/container, timeTopology, streams, color, resolution, backendVersion)` 键。禁止用一个布尔值代表整个 FilmCraft 可用。

`streamUid` 只在 immutable Asset 内稳定；资产重导入或内容变化产生新 assetId/contentHash。模型、UI、Worker 不接收任意可写源路径。

## 3. 资产、时间线与 mask

```ts
type SourceAsset = {
  assetId: string;
  original: BlobRef;
  displayName: string;
  streams: StreamDescriptor[];
  presentationIndex: BlobRef;
  color: ColorDescriptor;
  sourceNeverWritable: true;
};

type TimeMap = {
  timeMapId: string;
  segments: Array<{
    outputRange: TimeRange;
    sourceStart: Rational;
    rate: Rational;
  }>;
  sourcePresentationIndexHash?: string;
  generatedSamplingMapHash?: string;
  outputPolicy: "preserve-vfr" | "cfr" | "explicit-retime";
  outputRate?: Rational;
};

type Clip = {
  clipId: string;
  source: AssetStreamRef | { generatedNodeId: string };
  sourceRange: TimeRange;
  recordRange: TimeRange;
  timeMapId: string;
  effects: EditOperation[];
  audioPolicyId: string;
  subtitlePolicyId: string;
  colorPolicyId: string;
};

type MaskRevision = {
  maskRevisionId: string;
  parentIds: string[];
  shotId: string;
  objectId: string;
  sourcePresentationIndexHash: string;
  coordinateSpace: { width: number; height: number; rotation: string; sar: Rational };
  promptEvents: Array<ClickPrompt | BoxPrompt | ManualMaskEdit>;
  engine: { name: string; version: string; weightsDigest: string };
  rawLabelMask: BlobRef;
  approvedBy?: string;
};

type DerivedMask = {
  derivedFrom: string;
  operation: "union" | "dilate" | "feather" | "resize" | "vace-preprocess";
  paramsCanonicalJson: string;
  samplingMapHash: string;
  blob: BlobRef;
};
```

`StreamDescriptor` 至少记录 codec、codec profile、time_base、帧率模式、尺寸、色彩、音频 sample rate/channel layout、字幕类型、语言、disposition。presentation index 记录 decoded presentation PTS/duration/time_base，而不是仅 packet 平均帧率。

规划工具 `get_asset_metadata` 按项目、资产 ID 和内容哈希读取导入时保存的探测结果。返回的 `PlannerAssetMetadata` 可包含各流的 `startPts` 和 `durationTicks`，均为整数字符串，乘以该流的 `timeBase` 即为秒。音视频流头缺少时长时，工具可从同一源和时基的 v2 显示索引读取每帧 PTS 和时长，按最早起点到最晚终点计算范围。索引时间缺失或与已知起点不一致时省略时长。可选的 `averageRate` 表示平均帧率。可选的 `inputStartTime` 是容器报告的起始时间（有理数秒）。FFmpeg 确定性裁剪使用输入播放时间：将源 PTS 乘以时基后减去该输入的 `inputStartTime`。音频、视频分别保留相对同一输入起点的偏移。此读取方式也适用于已有资产。

## 4. EditPlan 与 EditGraph

### 4.1 模型提交计划

```ts
type EditPlanDraftV1 = {
  schemaVersion: "video.edit-plan/v1";
  projectId: string;
  baseTimelineRevision: string;
  baseAssetManifestHash: string;
  preferredDeterministicBackendId?: string; // 仅限 capabilities 注册表；daemon 可拒绝/另选
  intent: string;
  trimOperations: TrimOperation[];
  transformOperations: TransformOperation[];
  audioOperations: AudioOperation[];
  transitionOperations: TransitionOperation[];
  subtitleOperations: SubtitleOperation[];
  generationRequests: GenerationRequest[];
  qaRequirements: QaRequirement[];
  externalDestinations: string[];
  maxCostMicros: string;
};

type OperationBase = {
  opId: string;
  order: string; // 跨所有操作数组全局唯一
  trackId: string;
  clipId: string;
};

type TrimOperation = OperationBase & {
  source: AssetStreamRef;
  sourceRange: TimeRange;
  recordRange: TimeRange;
};
type TransformOperation = TrimOperation & {
  crop: { x: string; y: string; width: string; height: string };
  scale: { width: string; height: string };
  rotationDegrees: string;
};
type AudioOperation = TrimOperation & { gainMilli: string; mute: boolean };
type TransitionOperation = OperationBase & {
  leftClipId: string;
  rightClipId: string;
  kind: "crossfade" | "fade";
  duration: Rational;
};
type SubtitleOperation = OperationBase & {
  cueId: string;
  range: TimeRange;
  text: string;
  mode: "metadata" | "burn-in";
};

type AcceptedEditPlan = EditPlanDraftV1 & {
  deterministicBackendId: string; // daemon 接受计划时固定，变化产生新 planHash
  planId: string;
  revision: string;
  runId: string;
  idempotencyKey: string;
  planHash: string;
  status: "proposed";
};
```

模型只提交 `EditPlanDraftV1`，不拥有 `planId/revision/runId/idempotencyKey/planHash`。这些字段由 agent-worker 上下文和 daemon 生成；daemon 以 `runId + toolCallId` 形成持久幂等键并分配 Plan 标识。

模型 wire 按操作类型使用五个封闭数组，避免复杂 union；每个数组元素字段全部 required，以零值/空数组表达无操作。daemon 按全局 `order + opId` 排序并规范化为内部 discriminated `EditOperation` DAG；重复 order/opId、跨类型重复 clip 或非法依赖均拒绝。

`GenerationRequest` 至少包含：

```ts
type GenerationRequest = {
  requestId: string;
  shotId: string;
  providerProfileId: string; // 注册表 ID，不是任意 URL
  modelId: string;
  prompt: string;
  negativePrompt: string;
  maskRevisionId: string;
  referenceAssetIds: string[];
  referenceManifestHash: string;
  samplingMapHash: string;
  frameCount: string;        // 对 VACE 必须满足 4n+1
  sampleFps: Rational;
  seedPolicy: "fixed" | "random";
  seed: string;
  maxCostMicros: string;
};
```

`planHash = SHA256(canonicalAcceptedPlanWithoutRunMetadata)`，包含 daemon 确定的 deterministicBackendId。`planId/revision`、`idempotencyKey` 有唯一约束。源、Revision、后端、prompt、模型、参考图、mask、seed、成本或外部目的地变化都必须改变 planHash。

### 4.2 语义校验

Schema 通过后仍检查：资产存在且 hash 匹配、轨道兼容、区间非零且未越界、DAG 无环、mask/shot/object 一致、SamplingMap 完整、模型 capability 和许可可用、费用/尺寸/帧数/文本长度在限额内、没有隐式覆盖或未声明外链。

## 5. 审批

```ts
type ApprovalRequest = {
  approvalId: string;
  projectId: string;
  subjectType: "mask_revision" | "keyframe_set" | "edit_plan" |
    "candidate_revision" | "export";
  subjectId: string;
  subjectRevision: string;
  subjectHash: string;
  planHash?: string;
  baseTimelineRevision: string;
  purpose: "input" | "preview" | "final" | "export";
  requiredInputs: Array<{ type: string; id: string; revision: string; hash: string }>;
  diffSummary: DiffSummary;
  generationCostCapMicros: string;
  externalDestinations: string[];
  status: "pending" | "approved" | "rejected" | "superseded" | "expired" | "revoked";
  expiresAt: string;
};

type ApprovalDecision = {
  requestId: string;
  approvalId: string;
  expectedRevision: string;
  decision: "approve" | "reject";
  comment?: string;
};

type ApprovalGrant = {
  grantId: string;
  approvalId: string;
  projectId: string;
  subjectHash: string;
  planHash?: string;
  baseTimelineRevision: string;
  purpose: "preview" | "final" | "export";
  approvedByDeviceId: string;
  approvedAt: string;
  expiresAt: string;
  consumedAt?: string;
  revokedReason?: string;
};
```

`decide_approval` 处理 approve 和 reject；reject 只记录决策，不创建 grant。revoke 只针对已创建 grant，不能代替 reject。同一 `requestId` 重放返回原决策，不同 requestId 不能改变同一 pending request 已完成的决策。

Grant 只能由 daemon 在 approve 事务中创建，模型无接口。input 审批覆盖 mask/锚帧；preview/final/export grant 各自只能消费一次，执行时重新验证项目、subjectHash/planHash、当前 Revision、角色、有效期、撤销和消费状态。

### 5.1 唯一的审批与 Revision 生命周期

1. mask/锚帧形成带 hash 的 input revision，经 `purpose=input` 审批后才可进入 EditPlanDraft。
2. `purpose=preview` grant 绑定 `planHash + baseTimelineRevision`，消费后创建一个 preview Job。输出形成带父关系的 `candidateRevision`，不改写源 Revision。
3. 用户审阅 preview 后，`purpose=final` grant 绑定同一 planHash 和 candidateRevision，消费后创建一个最终分辨率 Job；输出再形成 final candidate Revision。
4. 全片 QA 后进入 `awaiting_delivery_approval`。`purpose=export` grant 绑定 final Revision + output hash，消费后原子发布 ExportManifest/下载资产。
5. 每个 grant 只用于一个 purpose；preview 消费不妨碍后续独立 final/export 审批，但不能重放创建第二个同类 Job。

数据库对活跃 Job 建 `(planHash, baseTimelineRevision, kind)` 语义唯一约束。不同设备/不同 requestId 同时提交相同规格时返回现有 Job 和 `deduplicated:true`，不是另建付费任务；同 requestId 不同 payload 返回 IDEMPOTENCY_CONFLICT。

## 6. Job、Artifact 与 QA

```ts
type JobSnapshot = {
  jobId: string;
  projectId: string;
  revision: string;
  planHash: string;
  kind: "analysis" | "preview" | "final" | "export";
  state: "draft" | "analyzing" | "awaiting_plan_approval" |
    "awaiting_inputs" | "rendering_preview" | "awaiting_review" |
    "rendering_final" | "validating" | "awaiting_delivery_approval" |
    "pausing" | "paused" | "completed" | "failed" |
    "cancel_requested" | "cancelled";
  phaseDetail?: string;
  progress?: { completedUnits: string; totalUnits?: string };
  artifacts: ArtifactRef[];
  error?: EditorError;
};

type QaReport = {
  reportId: string;
  subjectHash: string;
  revision: string;
  thresholdsVersion: string;
  gates: Array<{
    gate: "G0" | "G1" | "G2" | "G3" | "G4" | "G5";
    status: "passed" | "warning" | "failed" | "manual_required";
    checks: QaCheck[];
  }>;
};

type ExportManifest = {
  exportId: string;
  output: BlobRef;
  sourceManifestHash: string;
  revision: string;
  planHash: string;
  ffmpegBuildHash: string;
  modelRuns: ModelRunManifest[];
  maskLineageRoots: string[];
  encoding: EncodingDescriptor;
  qaReport: QaReport;
};
```

旧 subject hash 的 QA 不能给新 Revision 放行。警告与人工项不能被 Worker 自动转为 passed。

## 7. 客户端 RPC

命名空间使用 `video.v1.*`；下表是逻辑操作，具体 Paseo `defineRpc/defineSubscription` 名称在 contract PR 固定。

| 操作 | 作用 | 权限/约束 |
| --- | --- | --- |
| `get_capabilities` | 协议、feature、Worker profile | 所有已认证角色 |
| `create_project/get_project` | 创建/读取项目（快照内 plans≤128、approvals≤256、jobs≤256，专用 reader 不受限） | operator / viewer 只读 |
| `import_asset` | 桌面原生授权导入 | operator；hash/配额 |
| `create_upload/write_upload_chunk` | 初始化上传、写一块 | operator；uploadId/requestId/offset/chunkSha256 |
| `get_upload_status/commit_upload/cancel_upload` | 查询 nextOffset、完成或取消 | operator；最终长度和 SHA-256，重复 commit 返回同 Asset |
| `get_asset_metadata` | 流描述符 + 输出时长/帧数（读 CAS 内 probe/presentation index），有界元数据 | viewer；requestId + projectId + assetId |
| `get_analysis` | 最新 analysis job 的有界元数据：state/速率/artifact 引用（含 hash）/error，字节不出 CAS | viewer；requestId + projectId + assetId |
| `get_scene_cuts` / `get_waveform` | 确定性切点（整帧对齐、≤64 条、含 score/aligned）与首音轨 RMS 波形桶（100ms、≤1200 桶），有界只读，无像素 | viewer；requestId + projectId + assetId |
| `inspect_frame` | 按素材、流、索引摘要和显示序号取帧，可附编码像素坐标的正负点 | operator；返回二进制 JPEG、源 PTS、时基、尺寸与掩码摘要。v1 增量接口；旧客户端可继续读取代理。原帧检查仅需 FFmpeg，点选预览需配置 SAM2。 |
| `propose_vace_preview` | 为已批准的连续 9 帧掩码提出本地 VACE 预览方案 | operator 传审批 ID、清单摘要、提示词、负面提示和种子。返回标准 EditPlan 和独立 preview 审批；模型、20 步采样、工作画幅和保护区由固定 Worker profile 决定。 |
| `request_tracked_mask_review` | 为已完成的传播范围建立独立输入审批 | operator 提交项目、任务、时间线版本、标签清单与审片视频 SHA-256。沿用 `mask_revision` 和 `purpose=input`，subjectId 为传播清单产物 ID。批准时核验视频与全部标签，记录审批设备。 |
| `track_mask` | 从已批准的锚帧标签向前、向后传播至指定源帧范围 | operator；传审批 ID、subjectHash、时间线版本和含锚点的连续 2–81 帧。返回 analysis Job；完成后产物含逐帧标签、源 PTS 与固定 9 fps 审片代理，传播结果需另行审片。 |
| `create_mask_revision`（单帧锚点） / `get_mask_revision` | 保存已查看的原始 0/255 标签和 JPEG，或按项目读取已存版本与审片图 | 创建需 operator、时间线版本、标签及审片图双摘要；读取需项目访问权。独立 input 审批绑定完整版本摘要，批准记录审批设备。现有预览、渲染和导出 grant 语义不变。 |
| `create_mask_revision/correct_mask_revision` | 创建或修正 mask | operator；产生新 subjectRevision/hash |
| `create_keyframe_set` | 创建锚帧/参考图集合 | operator；产生新 subjectRevision/hash |
| `start_agent_run/steer/follow_up/abort` | 控制规划会话 | operator；runId 幂等 |
| `estimate_timeline` | 方案草稿或已采纳方案（planId）的只读时间线预估：校验问题 + 各轨道段数/总时长/转场重叠/有效输出时长，不渲染不落库 | operator；requestId + draft，或 requestId + projectId + planId |
| `submit_plan_review` | 用户对 Plan 提修改，不是 Agent 提交 | operator |
| `get_approval/decide_approval/revoke_approval` | 查看、approve/reject 或撤销 grant | operator；ApprovalDecision + requestId |
| `create_preview_job/create_final_job/create_export_job` | 消费对应 purpose grant 创建任务 | operator；requestId + expectedRevision + grantId |
| `get_mutation_result` | 按 projectId + requestId 对账丢失响应 | 原操作角色；返回可重放结果和实体 ID |
| `list_jobs/get_job/watch_jobs` | 查询/订阅真实任务 | viewer；持久 seq + snapshot；事件流每页上限 500，按 afterSeq 继续拉 |
| `get_run_events` | 按 runId 订阅单次规划运行的事件（内存过滤 runId，单页 ≤200，带 latestSeq 游标） | viewer；requestId + projectId + runId + afterSeq? |
| `list_approvals` | 审批列表，可选 status 过滤（pending/approved/rejected/superseded/expired/revoked），最新 256 条 | viewer；requestId + projectId + status? |
| `list_plans` | 方案摘要按创建顺序分页，下一页传上一页末条 planId，单页 ≤128；get_plan 支持查询已移出项目快照的历史方案 | viewer；requestId + projectId + afterPlanId? |
| `cancel_job/pause_job/resume_job` | 控制任务 | operator；独立 Agent abort |
| `get_qa_report` | 查询 QA | viewer |
| `get_qa_summary` | QA 有界摘要：流/时长/响度/renderRecipeHash/planHash/门禁，完整 probe 不出 CAS | viewer；requestId + projectId + jobId |
| `get_plan` | 按 planId 读取已采纳方案全文（操作列表、hash、状态） | viewer；requestId + projectId + planId |
| `list_artifacts` | 按 jobId 列出产物元数据：kind/大小/SHA-256/mediaType（上限 256 条，不出 CAS 字节） | viewer；requestId + projectId + jobId |
| `get_export_summary` | export 任务 manifest 的有界摘要：hash 链（plan/recipe/源 manifest）、各 op 计数、输出 blob 引用与响度 | viewer；requestId + projectId + jobId |
| `verify_export` | 重新计算交付字节 SHA-256 并与 manifest 对账 | operator；requestId + projectId + jobId |
| `get_artifact` | 读取产物元数据 | viewer 仅 proxy/QA；最终 export 需 operator |
| `read_asset_chunk` | 分块读取 proxy、mask、QA 或 export | 按 asset 类型鉴权；最终 export 需 operator |
| `revoke_device/configure_worker` | 设备/后端管理 | owner only |

### 7.1 分块读取

```ts
type ReadAssetChunkRequest = {
  projectId: string;
  assetId: string;
  revision: string;
  offset: string;
  length: string;
};
type ReadAssetChunkMetadata = {
  offset: string;
  bytesLength: string;
  totalBytes: string;
  revision: string;
  chunkSha256: string;
  assetSha256: string;
};
```

响应 metadata 后接顶层 `Uint8Array` 二进制帧，避免嵌套二进制限制。最后一块允许 `bytesLength < length`；超出资产返回 RANGE_NOT_SATISFIABLE。重复块返回相同内容，revision 改变必须重新下载。接收端逐块校验 chunkSha256、流式写临时文件，最终校验 assetSha256 后原子提交。

桌面直连可选认证 HTTP Range adapter，但必须实现 206/416、Content-Range、ETag/If-Range 和同一资产授权；relay 不依赖 HTTP 隧道。视频不进入聊天 base64 或单条 WebSocket 大消息。

### 7.2 上传会话

`create_upload` 返回 `uploadId + chunkSize + nextOffset`。`write_upload_chunk` 含 `requestId/uploadId/offset/length/chunkSha256`，metadata 后接顶层二进制帧；重复 offset+hash 幂等，冲突返回 IDEMPOTENCY_CONFLICT。`get_upload_status` 返回已确认 nextOffset，客户端从该位置续传。`commit_upload` 带 finalSha256，完整校验后创建 Asset；`cancel_upload` 只清理未提交临时数据。

## 8. 事件

```ts
type EditorEvent = {
  protocolVersion: "1";
  projectId: string;
  sessionId?: string;
  runId?: string;
  jobId?: string;
  eventId: string;
  seq: string;
  causationId?: string;
  occurredAt: string;
  type: string;
  payload: unknown;
};
```

主要类型：`agent.text.delta`、`transcript.message.final`、`agent.run.settled`、`plan.proposed`、`approval.requested`、`approval.granted`、`job.state.changed`、`job.progress`、`artifact.committed`、`qa.completed`、`export.completed`、`worker.health.changed`。

文本 delta 可替换；snapshot 和最终事件才是同步依据。客户端以 eventId 去重、seq 检测缺口，重连先 snapshot 再从最后 seq 拉取。

## 9. Worker 协议

```ts
type TaskLease = {
  protocolVersion: "1";
  jobId: string;
  nodeId: string;
  attempt: string;
  leaseEpoch: string;
  leaseExpiresAt: string;
  approvedRevisionHash: string;
  cacheKey: string;
  operation: string;
  inputs: BlobRef[];
  paramsCanonicalJson: string;
  checkpointRef?: BlobRef;
  resourceClass: string;
  deterministicBackend?: {
    backendId: string;
    backendVersion: string;
    backendBuildDigest: string;
    engineSnapshotHash: string;
  };
};

type DeterministicBackendResult = {
  backendId: string;
  backendVersion: string;
  engineSnapshotHash: string;
  backendJobId?: string; // 对账用，不是 daemon Job ID
  backendProjectHash?: string;
  actualEncoder: string;
  warnings: string[];
  offlineMedia: string[]; // 必须为空才能 complete
  commandMappingManifest: BlobRef;
};

type WorkerRoute = {
  jobId: string;
  nodeId: string;
  attempt: string;
  leaseEpoch: string;
};
type WorkerEvent = WorkerRoute & (
  | { type: "accepted" }
  | { type: "progress"; seq: string; stage: string;
      completedUnits: string; totalUnits?: string; message?: string }
  | { type: "checkpoint"; checkpoint: BlobRef; committedThrough: string }
  | { type: "complete"; outputs: BlobRef[];
      outputManifest: BlobRef; metrics: ResourceMetrics;
      deterministicBackend?: DeterministicBackendResult }
  | { type: "failed"; code: string;
      retryable: boolean; stage: string; sanitizedDetail: string }
);
```

`WorkerHello` 声明协议、操作、引擎/模型 digest、设备、最大尺寸/帧数、FFmpeg/FilmCraft build digest。每次新 lease 增加 epoch；daemon 按 `jobId + nodeId + attempt + leaseEpoch` 四元组路由、去重和提交，任何字段不匹配的 checkpoint/complete 都拒绝。完成是至少一次投递 + daemon 幂等提交，不宣称分布式 exactly-once。

确定性 Worker 只接收 canonical operation、BlobRef 和受控 staging 映射；不得接收上游 `command_run` 字符串。FilmCraft 适配器保存 `approvedRevisionHash ↔ engineSnapshotHash ↔ backendJobId` 映射，非阻塞提交并以 `wait:false + jobs.list/jobs.cancel` 桥接。完成时先校验 `offlineMedia == []`、engine result、actualEncoder、产物 SHA-256，再执行 ffprobe/全片 QA；其中任何失败都返回 `failed`，不提交占位或部分输出。后端进程重启后若无法唯一对账，attempt 为 `OUTCOME_UNKNOWN/NEEDS_RECONCILIATION`，不能盲目重跑。

同一 attempt 不跨 FilmCraft/FFmpeg 继续执行；改变 backendId、版本、映射或 engine snapshot 会改变 planHash/cacheKey，需要新 Revision 和审批。

取消消息含完整四元组和 `gracePeriodMs`。Worker 不直接改项目、Revision 或审批。

## 10. 错误与兼容

稳定错误码：

- `INVALID_ARGUMENT`、`SCHEMA_UNSUPPORTED`、`PLAN_SEMANTIC_INVALID`
- `UNAUTHENTICATED`、`PERMISSION_DENIED`、`PROJECT_NOT_FOUND`、`ASSET_NOT_FOUND`
- `REVISION_CONFLICT`、`APPROVAL_EXPIRED`、`APPROVAL_CONSUMED`、`IDEMPOTENCY_CONFLICT`
- `CAPABILITY_UNAVAILABLE`、`MODEL_LICENSE_BLOCKED`、`RESOURCE_EXHAUSTED`
- `BACKEND_SNAPSHOT_MISMATCH`、`OFFLINE_MEDIA_PRESENT`、`BACKEND_RESULT_INVALID`
- `LEASE_STALE`、`CHECKPOINT_INVALID`、`ARTIFACT_HASH_MISMATCH`、`RANGE_NOT_SATISFIABLE`
- `QA_FAILED`、`QA_MANUAL_REQUIRED`、`CANCELLED`、`OUTCOME_UNKNOWN`、`NEEDS_RECONCILIATION`
- `WORKER_PROTOCOL_MISMATCH`、`UPSTREAM_UNAVAILABLE`、`INTERNAL`

`error.retryable` 只是调度建议，不能绕过预算/次数上限。`sanitizedDetail` 不包含密钥、源路径或完整 prompt。

旧客户端依靠稳定 coarse state；新增细节放 optional `phaseDetail`。未知可选字段可忽略，未知错误码映射为 INTERNAL 并保留 raw code 供诊断。协议升级用 fixtures 验证旧客户端×新 daemon、新客户端×旧 daemon。
