# Linux 浮动滚动指示器穿过 Tooltip

## 现象

文件树的精读 / 魔棒、PDF 全文翻译等 HTML Tooltip 无法遮住 GTK 滚动条的细长指示器，气泡里能看到滚动条；悬停论文标题时的原生 `title` 提示却能遮住它。

## 根因

WebKit 的浮动（overlay）滚动条不遵循 CSS 层叠顺序。WebKitGTK 2.52.6 中有两条绘制路径：

- **不合成时**：`RenderLayerScrollableArea::paintOverflowControls()` 注明 "Overlay scrollbars paint in a second pass through the layer tree so that they will paint on top of everything else"。`LocalFrameView::paintContents()` 先绘制整棵图层树，再调用 `paintOverlayScrollbars()`。
- **合成时**（GTK 默认开启 AsyncOverflowScrolling）：滚动条放在滚动容器的独立图层里，由 `ScrollerCoordinated` 用 Adwaita 样式绘制。实验表明它同样盖在浮层之上，具体是哪段代码决定的没有追到。

CSS 无法改变这个顺序：同版本 WebKit 中给浮层设置 `z-index`、`translateZ(0)`、`will-change`、`position: absolute`、`opacity`，或关闭 AsyncOverflowScrolling / ThreadedScrolling / 加速合成，细条依然穿过浮层。上游最接近的是 [bug 65259](https://bugs.webkit.org/show_bug.cgi?id=65259)（2011 年，macOS，仍为 NEW）。

原生 `title` 提示却能遮住它。

## 根因

WebKit 有意把浮动（overlay）滚动条画在所有内容之上。WebKitGTK 2.52.6 的 `RenderLayerScrollableArea::paintOverflowControls()`：

> Overlay scrollbars paint in a second pass through the layer tree so that they will paint on top of everything else.

`LocalFrameView::paintContents()` 先绘制整棵图层树，再调用 `paintOverlayScrollbars()`。这条路径最初为 macOS 浮动滚动条设计，GTK 的 Adwaita 滚动条同样使用。CSS 无法改变这个绘制顺序：同版本 WebKit 中给浮层设置 `z-index`、`translateZ(0)`、`will-change`、`position: absolute`、`opacity`，关闭 AsyncOverflowScrolling / ThreadedScrolling / 加速合成，细条依然穿过浮层。上游对应 [bug 65259](https://bugs.webkit.org/show_bug.cgi?id=65259)（2011 年，仍为 NEW）。

原生 `title` 提示是独立的 GTK 窗口，位于整个 WebView 之上，因此能遮住。Chromium（Electron、WebView2）的滚动条随滚动容器绘制并遵循层叠顺序，没有这个问题。

## 当前修复

保留原生滚动条，只在浮层打开期间隐藏页面滚动条：

- `index.css`：`html[data-overlay-scrollbars]` 且 `body` 下存在 `[data-radix-popper-content-wrapper]`（Tooltip、Popover、DropdownMenu、ContextMenu、HoverCard、Select）或 `[data-viewport-floating]`（`ViewportFloating`：斜杠菜单、双链建议、文件树右键菜单）时，对滚动容器设置 `scrollbar-width: none`；浮层内部的滚动条不受影响。
- `lib/core/scrollbars.ts`：启动时探测滚动条是否占布局宽度，仅在浮动滚动条下标记 `data-overlay-scrollbars`。浮动滚动条不占空间，隐藏时 `clientWidth` / `scrollWidth` / `scrollTop` 均不变，不会重排；Windows 经典滚动条不标记，避免每次悬停都重排。
- 选择器只列真正会滚动的类（`.agentero-scroll`、`.agentero-scroll-both`、`.overflow-auto`、`.overflow-x-auto`、`.overflow-y-auto`），因为每次浮层开关都会重新计算匹配元素的样式。

代价：浮层显示期间，页面滚动条暂时不显示。

## 被否决的方案

- **`GTK_OVERLAY_SCROLLING=0`**：改成经典滚动条后能被遮挡，但丢失闲置细长 / 悬停变粗的外观，并出现轨道边线。
- **Radix `ScrollArea` 自绘滚动条**：外观和遮挡都正确，但只覆盖文件树与 PDF，且要改动虚拟列表和 PDF 视口的 DOM 结构。
- **只用 `::-webkit-scrollbar`**（[nab-os/2kHz#21](https://github.com/nab-os/2kHz/pull/21)）：WebKit 会忽略同时设置了 `scrollbar-width` / `scrollbar-color` 的元素的伪元素样式；去掉这两个属性后，滚动条随容器绘制，可被遮挡。但它占 10px 布局宽度，外观不如原生；而且 WebKit 只在滚动容器自身样式变化时刷新滚动条，悬停显示需要额外技巧。
- **`scrollbar-color: transparent`**：滑块填充变透明，但仍留下 1px 边线穿过浮层。
- **全局 `*` 选择器隐藏**：2 万个元素时每次开关约 50ms；列出具体的滚动类后约 3ms。

## 验证方法

- 同版本 WebKitGTK 2.52.6 + WebKitWebDriver + Xvfb，开启 `webkitgtk:browserOptions.useOverlayScrollbars`（WebKitWebDriver 会覆盖启动环境中的 `GTK_OVERLAY_SCROLLING`）。滚动条悬停相关检查需要用 xdotool 发送真实指针事件，WebDriver 合成的事件不会触发。
- 浮层插入 `body` 后，滚动容器计算出的 `scrollbar-width` 为 `none`，截图中细条消失，`clientWidth` / `scrollTop` 不变；移除浮层后恢复。
- 应用以 `nix-shell shell.nix --run "pnpm tauri dev"` 编译运行；手动回归入口为侧栏精读、魔棒和 PDF 全文翻译 Tooltip，以及斜杠菜单、右键菜单、Select 下拉内部的滚动。
