# Linux 浮动滚动指示器穿过 Tooltip

## 现象与原因

文件树的精读 / 魔棒、PDF 全文翻译等 HTML Tooltip 无法遮住 GTK 滚动条闲置时的细长指示器；悬停论文标题时的原生 `title` 提示却能遮住它。

GTK 的 overlay scrollbar 由 WebKit 的滚动合成路径绘制。WebKitGTK 2.52.6 中，这条细长指示器可以画到网页浮层上方，增加 `z-index`、提升到 Popover 顶层、将滑块颜色设为透明均不能解决实际应用里的问题。原生 `title` 提示属于系统窗口，因此表现不同。

## 首次处理及回退原因

在桌面 `main()` 最开始、GTK/WebKit 和工作线程初始化之前，仅 Linux 设置 `GTK_OVERLAY_SCROLLING=0`。所有 WebView 统一使用普通滚动条，HTML Tooltip 可以正常遮挡；滚动条保持固定粗细，不再切换成浮动指示器。无需修改各 Tooltip 的位置、背景或打开逻辑。

这采用了 [Tauri 上游的处理方式](https://github.com/orgs/tauri-apps/discussions/5689)。[WebKit 的实现](https://github.com/WebKit/WebKit/blob/webkitgtk-2.52.6/Source/WebCore/platform/adwaita/ScrollbarThemeAdwaita.cpp) 在 `usesOverlayScrollbars()` 中读取该变量。

该处理虽然修复遮挡，但丢失了闲置细长、悬停变粗缩短的外观，并引入原生轨道边线，不符合交互要求，因此撤回启动环境变量设置。

## 当前修复

复用现有 `components/ui/scroll-area.tsx`，增加 `pane` 变体，统一接入文件树和 `DockviewViewport`（包括双栏翻译的 PDF）。隐藏这两个 viewport 的原生滚动条，用 Radix 的 DOM 滑块处理拖动、轨道点击、尺寸与位置同步；实际内容仍通过原生 `scrollTop` / `scrollLeft` 滚动，保留文件树虚拟化和 EmbedPDF 的 ref / scroll / resize 接线。

滑块绘制使用伪元素：闲置为细长条，悬停或拖动时变粗并缩短两端；命中区域不随视觉变化而移动。没有轨道边线。DOM 滚动条遵循正常层级，原有的精读 / 魔棒 / 全文翻译 Tooltip 无需特殊处理。减少动态效果偏好下立即切换状态。

Radix 的内容包装层默认使用 `display: table`；`pane` 变体改为 block，避免论文标题 / PDF 的固有宽度扩张视口、破坏截断与适应宽度。

## 验证方法

- 同版本 WebKitGTK 2.52.6 + WebKitWebDriver，在独立 Xvfb 显示器中使用溢出容器和跨越滚动条的实色浮层进行对照：开启 overlay 时细条穿过浮层，关闭后浮层完整遮挡，未被覆盖的滑块仍可见。
- WebKitWebDriver 会覆盖启动环境中的 `GTK_OVERLAY_SCROLLING`；对照实验必须通过 `webkitgtk:browserOptions.useOverlayScrollbars` 设置，不能只给 driver 进程传环境变量。
- 使用真实的共享 ScrollArea / Tooltip 组件，在 overlay 开启的 WebKit 中检查三种提示跨越滑块的像素、细长 / 悬停 / 移开状态、双轴拖动及缩窄视口后的宽度。
- 当前实现验证通过：三种气泡覆盖处的像素均与气泡背景一致；滑块约 3px → 8px、两端各缩短 4px，移开后恢复；纵向 / 横向拖动分别滚动到 716 / 436；视口缩放到 220 / 500px 后宽度及内容溢出正确。
- 应用以 `nix-shell shell.nix --run "pnpm tauri dev"` 编译运行；手动回归入口为侧栏精读、魔棒和 PDF 全文翻译 Tooltip，以及文件树展开 / 折叠、PDF 缩放和双栏翻译。
