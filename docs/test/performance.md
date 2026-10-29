# 性能测试轨迹

默认关闭。设置环境变量后，现有计时额外写成 JSONL。没有场景表，也不在进程里模拟滚动、打字或拖动分隔条。

可比的数是每一行的 `dur_us`。进程从启动到退出还包含启动器和窗口框架，不拿来和别的软件比。和 Zotero、Obsidian 的界面对比用录屏，不需要再改应用。

## 环境变量

| 变量 | 作用 |
|---|---|
| `AGENTERO_PERF_TRACE` | JSONL 绝对路径。非空才写文件。 |
| `AGENTERO_PERF` | `1` 或 `true`：一次性进程。见下文。 |
| `AGENTERO_PERF_VAULT` | 要打开的 Vault 绝对路径。 |
| `AGENTERO_PERF_OPEN` | Vault 内相对路径。目录走「打开论文」，文件走「打开路径」。用 `stat` 区分。 |
| `AGENTERO_PERF_TRACE_ID` | 可选。缺省时 Host 生成，并注入前端，两边同一条 trace。 |

`AGENTERO_PERF_TRACE` 单独设置只写 span，启动行为不变。`AGENTERO_PERF=1` 但不设 trace 路径时，会走一次性启动，不写文件。

`AGENTERO_PERF=1` 时：

- 不恢复上次 Vault，也不恢复已打开标签。
- 不把这次的 Vault、最近 Vault、已打开标签写回 localStorage。WebView 存储和日常应用是同一份，这一步避免覆盖用户会话。
- 跳过单实例插件，避免附着到已经打开的应用。
- 跳过更新检查、CLI 同步、遥测、功能引导、新手引导自动弹出、活动统计、版面模型预取。
- 打开 Vault 后仍刷新文件树、论文库和自定义属性；跳过 skill 种子、任务对账、入库对账和 arXiv 推荐。

## 怎么启动

直接运行二进制，环境变量才会进进程。macOS 的 `open` 不会把 shell 环境传进应用。

`pnpm tauri dev` 的数不是发行版的数。仓库里的 demo Vault 大约 5 篇论文，不能当作性能语料。不要打开日常应用正在使用的同一个 Vault，catalog SQLite 会锁住。

Host 的配置、缓存和 `usage.sqlite` 认 `XDG_CONFIG_HOME`、`XDG_CACHE_HOME`、`XDG_DATA_HOME`（`crates/agentero-core/src/paths.rs`）。这三项目录和 WebView 的 localStorage 不是同一处。

```bash
XDG_CONFIG_HOME=/tmp/agentero-perf-config \
XDG_CACHE_HOME=/tmp/agentero-perf-cache \
XDG_DATA_HOME=/tmp/agentero-perf-data \
AGENTERO_PERF=1 \
AGENTERO_PERF_VAULT=/absolute/path/to/vault \
AGENTERO_PERF_OPEN=papers/some-paper \
AGENTERO_PERF_TRACE=/tmp/agentero-perf.jsonl \
./src-tauri/target/release/agentero
```

打开结束后进程会关掉主窗口并退出。失败时文件里有一条 `perf_run`，`ok` 为 false，`fields` 是错误信息。成功没有这条 span。

## 一行的形状

```json
{"trace":"...","side":"host","name":"paper_list","dur_us":1200,"ok":true,"fields":"count=40"}
```

`side` 是 `host` 或 `ui`。`fields` 里 `kind=wait` 表示故意等待（文件监听合并、界面上的树 / 双链 / 论文库刷新延迟），不和后面的工作混在一个 span 里。

Host 与界面会对同一个名字各写一行：`vault_tree_build`、`paper_list`、`vault_search`、`graph_rebuild`。界面那一行包含 IPC；Host 那一行是进程内耗时。

打开 Vault 后，文件树、论文库、自定义属性都结束，再等两帧，记 `vault_interactive`（从页面导航起算）。若设置了 `AGENTERO_PERF_OPEN`，再记：

- `pdf_first_page`：PDF 文档第一次加载完成或失败，从发起打开起算。
- `notes_editor_ready`：Markdown 编辑器容器挂上，从发起打开起算。

只等实际出现的阅读器。配置在页面脚本之前注入为 `globalThis.__AGENTERO_PERF__`，启动代码不用再发一次 IPC。

桌面一次性性能运行由 `src/lib/shell/perf-run.ts` 编排 Vault 打开与工作区就绪；基础层 `src/lib/core/perf.ts` 只提供采样、标记与输出能力，不反向依赖 Vault 或 workspace。

## 限制与后续

未做语料生成、CI 回归门槛，也没有滚动、打字、分隔条的帧测试。这些不放进 Roadmap 条目；需要时再单独做。`docs/development/` 没有另一份待办清单。

## PDF 高清瓦片

512px / 768px 同视口出图对照、样本哈希、浏览器与原生验收边界见 [pdf-tiling-performance.md](pdf-tiling-performance.md)。只读光栅探针为 `test/scripts/benchmark-pdf-tiles.mjs`，不写 Vault，也不将 raw 出图耗时换算成应用 FPS。
