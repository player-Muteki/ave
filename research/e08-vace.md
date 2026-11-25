# E08 局部视频生成实测

2026-11-25 在 NVIDIA GeForce RTX 5060 Laptop GPU 上使用 Wan2.1-VACE-1.3B 生成短镜头。输入为 832×480、9 帧的 RGB 帧列与二值掩码。保留纵横比，边缘填充至模型尺寸，输出候选按同一矩形裁回源网格。模型原始候选、遮挡保护后的合成、无编辑对照、过程输入及各自摘要均保存在本次运行目录。模型、源帧与输出媒体只保存在本机。

## 环境与复验

固定 Diffusers 仓库快照 `ec4d2cb062b548996b179d493fdd05340de702a1`，17 个运行文件逐一核对摘要。PyTorch 2.13.0+cu130、Diffusers 0.36.0、Transformers 4.57.3、Accelerate 1.12.0、FFmpeg 8.0.1。文本编码器单独运行，BF16 权重按 GPU 4 GiB、CPU 2 GiB 配额及磁盘分层加载。释放文本编码器后以 BF16 transformer、FP32 VAE、分块 VAE 和 CPU offload 完成 20 步采样，guidance scale 为 5。报告中的显存为 PyTorch allocated 峰值，耗时为本机单次观察。[权重文件清单](../downstream/paseo/plugins/video-editor/worker/vace-1.3b.json)

从仓库根目录执行，环境变量分别指向本地固定快照、E07 结果目录、SAM2 checkout 和 Tiny 权重。靠枕的 `prepare` 使用 SAM2 环境，`generate` 使用 VACE 环境。每次输出使用新目录。

```sh
python scripts/check_vace_canvas.py
HF_HUB_OFFLINE=1 python scripts/check_vace_shot.py --model "$VACE_SNAPSHOT" \
  --sam2-evidence "$E07_TINY" --output e08-disk
python scripts/check_vace_bedroom.py prepare --source "$SAM2_SOURCE" \
  --weights "$SAM2_TINY" --output e08-pillow-masks
HF_HUB_OFFLINE=1 python scripts/check_vace_bedroom.py generate --model "$VACE_SNAPSHOT" \
  --sample e08-pillow-masks --output e08-pillow
```

## 平移和遮挡

输入为 E07 的两镜头样片，共 18 帧、9 fps。只编辑前九帧里可见的橙色圆盘，seed 为 732021。每帧 SAM2 Tiny 掩码与独立的可编辑区域求交。E07 原片无声，在对照和合成前统一挂入 2 秒 PCM 测试音轨。MP4 成品的 18 个视频 PTS 依次为 0/9 至 17/9，音视频均从零开始、持续 2 秒并通过全片解码。成品与无编辑对照的 AAC 解码为相同 PCM。

| 成品测量 | 实测 |
| --- | --- |
| 改色面积 | 九帧编辑区内符合蓝色判据的像素各占约 99.6%–100%；逐帧纯色对照为 99.6%–100% |
| 帧间变化 | 按圆盘每帧右移 7 px 对齐相邻帧，取同时可见像素的 RGB 通道绝对差均值。VACE 各帧对为 3.91–9.51/255，逐帧纯色对照 1.03–2.70/255 |
| 保护区 | 编码前 1,073,516 个保护像素逐通道与源一致。H.264 解码后与同编码 no-op 对照的平均绝对差 0.155/255，最大 176/255 |
| 时间与显存 | 文本 7.84 s，加载视觉模型并生成 59.53 s，显存峰值 5.04 GiB |
| 源片 SHA-256 | `484fad04ea2f2a2eef9cce6431577a23ec7ae28d890aef6ed3cd25cd90b6eecb` |
| VACE 候选 SHA-256 | `15e4ccc60a52a6c02164773899ba2b308cf9d0f7d2b9c68576bffc3eca4daa27` |
| 合成 MP4 SHA-256 | `083e97ef772952aa0a1dbd0c35fc66432669af6a5443bdcaa016545394976455` |

对照图的第 0、4、7 帧可见圆盘由橙色变为亮蓝色。原始候选在第 7 帧把红色遮挡条染蓝，源网格合成恢复了红条。实际颜色偏青，球面有渐变；陶瓷材质的可信度仍需人工判断。

## 自然画面中的靠枕

从固定 SAM2 checkout 的 bedroom 示例取前九张 960×540 JPEG，按 9 fps 组成 1 秒无声实验片段。给右侧米色靠枕一个正点、周围两个负点，SAM2 Tiny 重放后九张掩码逐像素一致。用独立的固定矩形限定本次编辑范围。VACE 生成青绿色靠枕，seed 为 732022。

- 在第 0、4、8 帧检查了源片、原始候选与合成导出。导出的靠枕变为青绿色并带有织物样暗纹，床面和人物保留了源画面。九帧编辑区中符合青绿色判据的像素占 94.37%–96.60%，同参数无编辑导出均为 0%。
- 4,531,668 个保护像素在编码前保持逐通道一致。与无编辑 H.264 对照比较，保护区解码后的通道绝对差均值为 0.755/255，最大值为 109/255。
- 文本编码 8.29 s，视觉阶段 61.34 s，显存峰值 5.04 GiB。原始候选与合成 MP4 的九个视频 PTS 分别检查通过，完整解码通过。合成文件 SHA-256 为 `bbc86aa6a5c63f9feb7645c8342fa812c9e6d104a04d6642c2144fc65653eda5`。

两次均为离线实验。颜色比例使用脚本中的 RGB 判据，贴图细节、目标外观与实际编辑意图仍需人工审片。生产 daemon、真实用户的掩码与成品审批、其他 GPU 和平台仍需独立验收。[逐帧数据与输入摘要](e08-vace-results.json)
