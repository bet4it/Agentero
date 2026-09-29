# 组件约定

## AI Elements

Chat / Agent / 文件树 AI UI **统一使用** [AI Elements](https://elements.ai-sdk.dev/)。

- 落盘：`src/components/ai-elements/`
- 安装：`pnpm dlx shadcn@latest add https://elements.ai-sdk.dev/api/registry/<name>.json -y -o`
- 主题跟 shadcn token；**不是** Vercel AI SDK `useChat`（传输层为 ACP）。
- **禁止**新建 `src/components/ai/*` 或用 `ui/message` 搭 Chat。

常用：`conversation`、`message`、`prompt-input`、`sources`、`reasoning`、`file-tree`、queue 等。

Agent / Reasoning 消息里的 Markdown：`Streamdown` + `PlainTable` / `PlainCodeBlock`（代码块左上角语言标签，悬停复制/下载；无外侧卡片，见 [agent.md](agent.md)#消息-markdown-渲染）。

## 业务组件目录

| 目录 | 职责 |
|---|---|
| `components/shell/` | 三栏壳、标题栏、对话框挂载 |
| `components/sidebar/` | 文件树、Paper Info、魔棒 |
| `components/workspace/` | Dockview 宿主与 panel 内容 |
| `components/library/` | 论文库表 |
| `components/editor/` | Plate Markdown |
| `components/viewer/` | PDF / HTML / 图片。对外只经 `viewer/index.ts`；内部 `pdf/`（外壳 + `hooks/` + `layers/` + `chrome/` + `cards/` + `viewport/`）、`panels/`（右栏面板） |
| `components/agent/` | Agent 面板。外壳 + `hooks/`（面板与 composer 状态）+ `composer/`（输入区子件） |
| `components/wiki/` | 反链列表 / 引用近邻图（`graph-panel`） |
| `components/settings/` | 设置页 |
| `components/dialogs/` | 命令面板、权限、迁移等 |
| `components/ui/` | shadcn 基础件；`math-text.tsx` 用 KaTeX 渲染标题内联公式（`$\\pi$`） |

## 状态订阅

组件经 `hooks/use-app-stores.ts` selector 订阅；避免整树重渲染。命令式 dock/布局经 registry，不把 DOM ref 塞进 zustand。
