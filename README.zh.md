# oh-my-dsh

[English](README.md) | 中文

一个有态度、可直接日用的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 发行层。

它不是 fork。`oh-my-dsh` 是正式的 dsh profile + Cordis 插件 bundle：保留上游“一切皆插件”的架构，同时补齐跨工具配置发现、代码导航、安全编辑、通知、usage、advisor 和持久代码运行时。

> DeepSeek Harness 仍处于 developer preview。oh-my-dsh 精确锁定兼容的上游版本，升级时主动验证，不自动追最新版。

## 安装

需要 Node `^22.19 || >=24`。

发布到 npm 后：

```sh
npx oh-my-dsh setup
npx oh-my-dsh
```

或全局安装：

```sh
npm install -g oh-my-dsh
omd setup
omd
```

从源码试用：

```sh
git clone https://github.com/amplifthq/oh-my-dsh.git
cd oh-my-dsh
pnpm install
pnpm build
./bin/omd setup
./bin/omd
```

`setup` 会在 `$DSH_HOME/profiles/`（默认 `~/.dsh/profiles/`）创建两个正式 profile：

- `omd`：Web UI。
- `omd-headless`：一次性无界面任务。

用户覆盖写在 profile 自己的 `cordis.patch.yml`；后续 `omd setup` 会保留它。

## 常用命令

```sh
omd                              # 启动 Web UI
omd headless "修复失败的测试"     # 运行一个任务后退出
omd config                       # 输出最终组合树
omd doctor                       # 检查安装状态
omd usage                        # 汇总本地已保存会话的 token usage
omd preset list                  # 查看精选 MCP 预设
omd preset enable context7       # 启用预设，重启后生效
omd trust add .                  # 信任当前项目的 MCP/hooks/跨工具 skills
omd dsh --help                   # 直接调用底层 dsh CLI
```

## Layer 1：日用发行版

### 有态度的 coding profile

- 默认 `workspace-write + ask`，不默认开危险全权限。
- 同时提供原生工具和上游 Code Mode。
- 自动压缩阈值、保留窗口、搜索/抓取超时和 workspace instruction 预算已显式配置。
- coding persona 强制先检查、做最小正确改动、保留用户工作，并在完成前拿到新鲜验证证据。
- 上游 `dsh-time-context` 默认启用。
- `llm-pi-ai` 使用上游完整 provider 目录；可在 Web Models 页面添加 OpenAI、Anthropic、Google、OpenRouter、兼容网关等 provider。

### 开箱即用的 LSP

内置 TypeScript/JavaScript、Python、JSON、HTML、CSS/SCSS/Less、YAML language server。PATH 中存在时还会自动接入 `rust-analyzer`、`gopls`、`clangd` 和 `sourcekit-lsp`。

模型获得上游只读 `lsp` 工具，用于 definition、references、implementation 和 hover；普通导航仍优先使用 search/read。

### 跨工具发现

启动时会读取现有配置，但不会改写原文件：

- Instructions：`AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、全局 Claude/Codex 指令、`.cursorrules`、always-on `.cursor/rules/*.mdc`、Copilot instructions。
- Skills：项目和用户级 `.dsh`、`.agents`、`.claude`、`.cursor`、`.codex` skill 目录。
- MCP：Claude、Cursor、Codex 的用户级与项目级 MCP 配置；`${env:NAME}` 只在 host 配置中展开，不进入模型提示。
- Hooks：上游 Claude Code / Codex hook bridge 能处理的 command-hook 子集。
- Commands：`.claude/commands`、`.cursor/commands`、`.codex/prompts` 中的 Markdown 命令会注册成 dsh slash command；原生 dsh 命令在重名时优先。

带 glob 且不是 `alwaysApply` 的 Cursor rule 不会被全局注入，因为 dsh 当前没有“当前文件”作用域；静默全量注入反而会错误应用规则。

项目内的 MCP、hooks 和跨工具 skills 可能启动进程或间接使用凭据，因此默认跳过。确认仓库可信后执行 `omd trust add <path>`；用户主目录中的配置视为用户自己管理。信任按 Git 根目录持久化，Web 中每个 session 按自己的 workspace 发现项目配置。

### Web 能力

搜索 provider 按以下顺序选择：

1. `DSH_WEB_SEARCH_PROVIDER`
2. 存在 `EXA_API_KEY` 时用 Exa
3. 存在 `PERPLEXITY_API_KEY` 时用 Perplexity
4. 否则使用 DeepSeek search

上游 rc.6 的 HTTP fetch provider 没有完整 SSRF/private-network 防护，因此安全默认下关闭。仅在明确接受该风险时设置 `OMD_ENABLE_WEB_FETCH=1`。

## Layer 2：日用缺口

### `hash_edit`

`hash_edit read` 输出 `line:hash|text`。`replace` 使用首尾 anchor 和覆盖范围内的完整 `expected_anchors` 原子替换整段，`insert_after` 使用单个 anchor。范围内任意一行变化都会触发 stale-anchor 错误，阻止模型把旧上下文写回新文件；最终写入仍经过 dsh 的 filesystem policy、版本 guard 和 sandbox。

### Advisor

Advisor 默认关闭。配置独立 provider/model 后，它会在每个顶层回合完成后做一次有界复核，只把具体问题注入下一步，不会自行唤醒 agent 或形成自运行循环。

```sh
export OMD_ADVISOR_PROVIDER=anthropic
export OMD_ADVISOR_MODEL=claude-sonnet-4-5
omd
```

### 通知与 usage

- 运行超过 15 秒的回合结束时发桌面通知（macOS/Linux）。
- 需要人工审批时立即通知。
- Web 中 `/usage` 显示当前会话 token；`omd usage` 汇总本地持久化会话。
- dsh 当前没有 provider-neutral 定价接口，因此不会伪造金额；输出会明确标记 cost unavailable。

### 持久 kernel

`kernel` 提供 session-scoped JavaScript 和 Python 状态：

- JavaScript 值保存在 `state`。
- Python 普通变量跨 cell 保留。
- JavaScript 用 `await tool(name, args)`、Python 用 `tool(name, args)` 回调同一套 dsh 工具。
- `reset: true` 清理对应语言状态。

Kernel 等价于执行本机代码，默认每次调用都走 approval。JavaScript 子进程不继承环境变量；Python 只继承 PATH 和编码设置。它不是安全沙箱。

### 精选 MCP 与 skills

内置 MCP 预设默认关闭：

- `memory`：本地持久 knowledge graph。
- `context7`：最新库文档。
- `playwright`：浏览器自动化。

随包提供 `review-changes`、`systematic-debugging`、`verify-before-done` 三个精简 skill，项目级同名 skill 可覆盖它们。

## 配置与开发

Bundle 在 [`bundles/omd.cordis.yml`](bundles/omd.cordis.yml)，插件在 `packages/*`。发布包通过 `dsh.bundle.patch` 暴露正式 bundle，profile 的 bundle 顺序是：

```text
@deepseek-ai/dsh-base
→ @deepseek-ai/dsh-web-app 或 @deepseek-ai/dsh-headless
→ oh-my-dsh
→ profile/cordis.patch.yml
→ $DSH_HOME/cordis.patch.yml
```

本地校验：

```sh
pnpm typecheck
pnpm test
./bin/omd config
```

## 许可

[MIT](LICENSE)。与 DeepSeek 无隶属或背书关系。
