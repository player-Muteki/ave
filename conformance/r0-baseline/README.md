# AVE R0 行为基线与对照套件

本目录冻结 AVE 去宿主化迁移（R0–R5）的行为基线，供原生实现（`packages/`、`services/`、`storage/`、`apps/`）在各阶段做一致性验收，**不进入原生产品发布物**。

## 文件清单

- `fixtures.json`：从旧实现冻结的 196 条契约正/反例 fixture。
- `baseline-spec.json`：机器可读的基线规范，包含：
  - `sourceHashes`：`v1.ts`、`v1.schema.json`、`fixtures.json` SHA-256。
  - `rpcSurface`：63 个 `video.v1.*` 主路由方法、禁用桩、设备通道方法及 `viewer / operator / owner` 授权矩阵。
  - `plannerTools`：17 个受控规划工具、`submit_edit_plan` 终止型工具及禁用能力面。
  - `errorCodes` & `jobStates`：全量错误码与 15 态 Job 状态。
  - `objectEditFsm`：对象编辑六态状态机、转换前置条件、生成闸门与换素材失效规则。
  - `failureRecoveryMatrix`：13 条幂等、并发冲突、断线对账、CAS 校验、崩溃恢复与双库隔离规则。
  - `goldenMediaSpecs`：4 个确定性合成黄金媒体样本规格（25fps CFR、30fps CFR、混合帧率 VFR、双音轨+字幕 MKV）。
- `generate_golden_media.py`：使用 `ffmpeg` 参数数组（`shell=False`）现场生成并校验 4 个黄金媒体样本（输出默认写入 `/tmp/ave-r0-golden`，不入库）。
- `verify_r0_baseline.py`：校验 `baseline-spec.json` / `fixtures.json` 与当前 `downstream/paseo/` 一致性，运行 `test_rpc_surface.py`，并在临时目录生成并全解码验证 4 个黄金样本。

## 运行校验

```bash
python3 conformance/r0-baseline/verify_r0_baseline.py
```
