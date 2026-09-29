# Linux 浮动滚动指示器穿过 Tooltip

## 现象与原因

文件树的精读 / 魔棒、PDF 全文翻译等 HTML Tooltip 无法遮住 GTK 滚动条闲置时的细长指示器；悬停论文标题时的原生 `title` 提示却能遮住它。

GTK 的 overlay scrollbar 由 WebKit 的滚动合成路径绘制。WebKitGTK 2.52.6 中，这条细长指示器可以画到网页浮层上方，增加 `z-index`、提升到 Popover 顶层、将滑块颜色设为透明均不能解决实际应用里的问题。原生 `title` 提示属于系统窗口，因此表现不同。

## 修复

在桌面 `main()` 最开始、GTK/WebKit 和工作线程初始化之前，仅 Linux 设置 `GTK_OVERLAY_SCROLLING=0`。所有 WebView 统一使用普通滚动条，HTML Tooltip 可以正常遮挡；滚动条保持固定粗细，不再切换成浮动指示器。无需修改各 Tooltip 的位置、背景或打开逻辑。

这采用了 [Tauri 上游的处理方式](https://github.com/orgs/tauri-apps/discussions/5689)。[WebKit 的实现](https://github.com/WebKit/WebKit/blob/webkitgtk-2.52.6/Source/WebCore/platform/adwaita/ScrollbarThemeAdwaita.cpp) 在 `usesOverlayScrollbars()` 中读取该变量。

## 验证

- 同版本 WebKitGTK 2.52.6 + WebKitWebDriver，在独立 Xvfb 显示器中使用溢出容器和跨越滚动条的实色浮层进行对照：开启 overlay 时细条穿过浮层，关闭后浮层完整遮挡，未被覆盖的滑块仍可见。
- 关闭 overlay 后拖动滑块，`scrollTop` 从 30 变为 568，验证拖动滚动仍正常。
- WebKitWebDriver 会覆盖启动环境中的 `GTK_OVERLAY_SCROLLING`；对照实验必须通过 `webkitgtk:browserOptions.useOverlayScrollbars` 设置，不能只给 driver 进程传环境变量。
- 应用已通过 `nix-shell shell.nix --run "pnpm tauri dev"` 编译运行；手动回归入口为侧栏精读、魔棒和 PDF 全文翻译 Tooltip。
