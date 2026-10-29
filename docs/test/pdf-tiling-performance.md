# PDF 高清瓦片尺寸对照

2026-10-29，基于 `1034143fa13c17a7313fa7b99ce7cea434f0433b`。前置调查为 [PDF 滚动与交互延迟排查记录](https://icnh9yjkbey7.feishu.cn/wiki/EVEKwGYUFiHNSakTG29cVwUrnqh)。

阅读器将 `TilingPluginPackage` 的 `tileSize` 从默认 768 改为 512 CSS px。AgentCompass 第 3 页的同视口光栅任务总耗时约下降 87%；实际阅读器在前台浏览器中的跳页到最后瓦片返回耗时，两轮中位数分别下降 78% 和 85%。这证明该样本的高清补图等待缩短，不能推导成滚动 FPS 或所有 PDF 的同等收益。

## 改动与取舍

继续使用 [EmbedPDF 的底图 + 可见瓦片和公开配置](https://www.embedpdf.com/docs/react/headless/plugins/plugin-tiling)，只设 `tileSize: 512`。本次核对了已安装 2.14.4 的 `calculateTilesForPage`、`renderTile` 和 PDFium `renderRectEncoded` 实现；原有 overlap=2.5、extraRings=0、BMP、DPR 上限 2、页面旋转、取消和 URL 释放逻辑均由原路径处理。

DPR=2 时单块位图最大从 1536×1536 变为 1024×1024；缩放和像素密度相同。每块同步 WASM 工作变短，边界瓦片覆盖的页外视口区域也减少。本文未进一步证明重页面具体慢在图像、蒙版还是矢量对象。

- 384px 在重页面同视口需要 9 块，512px 只需 4 块；384px 总耗时更高，未采用。
- DPR=1 / 1.5 的探针更快，但改变阅读像素密度，未采用。
- 临时试过 PDFium image-cache / halftone / printing / image-smoothing flags，未得到稳定收益，未保留修改。
- 不新增应用层瓦片缓存、队列或引擎补丁。

## 环境与样本

macOS 26.6.2 (25G83)，Node v26.4.0，React 19.2.7，EmbedPDF engines / tiling 2.14.4。源 PDF 只读，未覆盖、重写或提交入库。

| 样本 | SHA-256 |
| --- | --- |
| AgentCompass，2607.13705 | `08eed45a0ba65257b3b283160896e58c67c1d1d25013fe0006d57d202bcdda8c` |
| Agentero 重生成笔记式 PDF，2609.04298 | `3caee9938be7321d738db5aff0bad32d0d933b56bf50d48f3da69ff19dba363f` |
| 普通论文正文对照，2601.20103 | `98a3121de46018f08f47a8db18b4ed55c9d117beb5e984eaa9f3c2a47f3a5649` |

## 只读光栅复现

```bash
node test/scripts/benchmark-pdf-tiles.mjs \
  /absolute/path/2607.13705.pdf \
  /absolute/path/2609.04298.pdf \
  /absolute/path/2601.20103.pdf
```

探针复用仓库 PDFium WASM direct engine，`fontFallback: null`。固定第 3 页、scale=1.5、DPR=2、整页宽度、顶部 800 CSS px；按当前上游 2.5px overlap 生成完整边界瓦片，不把边界块裁成视口形状。顺序为 768 → 512 → 384 → 512 → 768，各三次。测量为 `renderPageRectRaw` 顺序调用耗时之和，包含各块像素复制，不含 BMP 编码、worker 传输、图片解码和合成。

下表为每个三次条件的中位数（ms）；列顺序与执行顺序一致：

| 第 3 页同视口 | 768 首轮 | 512 首轮 | 384 | 512 反向轮 | 768 反向轮 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2607.13705 | 4715 | 619 | 762 | 549 | 4170 |
| 2609.04298 | 66 | 40 | 44 | 35 | 62 |
| 2601.20103 | 23 | 22 | 24 | 22 | 22 |

重页面单次最长块的三次中位数：768px 首轮 2709ms、反向轮 2167ms；512px 分别 328ms、298ms。普通正文对照的总耗时基本相同，未把这类毫秒级变化解读为普遍加速。

## 浏览器端到端验收

用 ego-browser 启动临时 Vite 验收页，直接挂载项目的 `PdfEngineHost`、`PdfViewer`、真实 CSS、i18n 和 Tooltip provider；使用上述本地字节，不模拟 PDF 引擎或 Tauri IPC。验收页位于忽略的 `tmp/`，不作为产品入口。临时对照只在 `TilingPluginPackage.create` 合并 `tileSize: 768`；512 条件直接使用产品配置。运行时确认 executor 为 `_RemoteExecutor`（worker），页面 `visibilityState=visible`。

浏览器视口 1476×1031，阅读器固定 1280×800，DPR=2，缩放 150%，单栏。每次先跳第 8 页，等待其真实页面节点挂载且第 3 页卸载、任务结束和图片加载完成，再通过页码输入框跳第 3 页。记录从输入开始到第 3 页最后一个 `renderPageRect` Task 返回 Blob 的时间；验收另外等待图片 `complete && naturalWidth > 0`。该计时包含 UI 导航、引擎排队与出图，**不包括 Blob 返回后的图片解码与上屏时间**。

前台执行顺序为 512 → 768 → 512 → 768，每条件三次；两种顺序的相邻对照均保留。下表列出全部有效采样（ms）：

| 条件 | 三次跳页到最后瓦片返回 | 中位数 |
| --- | --- | ---: |
| 512，第一组 | 1225 / 1047 / 1437 | 1225 |
| 768，第一组 | 5048 / 5469 / 5701 | 5469 |
| 512，第二组 | 1531 / 1381 / 1240 | 1381 |
| 768，第二组 | 9600 / 9117 / 8871 | 9117 |
| 2601.20103，512 | 529 / 440 / 432 | 440 |
| 2601.20103，768 | 587 / 558 / 459 | 558 |
| 2609.04298，512 | 361 / 304 / 286 | 304 |
| 2609.04298，768 | 388 / 318 / 489 | 388 |

两轮基线有明显环境波动，因此不合并为一个精确加速倍数。初期隐藏标签出现约 1000ms 的 rAF 限速，整批排除；只保留打开当前任务空间后的前台测量。前台 rAF p95 在 768 条件约 9–14ms、512 条件约 9–25ms，没有支持“帧率改善”的证据。

功能验收：

- 三份 PDF 页码正确；跳页、离开重页再返回和高清图片全部加载完成。
- 图表、正文与瓦片接缝经过截图检查，未见白缝、缺块或清晰度降低；截图仅保留在本机临时目录。
- 跨瓦片拖动正文选区，出现完整 Selection actions 工具栏。
- 真实 trusted wheel 事件使原生滚动容器从 2565.5 移到 3165.5px。
- 键盘调整缩放 150 → 151 → 150，恢复后瓦片完成，无未处理渲染失败。
- 查找 `framework` 得到 16 个结果，下一条切到 `2/16` 并跳页。

同时通过 `pnpm tauri dev` 构建并启动 macOS 原生 WebKit，用临时 devUrl 挂载同一真实阅读器，在隔离窗口核对 AgentCompass 第 3 页显示、滚动与查找 `framework` 的 16 个结果。该原生验收是功能和显示冒烟，未对原生 WebKit 宣称上述 Chromium 的耗时收益。日常应用与 Vault 未用于写入测试。

## 验证范围与后续

类型检查、Biome、既有瓦片取消 / 旋转 / 引擎生命周期 / Scroller 测试通过。配置变化不新增镜像配置值的单元测试；光栅脚本用于重新测量，不作为跨机器绝对耗时断言。

已检查 `docs/development/index.md`：仓库没有独立 Roadmap / TODO；PDF 后续项仍记在 `docs/frontend/pdf.md` 的「限制与后续」。本次没有完成 Linux / Windows 原生测量，也未做完整 Vault、双栏翻译、后台模型并行运行的性能覆盖，不能据此关闭既有跨平台滚动问题。后续回归应同时保留重页和普通正文，核对 DPI、缩放、图像接缝与任务总量。
