# oh-my-dsh

[![npm](https://img.shields.io/npm/v/oh-my-dsh?logo=npm)](https://www.npmjs.com/package/oh-my-dsh)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 中文

**开箱即用、适合日常写代码的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 发行版。**

DeepSeek Harness 提供了优秀的插件框架和一套保守的参考组合。`oh-my-dsh` 把这些零件装成一台能直接工作的机器：正式 profile、现有 agent 配置自动复用、LSP 导航、安全编辑、通知、usage 汇总和持久代码 kernel。

它是 Cordis bundle，不是 fork。上游“一切皆插件”的架构保持不变，每项默认选择都可以覆盖。

> DeepSeek Harness 仍处于 developer preview。`oh-my-dsh` 会锁定经过验证的上游版本，不会静默追随破坏性升级。

## 快速开始

需要 Node.js `^22.19.0` 或 `>=24.0.0`。

```sh
npm install --global oh-my-dsh
omd setup
omd
```

第一次 setup 可能需要几分钟。它会在 `~/.dsh/profiles/` 下安装两个隔离 profile：

- `omd`：交互式 Web UI。
- `omd-headless`：一次性终端任务。

不想全局安装也可以使用：

```sh
npx oh-my-dsh@latest setup
npx oh-my-dsh@latest
```

## 你会得到什么

### 打开就能工作的 coding profile

- 默认使用 `workspace-write + ask`：保持效率，但不会静默获得完整主机权限。
- 同时提供原生工具和上游 Code Mode。
- 显式配置 compaction、timeout、instruction budget 和 coding persona。
- 默认提供时区时间上下文、审批通知和长任务通知。
- 可通过 Web Models 页面使用上游多 provider 支持。

### 代码智能

内置 TypeScript/JavaScript、Python、JSON、HTML、CSS/SCSS/Less 和 YAML language server。PATH 中存在时，还会自动接入 `rust-analyzer`、`gopls`、`clangd` 和 `sourcekit-lsp`。

模型会获得上游只读 LSP 能力，用于 definition、references、implementation 和 hover。

### 复用已有 agent 配置

`oh-my-dsh` 原地读取兼容配置，不会复制或改写原文件：

- `AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.cursorrules`、always-on Cursor rules、Copilot instructions 和用户级 Claude/Codex 指令。
- 项目级和用户级 `.dsh`、`.agents`、`.claude`、`.cursor`、`.codex` skills。
- Claude、Cursor、Codex JSON/TOML 中的 MCP server。
- 上游支持的 Claude Code / Codex command hooks。
- Claude、Cursor、Codex 命令目录中的 Markdown commands。

项目 MCP、hooks 和导入 skills 只有在显式信任 Git 根目录后才会启用：

```sh
cd path/to/repository
omd trust add .
```

请先审查仓库。可信集成可能启动进程或使用凭据。

### 上游不会优先做的日用工具

- `hash_edit` 使用逐行 anchor 和最终 filesystem version guard，安全替换多行内容。
- `kernel` 提供 session 级持久 JavaScript/Python 状态，并能回调 dsh 工具。
- 可选 advisor 使用第二个模型复核已完成的顶层回合。
- `/usage` 显示当前会话；`omd usage` 汇总已持久化会话。
- 默认关闭的精选 MCP 预设：`memory`、`context7`、`playwright`。
- 随包提供 `review-changes`、`systematic-debugging`、`verify-before-done` skills。

## 常用命令

```sh
omd                              # 启动 Web UI
omd headless "修复失败的测试"     # 运行一个任务后退出
omd setup                        # 安装或升级两个 profiles
omd doctor                       # 检查安装状态
omd config                       # 输出最终 Cordis 组合
omd usage                        # 汇总已保存会话的 token usage
omd preset list                  # 查看精选 MCP 预设
omd preset enable context7       # 启用预设，重启后生效
omd trust add .                  # 信任当前仓库的项目集成
omd dsh --help                   # 直接调用底层 dsh CLI
```

## 配置

### 模型

在 Web Models 页面中配置 DeepSeek 或上游多 provider adapter。后者支持 OpenAI、Anthropic、Google、OpenRouter 和兼容网关。

### 搜索与抓取

搜索 provider 的选择顺序是：

1. `DSH_WEB_SEARCH_PROVIDER`
2. 存在 `EXA_API_KEY` 时使用 Exa
3. 存在 `PERPLEXITY_API_KEY` 时使用 Perplexity
4. DeepSeek search

上游 rc.6 尚未为 HTTP fetch 提供完整的 private-network/SSRF 防护，因此默认关闭：

```sh
OMD_ENABLE_WEB_FETCH=1 omd
```

只在明确接受该风险时启用。

### Advisor

只有同时配置下面两个值后 advisor 才会启用：

```sh
export OMD_ADVISOR_PROVIDER=anthropic
export OMD_ADVISOR_MODEL=claude-sonnet-4-5
omd
```

每次复核都会增加延迟和一次额外模型调用。

### 本地覆盖

修改 profile 自己的 `cordis.patch.yml` 可以覆盖该 profile；`omd setup` 会保留这些文件。`$DSH_HOME/cordis.patch.yml` 在所有 profile 之后应用，因此拥有最终优先级。

## 安全说明

- 可以选择 `danger-full-access`，但它永远不是默认值。
- 项目集成受 `omd trust` 保护。
- 可信 MCP 配置中的环境变量只在 host 侧展开，不会进入模型提示。
- dsh 无法确定当前文件时，不会把 glob-scoped Cursor rule 错误应用到全局。
- 持久 kernel 以当前主机用户身份执行；它默认需要审批，不是安全沙箱。
- dsh 没有 provider-neutral 定价接口，因此不会伪造金额。

## 架构

发布包是正式的 dsh bundle，组合顺序如下：

```text
@deepseek-ai/dsh-base
→ @deepseek-ai/dsh-web-app 或 @deepseek-ai/dsh-headless
→ oh-my-dsh
→ profile/cordis.patch.yml
→ $DSH_HOME/cordis.patch.yml
```

Bundle 位于 [`bundles/omd.cordis.yml`](bundles/omd.cordis.yml)，独立插件位于 [`packages/`](packages/)。

## 开发

```sh
git clone https://github.com/amplifthq/oh-my-dsh.git
cd oh-my-dsh
pnpm install
pnpm typecheck
pnpm test
./bin/omd setup
./bin/omd
```

## 许可

[MIT](LICENSE)。与 DeepSeek 无隶属或背书关系。
