# 桌面候选包的规划模型配置

安装、启动工作台、创建项目和导入视频可以直接测试。点击「开始规划」时，daemon 需要访问一个支持工具调用及严格 JSON Schema 的模型服务。模型权重和服务凭据由测试者所在环境提供。

以下示例假设已有本机兼容 Chat Completions 的服务。把端口、模型 ID 和上下文窗口改为服务端实际提供的值，将文件保存为本机的 `models.json`。对于要求鉴权的服务，在本机按其配置设置凭据。示例标记只适用于无需鉴权的回环服务。

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "local-only",
      "compat": { "supportsStrictMode": true },
      "models": [{ "id": "YOUR_MODEL_ID", "contextWindow": 32768, "maxTokens": 4096 }]
    }
  }
}
```

Windows 在当前用户的「环境变量」中新增下表两项。macOS 或 Linux 从终端运行候选应用时可以先用 `export` 设置相同变量。完全退出 AVE 及本次测试启动的 daemon，再从对应入口启动。模型 ID 在配置文件和模型选择中必须相同。

| 变量 | 示例 |
| --- | --- |
| VIDEO_EDITOR_PLANNER_MODEL | local/YOUR_MODEL_ID |
| VIDEO_EDITOR_PLANNER_MODELS | C:\QA\models.json 或 /absolute/path/to/models.json |

导入随包提供的 demo-source.mkv，输入“保留最后一秒和原声”。成功时工作台出现带方案 ID 的待预览审批，源区间为 [1.4, 2.4)。运行结束、模型文字回复、仅能连接 HTTP 服务均不足以证明方案已保存。完整演示还需要两次规划、人工审批及导出核验。
