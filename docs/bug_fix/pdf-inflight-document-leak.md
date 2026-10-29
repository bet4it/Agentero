# PDF 异步打开与卸载重叠时的文档泄漏

2026-10-29。用户在 dev 中切换几份 PDF 后，返回 AgentCompass 出现 `Failed to allocate 7834181 bytes`。

## 证据与根因

运行日志确认工作树为 `pdf-perf`，19:07–19:10 连续打开了几份论文；7834181 恰好是 AgentCompass PDF 的字节数。错误字符串来自 PDFium WASM 的 `MemoryManager.malloc`，是载入文件缓冲时分配失败。现有 Host 日志未保留该次失败的完整栈，因此没有把日志本身当成系统内存耗尽或唯一泄漏源的证明。

独立复现确认了 EmbedPDF 2.14.4 的一处所有权缺口：

1. Document Manager 发起 worker 的异步 `openDocumentBuffer`。
2. 打开尚未完成，React 阅读器已卸载，registry 调用 `destroy`。
3. 旧版 `closeDocument` 遇到 `loading` 状态直接跳过 engine close。
4. 打开任务随后成功，原生文档已注册进共享引擎，却没有对应的关闭。dev StrictMode 的重复 effect，以及加载期间快速换文档，都能进入这个窗口。

这也会留下现有共享文档 refcount 的一份所有权。只关闭正在显示的另一份引用，无法释放这份遗留引用。该问题位于未修改过的 Document Manager 加载态关闭逻辑；瓦片尺寸与可见性修改没有触及这里。

## 修复

为 `@embedpdf/plugin-document-manager@2.14.4` 增加仓库补丁，覆盖 ESM / CJS：

- 跟踪尚未完成的打开任务；关闭时等待它结算，若成功则立即释放该份文档，失败则完成关闭。
- 关闭期间不发布迟到的 loaded / error 状态。
- 合并同一文档尚未结算的关闭请求，避免重复减引用计数，保留其他 pane 的所有权。
- registry 销毁等待这些关闭完成，再清理插件状态。

没有通过 abort 丢弃仍在执行的 worker 打开结果，也没有在关闭一个 pane 时调用共享引擎的 `closeAllDocuments`。

## 验证

只读 Node 探针使用同一真实 PDF，在 executor 返回结果时延迟 30ms，复现 worker 的异步交付窗口。每次打开后立即销毁 registry，并等待引擎队列结算：

| 连续 4 次后的指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 引擎保留文档 | 4 | 0 |
| 未释放的文件缓冲（bytes） | 31336724 | 0 |

修复后每一轮结束均为 0 文档、0 bytes。这个值是引擎跟踪的源文件缓冲，不是整个进程 RSS，也没有包含所有 PDFium 内部分配。WASM 线性内存的高水位不会因为 `free` 必然立即下降，不能单凭进程内存不回落断定泄漏。

回归测试 `test/pdf-document-lifecycle.test.ts` 对 ESM / CJS 分别验证：打开晚于卸载成功、关闭期间打开失败、重复关闭请求、同 id 的另一 pane 仍保持打开。8 个用例通过，连同现有引擎、瓦片、批注回归共 18 个测试通过。

Chromium 的真实 PdfViewer + worker + StrictMode，在同一引擎内连续切换三份 PDF 30 次，最后关闭：62 次打开 / 62 次关闭，未完成任务与错误均为 0。再按 35ms 间隔切换 15 次并关闭：32 次打开 / 32 次关闭，错误为 0。探针与测试页面只保留在本机临时目录，不进入产品。

macOS 原生 WebKit 也在独立应用标识与测试端口中完成同一 worker 的 30 次快速切换；最终界面计数为 62 次打开 / 62 次关闭、pending=0、errors=0。此原生测试使用相同 PdfViewer 的隔离 PDF 字节入口，启用本机 CJK fallback，不把它说成完整 Vault 写入验收。既有完整 Vault 的批注保存 / 重开验收记录仍单独保留。

## 使用与后续

依赖补丁和 Vite 预构建需要重启 `pnpm tauri dev` 才能可靠加载；旧 worker 中已经失去关闭责任的文档无法由新代码追溯释放，重启应用重建 worker。这里确认并修复了一处实际泄漏，没有声称所有内存增长都由它解释。跨平台持续切换、合法大批注、复杂页面和全文翻译应保留各自的样本与所有权检查。

已检查开发目录，无独立 Roadmap / TODO；后续约束继续维护在 PDF 能力文档。
