# Windows 11 x64 现场验收记录

对应任务书第 9、10 项。请用普通 Windows 11 x64 账户操作。安装包、样片、记录表须对应同一次交付。未签名候选包可记录功能验证结果；正式签名栏以系统实际结果填写。

| 记录项 | 现场填写 |
| --- | --- |
| Windows 版本、内部版本号、CPU 架构 | |
| AVE 源码 SHA、安装包文件名、SHA-256 | |
| 签名状态、发布者、时间戳 | |
| 安装位置、开始菜单名称、应用版本 | |
| 模型服务及模型标识，不含密钥 | |
| 样片文件名与导入前 SHA-256 | |
| 第一次方案 ID、拒绝后任务状态 | |
| 第二次方案 ID、源入点、时长、预览审批状态 | |
| 成品、清单中的 SHA-256、下载文件 SHA-256 | |
| 完整解码、视频帧数、音轨、时长与 PTS | |
| 卸载结果、证据目录、测试人和日期 | |

1. 用本次提供的 SHA256SUMS 核对安装包。PowerShell 运行 `Get-FileHash .\AVE-Setup-0.1.0-x64.exe -Algorithm SHA256` 和 `Get-AuthenticodeSignature .\AVE-Setup-0.1.0-x64.exe | Format-List Status,SignerCertificate,TimeStamperCertificate`。记录结果。正式包须显示 Valid。
2. 从资源管理器运行安装程序，以当前用户安装。按团队提供的模型配置为当前用户设置 VIDEO_EDITOR_PLANNER_MODEL 和 VIDEO_EDITOR_PLANNER_MODELS，后者指向本机模型配置文件。确认模型服务就绪，从开始菜单打开 AVE。保存“关于”或版本页截图。
3. 在「剪辑工作台」创建项目。记录 2.4 秒 MKV 样片的 SHA-256，导入样片，在「规划意图」输入“保留最后一秒和原声”，点击「开始规划」，必要时点击「刷新事件」。
4. 核对第一份方案并点击「拒绝预览方案」。截图记录拒绝状态，确认任务列表仅允许素材分析。再次输入相同意图并开始规划，确认保留源区间 [1.4, 2.4) 且原声保留。
5. 依次点击「批准并渲染预览」「刷新项目」「观看预览候选」。实际播放并听取声音。再点击「批准渲染成品候选」「刷新项目」「观看成品审片代理」，播放完成后点击「确认审片并批准导出」。
6. 下载成品视频和导出清单。用 Get-FileHash 核对下载 MP4 与清单 output.sha256，复核样片哈希。记录「校验导出」的结果。到安装目录的 resources\native-media\bin 中运行下方命令，保留输出及退出码。预期 H.264 视频 25 帧、AAC 原声、两流起始 PTS 为 0、时长一秒，容差各一个时间基刻度。
7. 在 Windows「已安装的应用」中卸载 AVE，记录普通用户卸载结果和开始菜单项状态。提供记录表、截图及校验日志即可，模型配置文件和访问凭据留在测试机。

```powershell
.\ffprobe.exe -v error -count_frames -show_streams -show_format -of json C:\QA\output.mp4
.\ffmpeg.exe -nostdin -v error -xerror -i C:\QA\output.mp4 -map 0 -f null -
$LASTEXITCODE
```
