# 版面分析切换论文时报 invalid session id

2026-10-30。解析插图、表格、文字失败：`cannot run inference. invalid session id`。

## 根因

查看器和 headless 版面分析共用 `getPdfAiRuntime()`。EmbedPDF 的 `AiManagerPlugin.destroy()` 会调用 `runtime.destroy()`，释放唯一的 ONNX session。切论文卸载阅读器，或 headless registry 结束，都会走到这里。另一路还在 `session.run` 时，onnxruntime-web 报 session id 无效。

## 修复

共享 runtime 对插件的 `destroy()` 不做释放。模型随应用进程保留，切换论文不再拆掉正在跑的推理。
