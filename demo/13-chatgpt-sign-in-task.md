# AVE 桌面端 ChatGPT 账号登录与 AI 剪辑任务书

**状态**　待实施 · **本轮开发**　macOS arm64、Windows x64、Linux x64（Ubuntu 24.04） · **本轮正式实机验收**　仅 macOS Apple Silicon · **代码基线**　`main@9cd9e33` · **编制日期**　2026-11-28

## 一、交付目标

用户打开 AVE，在「设置 → AI 模型」里选择「使用 ChatGPT 继续」，由系统浏览器完成登录并授权 AVE 使用其 ChatGPT 套餐。在允许云模型的项目中，用户选择模型和素材，输入「只保留开头两秒，并把这段静音」。AVE 应在现有审批队列中给出一份可以检查的方案。用户点击「批准并执行」后，才能生成并播放预览。整条路径无需填写 API Key、运行命令或安装外部 Agent。

本期使用一个活动 ChatGPT 账号和桌面启动的本机 daemon。界面说明哪些请求使用 ChatGPT 套餐，以及会向模型发送剪辑指令、必要的项目与素材元数据和工具结果。源视频、音轨和渲染留在本机。账号授权、项目允许使用云模型、用户批准执行剪辑，是三个独立决定。

本轮在三个桌面平台实现登录、选模型、自然语言剪辑和审批，共用 OAuth 和规划器。Windows、Linux 的系统凭据适配、浏览器回调和打包配置随 macOS 代码一同提交。正式实机验收使用 Mac，Windows 和 Linux 的实机结果可在具备环境时补录。Android 沿用配对后的远程监督、预览与审批能力，ChatGPT 账号授权由发起规划的桌面端管理。[产品平台范围](01-product.md) · [原生架构](../docs/adr/0012-native-ave-architecture.md)

## 二、Pi 提供的参考与 AVE 的落点

Pi 的参考版本固定为 `2126569`。采用其将账号授权与模型调用分开的设计。AVE 自行编写登录、会话和 Responses 适配代码，使用自己的应用名和注册信息，运行时独立于 Pi、Codex CLI 和 Codex app-server。

