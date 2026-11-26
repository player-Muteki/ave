# AVE v0.1.0 桌面候选构建

团队仓库的 `AVE desktop candidate` 工作流从所选 AVE 提交读取 `research/upstream.json`，恢复锁定的 Paseo 并覆盖该提交的 `downstream/paseo`。随后应用 `identity.patch`，将应用名、安装包标识和更新仓库设为 AVE。开发与候选包都使用锁定的 npm 依赖。

| 资源 | 随包内容和来源 |
| --- | --- |
| 媒体处理 | 从 FFmpeg n8.1.2（38b8833）与 x264 stable（31e19f9）按当前架构编译 ffmpeg、ffprobe。编码使用 libx264 与 FFmpeg 原生 AAC。两个可执行文件及 GPL 许可证位于 native-media。完整源码提交和构建参数写在 build-media.sh。当前打包配置支持元数据字幕。 |
| Python Worker | python-lock.json 记录各平台 CPython 3.12.16 的下载地址与 SHA-256。保留发行包自带许可证和标准库。采样内核随 AVE 插件安装，使用包内解释器。 |
| 规划 Worker | Pi SDK 随 daemon 安装。配置真实规划模型时设置 VIDEO_EDITOR_PLANNER_MODEL 为 provider/model，并设置 VIDEO_EDITOR_PLANNER_MODELS 为本机 models.json 的绝对路径。访问凭据由部署者在本机配置。 |
| 桌面 | Electron 44.2.0。macOS arm64/x64 分别生成 DMG，Windows x64 生成 NSIS 安装程序，Linux x64 生成 AppImage。 |

工作流的 sign 输入默认为关闭。候选附件随 Actions 运行保存，每个架构附带 SOURCE_SHA 和 SHA256SUMS。开启 sign 时使用 macOS 的 APPLE_CERTIFICATE、APPLE_CERTIFICATE_PASSWORD、APPLE_ID、APPLE_PASSWORD、APPLE_TEAM_ID，Windows 使用 WINDOWS_CERTIFICATE、WINDOWS_CERTIFICATE_PASSWORD。正式发布的安装、模型演示和下载复验以任务书第 9–11 项为准。

### Ubuntu 24.04 安装

先核对候选包的 SHA-256。Ubuntu 24.04 的 AppArmor 会限制普通进程使用用户命名空间；AVE 的 Chromium 沙箱需要此能力。管理员可将已核对的 AppImage 安装在固定的 root 所有目录，再加载仅匹配该文件的配置。以下命令假设安装包与本仓库提供的 ave-appimage.apparmor 位于当前目录。[Ubuntu 24.04 发行说明](https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890)

```bash
sudo apt-get update && sudo apt-get install -y fonts-noto-cjk
sudo install -d -m 0755 /opt/ave
sudo install -m 0755 AVE-0.1.0-x86_64.AppImage /opt/ave/AVE.AppImage
sudo install -m 0644 ave-appimage.apparmor /etc/apparmor.d/ave-appimage
sudo apparmor_parser -r /etc/apparmor.d/ave-appimage
```

工作台使用中文。精简 Ubuntu 系统缺少中文字形时，按钮会显示方框。上述命令安装的 Noto CJK 字体在下次启动应用时生效。

使用普通桌面账户运行 `/opt/ave/AVE.AppImage --appimage-extract-and-run`。该入口适用于缺少 FUSE 的环境。对应 CI 会读取 Chromium 渲染器的实际沙箱状态。

### 对已产出的安装包复验

「AVE installed desktop demo」接收团队 candidate 工作流的 run ID。它核对每个附件内的 SOURCE_SHA 与 SHA256SUMS，从 Linux 安装包的 FFmpeg 生成同一份带原声和时间偏移的 MKV，向全部平台分发相同字节，再以普通用户在已安装的应用中手动设置区间、拒绝、重新提交、审批、播放和导出。每个系统保存截图、MP4、清单和检查报告。demo.json 的 method 字段区分 manual 与 model。真实模型验收可用同一脚本及样片，设置 AVE_DEMO_SOURCE、PASEO_DESKTOP_SMOKE_ARTIFACT_DIR 和模型配置，使用默认的模型模式。

工作流的 `mode` 默认为 `manual`。选择 `model` 后，各测试机下载并校验固定版本的 llama.cpp b12722 和 Qwen3.5-9B-Q4_K_M，在本机回环地址启动推理服务。导入、拒绝、重新规划、审批和成品校验沿用同一套界面操作。各端的 `model-demo-*` 附件记录实测结果，模型权重仅用于测试机上的推理。

### 生成候选依赖清单

在已按对应提交恢复、应用身份补丁并完成 npm ci 的 runtime 上运行 `python3 release/desktop/make-sbom.py RUNTIME CANDIDATE_SHA SBOM.cdx.json`。CycloneDX 1.5 清单包含桌面与前端工作区的生产 npm 依赖、Electron、FFmpeg、x264、zlib 及四种 CPython 构建档案的来源与摘要。npm 重复安装路径保存在组件属性中。随包 Python 和 Chromium 的第三方许可继续保存在各自发行包，操作系统提供的共享库版本取决于目标平台。
