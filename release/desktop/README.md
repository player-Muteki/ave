# AVE v0.1.0 桌面候选构建

团队仓库的 `AVE desktop candidate` 工作流从所选 AVE 提交读取 `research/upstream.json`，恢复锁定的 Paseo 并覆盖该提交的 `downstream/paseo`。随后应用 `identity.patch`，将应用名、安装包标识和更新仓库设为 AVE。开发与候选包都使用锁定的 npm 依赖。

| 资源 | 随包内容和来源 |
| --- | --- |
| 媒体处理 | 从 FFmpeg n8.1.2（38b8833）与 x264 stable（31e19f9）按当前架构编译 ffmpeg、ffprobe。编码使用 libx264 与 FFmpeg 原生 AAC。两个可执行文件及 GPL 许可证位于 native-media。完整源码提交和构建参数写在 build-media.sh。当前打包配置支持元数据字幕。 |
| Python Worker | python-lock.json 记录各平台 CPython 3.12.16 的下载地址与 SHA-256。保留发行包自带许可证和标准库。采样内核随 AVE 插件安装，使用包内解释器。 |
| 规划 Worker | Pi SDK 随 daemon 安装。配置真实规划模型时设置 VIDEO_EDITOR_PLANNER_MODEL 为 provider/model，并设置 VIDEO_EDITOR_PLANNER_MODELS 为本机 models.json 的绝对路径。访问凭据由部署者在本机配置。 |
| 桌面 | Electron 44.2.0。macOS arm64/x64 分别生成 DMG，Windows x64 生成 NSIS 安装程序，Linux x64 生成 AppImage。 |

工作流的 sign 输入默认为关闭。候选附件随 Actions 运行保存，每个架构附带 SOURCE_SHA 和 SHA256SUMS。开启 sign 时使用 macOS 的 APPLE_CERTIFICATE、APPLE_CERTIFICATE_PASSWORD、APPLE_ID、APPLE_PASSWORD、APPLE_TEAM_ID，Windows 使用 WINDOWS_CERTIFICATE、WINDOWS_CERTIFICATE_PASSWORD。正式发布的安装、模型演示和下载复验以任务书第 9–11 项为准。