| 可参考的设计 | AVE 的实现责任 |
| --- | --- |
| Pi 把浏览器授权、换取凭据和刷新凭据封装在 OAuth 模块中。[Pi 登录实现](https://github.com/earendil-works/pi/blob/2126569de40d5595dd3f41f7af126001f04c1de0/packages/ai/src/auth/oauth/openai-chatgpt.ts) | Electron 主进程管理浏览器回调和凭据。工作台只接收账号摘要和连接状态。[桌面主进程](../apps/desktop/src/main.ts) · [桌面桥接](../apps/desktop/src/preload.cjs) |
| Pi 的 OpenAI Provider 为 API Key 和 ChatGPT 授权分别定义认证方式，请求由 Responses 适配器构造。[Pi Provider](https://github.com/earendil-works/pi/blob/2126569de40d5595dd3f41f7af126001f04c1de0/packages/ai/src/providers/openai.ts) · [Pi Responses 适配器](https://github.com/earendil-works/pi/blob/2126569de40d5595dd3f41f7af126001f04c1de0/packages/ai/src/api/openai-responses.ts) | 现有 `PlannerProvider` 走 Chat Completions。为账号模式新增 Responses 实现，沿用原生规划循环、17 个工具和 daemon 的审批机制。[Provider](../services/planner-worker/src/provider.ts) · [规划循环](../services/planner-worker/src/planner-loop.ts) |
| AVE 工作台当前的「提交裁剪方案」根据填写的时间范围直接组装草案。 | 增设自然语言入口，提交真实规划运行。状态、方案和任务均从 daemon 读取。手动裁剪保留独立入口。[工作台](../apps/web/src/App.tsx) · [规划 RPC 契约](../packages/contracts/src/v1.ts) |

## 三、实施工作包

### A · 桌面登录和会话

1. Electron 主进程先在 `127.0.0.1` 启动回调监听，再打开 OpenAI 官方授权页。使用授权码流程、PKCE S256、每次新建的 `state` 和 OIDC `nonce`。为本机生成并保存稳定的 `ext_agent_host_id`。首次注册使用 `dynamic_agent_client` 和应用名 `AVE`，用回调签发的 `client_id` 换取凭据。再次授权使用该账号原有的注册 ID。成功、取消、超时均关闭监听并作废本次尝试。
2. 通过 OpenAI 公钥验签，校验 ID token 的签发方、受众、有效期和 nonce。依据换取凭据时实际授予的 scope 区分「已登录」和「可使用 ChatGPT 套餐」。申请身份权限以及 `offline_access`、`resource.invoke`、`chatgpt.tokens.use.direct`，资源为 `https://api.openai.com/v1`。只授予身份权限时，显示「授权使用套餐」并允许重试。[登录与授权规范](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
3. 主进程使用 Electron `safeStorage` 和操作系统的凭据保护机制，将加密后的凭据原子写入当前用户的应用目录。各系统的存储适配见第四节。无法使用安全存储时，登录前提示「仅本次使用」，凭据只驻留在进程内存，关闭应用后重新登录。Linux 的 `basic_text` 后端同样按临时会话处理。[Electron 凭据存储说明](https://www.electronjs.org/docs/latest/api/safe-storage)
4. 按已验证身份和签发的注册 ID 绑定记录。临近过期时合并并发刷新，安全存储可用时原子替换轮换后的凭据。退出时撤销可续期会话、清理本地令牌，让正在返回的刷新结果失效。断网退出时告知用户「本机已退出，远端撤销尚未确认」。[会话与撤销规范](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
5. 给桌面预加载层增加固定的登录、取消、状态、模型列表和退出操作，并验证 IPC 来源。桌面主进程通过专用父子 IPC 为它启动的 daemon 登记本次请求的项目、请求 ID 和模型。通过项目权限检查后，daemon 才为该运行向主进程取短期访问令牌，交给对应的 worker。刷新令牌只由主进程持有。账号凭据不得进入渲染页面、公共 RPC、项目库、事件、日志或命令行。账号令牌只发往指定的 OpenAI 接口，拒绝自定义地址和跨域重定向。[桌面启动器](../apps/desktop/src/daemon-launcher.ts) · [IPC 白名单](../apps/desktop/src/security.ts)

### B · 模型选择与真实工具调用

1. 用当前账号的访问令牌调用 `GET /v1/models`，读取 `models` 数组，展示可见模型的 `display_name`，运行时使用对应的 `slug`。项目所有者可以在界面明确允许云模型并启用某个模型的 `planning` 策略，复用 `set_project_cloud_policy` 和 `set_model_policy`。daemon 在启动 worker **之前**检查操作者权限、云开关与最终使用的模型，包括默认选择。项目禁用、账号无可用模型或选中模型已失效时，指出具体原因。失败时由用户选择是否换用已有 API Key 配置。[项目模型策略](../storage/sqlite/src/repositories/plan-approval-repository.ts) · [运行调度](../services/daemon/src/planner-controller.ts)
2. 账号模式向 `https://api.openai.com/v1/responses` 发起 HTTP 流请求，设置 `store: false`、`stream: true`。用 `instructions` 表达规划提示，逐轮在 `input` 数组中带回必要的对话、工具调用及其结果。按模型要求保留同轮输出项。请求省略该通道不支持的 `temperature` 和 HTTP `previous_response_id`。沿用现有 `AVE_PLANNER_*` 配置和 Chat Completions 适配器服务原来的调用方。[模型与推理规范](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) · [账号通道限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
3. 从现有契约生成 17 个严格函数定义，按账号通道支持的工具命名空间发送，并将返回的工具名映射到 AVE 白名单。按调用聚合 SSE 中的参数片段，等 `response.completed` 后校验完整参数并交给 daemon 调用。下一轮用原始 `call_id` 关联 `function_call_output`。失败、中断或重复事件不能重复执行工具或生成第二份方案。沿用 daemon 对项目、版本和操作的校验。[工具定义](../services/planner-worker/src/tool-schemas.ts) · [工具代理](../services/daemon/src/tool-broker.ts) · [函数调用协议](https://developers.openai.com/api/docs/guides/function-calling)

### C · 工作台与审批

1. 设置页可查看登录状态、套餐授权状态、当前模型，以及本项目允许的模型。首次获得套餐授权时解释用量归属，输入框附近显示「使用 ChatGPT 套餐」和「管理用量」。用户应能区分未登录、需要重新授权、项目未允许云模型、模型不可用和额度用尽，并从当前界面采取相应操作。[官方交互指引](https://developers.openai.com/siwc/ui-ux-guidelines) · [ChatGPT 用量设置](https://chatgpt.com/settings/usage)
2. 选中素材后显示「告诉 AI 怎么剪」。通过 client SDK 调用 `start_planning_run`，传入项目和选定模型，将选中素材的 ID 与指令一同交给规划器。工作台使用 `get_planning_run`、`get_run_events` 和 `stop_planning_run` 查询、补拉和停止，双击或断线重试沿用同一个 `requestId`。如果模型只回复文字，显示答复。若 `submit_edit_plan` 成功，展示关联的方案、改动摘要及待审批状态。[客户端 SDK](../packages/client-sdk/src/client.ts) · [规划器 IPC](../services/planner-worker/src/ipc.ts)
3. 用户可在现有队列批准或拒绝。拒绝结束该提案，批准后才创建对应渲染任务。工作台分别显示规划结束、待审批、渲染中与可播放状态。切换项目或重连时按 `projectId/runId` 恢复，避免将其他项目的结果显示在当前素材下。

## 四、三端工程交付与 macOS 实机验收

三个打包目标使用同一候选提交。按平台分别记录代码交付、构建和实测状态，安装包格式沿用[桌面包交付约定](10-desktop-release-task.md)。

| 平台与打包目标 | 本轮要实现的系统适配 | 本轮验证安排 |
| --- | --- | --- |
| macOS Apple Silicon（arm64）· DMG | 从「应用程序」启动，调用系统浏览器并接收授权回调。用钥匙串保护凭据，支持重启恢复和用户取消钥匙串访问时的临时会话。 | **正式实机验收**。从本轮 DMG 安装 AVE，检查会话恢复、退出，并完成下方真实账号剪辑用例。 |
| Windows x64 · NSIS `.exe` | 支持普通用户从开始菜单启动，接收默认浏览器的授权回调，使用当前 Windows 用户的 DPAPI 保护凭据并在重启后恢复。 | 本轮交付适配代码、NSIS 打包配置及对应回归测试。具备 Windows 桌面环境时补验安装包，注明实测系统版本。 |
| Linux x64（Ubuntu 24.04 桌面）· `.AppImage` | 支持普通用户在启用沙箱时启动并完成浏览器回调。系统密钥服务可用时支持重启恢复。密钥服务不可用时进入「仅本次使用」，支持本次剪辑，关闭应用后凭据不落盘。 | 本轮交付适配代码和 AppImage 打包配置，用自动化覆盖持久和临时会话。具备 Ubuntu 桌面环境时补验安装包。 |

下表首项在 Mac 上使用真实账号，其余用例作为三端共享的开发回归，使用测试凭据或模拟服务即可。

| 场景 | 操作与通过条件 |
| --- | --- |
| macOS 真实账号剪辑（必验） | 从已安装的 AVE 启动，用真实 ChatGPT 账号授权，无需 API Key。新建项目，允许所选云模型，导入一段超过两秒的有声 25 fps 合成视频。选中素材并输入「只保留开头两秒，并把这段静音」。记录运行 ID 和模型，确认仅产生一份待审方案，批准前该方案的渲染任务数为零。批准后播放成片，用 `ffprobe` 核对视频为 50 帧、2 秒，解码音轨确认有样本且静音。 |
| 本机回调与会话 | 测试取消、回调重放、state/nonce 不符和过期凭据。无效回调不建立会话。安全存储可用时，重启应用能恢复授权，并发刷新只交换一次。主动退出账号后重启仍显示已退出，之前的刷新不会恢复登录。 |
| 权限与用量 | 模拟只授予身份权限、关闭项目云开关、只读角色、未获本机桌面授权的远程请求、模型失效和额度不足。界面给出对应原因及下一步。缺少必要授权时模型服务收到的推理请求为零。额度不足不会切换计费来源。 |
| 流、工具和审批 | 用本地模拟服务分片返回工具参数，覆盖两轮工具调用、纯文本、失败、重复事件和中途断线。收到半截参数时无工具副作用。每个调用最多执行一次，每个运行最多提交一份方案。重新开一轮并拒绝审批，确认无对应渲染任务。 |
| 兼容与凭据隔离 | 在未登录的桌面回归手动裁剪，在原配置下回归 API Key 和无密钥本地 Provider。用可识别的假令牌检查渲染页面、公共 RPC、事件、日志及自定义模型服务器，均无账号令牌。 |

## 五、交付顺序与证据

| 里程碑 | 建议负责人 | 可交付结果 |
| --- | --- | --- |
| M1 · 交付三端账号授权代码 | C 主责桌面，K 评审 | 同一套登录、退出和续期流程接通三端系统存储。提交三端适配代码及回调、令牌轮换、持久会话和临时会话测试。 |
| M2 · 跑通规划 | K 主责规划与协议，L 评审 | 接入新 Provider 和项目策略，用协议模拟服务重放多轮调用，验证 AVE 产生唯一待审方案。模型协议开发可与 M1 并行。 |
| M3 · 完成 macOS 正式验收 | C 主责工作台与打包，K、L 联验 | 在 Apple Silicon Mac 用本轮 DMG 跑通真实账号登录、模型选取、剪辑规划、审批与播放。记录系统版本、源码 SHA、安装包 SHA-256、模型标识、运行 ID、审批前后状态、帧数和音轨结果。以这次 Mac 实测通过作为本轮正式验收结论。 |

三端打包配置在本轮接入原生 `apps/desktop`、`apps/web` 及配套 daemon/worker。现有候选构建流程仍从旧版 Paseo 目录组装，可复用其平台矩阵构建 DMG、EXE 和 AppImage。Windows、Linux 的构建结果随工程交付记录，尚未运行真实账号用例的平台标记为「未实机验证」，可在 M3 完成后补测。[候选构建流程](../.github/workflows/desktop-candidate.yml)

自动化在现有[桌面安全测试](../apps/desktop/test/desktop-security.test.ts)、[规划器测试](../services/planner-worker/test/planner-worker.test.ts)和[daemon 端到端测试](../services/daemon/test/planner.e2e.test.ts)中补足上述场景。按里程碑提交并推送到 `main`，通过仓库规定的类型、测试、原生边界与项目校验。真实账号由测试者在官方页面操作，只留脱敏结果。若 Mac 暂缺测试环境，或测试账号、工作区暂未获准使用套餐，则记录原因，M3 保持待验。
