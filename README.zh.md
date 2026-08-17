<p align="center">
  <img src="https://raw.githubusercontent.com/amplifthq/oh-my-dsh/main/assets/hero.svg" alt="oh-my-dsh" width="800">
</p>

<p align="center">
  <strong>开箱即用的 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 精选发行版。</strong><br>
  Overlay，不是 fork。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/oh-my-dsh"><img src="https://img.shields.io/npm/v/oh-my-dsh?style=flat&colorA=222222&colorB=CB3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/oh-my-dsh"><img src="https://img.shields.io/npm/dm/oh-my-dsh?style=flat&colorA=222222&colorB=CB3837" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/amplifthq/oh-my-dsh?style=flat&colorA=222222&colorB=58A6FF" alt="license"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/oh-my-dsh?style=flat&colorA=222222&colorB=5FA04E" alt="Node.js"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | 中文
</p>

DeepSeek Harness 提供了优秀的插件框架和一套保守的参考组合。`oh-my-dsh` 把这些零件装成一台能直接工作的机器：正式 profile、惰性复用现有 MCP 配置、LSP 导航与可恢复语义改名、工作区 `@file` 引用、安全编辑、默认开启的 SSRF 加固网页抓取、可选 DAP 调试、通知、usage 汇总、持久代码 kernel，以及经审批把验证过的流程蒸馏成可复用技能的 skill forge。

它是 Cordis bundle，不是 fork。上游“一切皆插件”的架构保持不变，每项默认选择都可以覆盖。

> DeepSeek Harness 仍处于 developer preview。`oh-my-dsh` 会锁定经过验证的上游版本，不会静默追随破坏性升级。

## 快速开始

需要 Node.js `^22.19.0` 或 `>=24.0.0`。CI 覆盖 Linux 与 macOS（Node 22、24）；Windows 尚未测试，请使用 WSL2。

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
- 网页抓取默认开启，走 SSRF 加固 provider——私有、回环、链路本地和云 metadata 地址在请求前和建连时双重拦截。
- 默认提供时区时间上下文、审批通知、长任务通知，以及"输入排队在运行中回合之后"的提示。
- 启动目录会自动注册为 workspace，Web UI 选择器直接从你所在的位置开始。
- 可通过 Web Models 页面使用上游多 provider 支持。

### 代码智能

内置 TypeScript/JavaScript、Python、JSON、HTML、CSS/SCSS/Less 和 YAML language server。PATH 中存在时，还会自动接入 `rust-analyzer`、`gopls`、`clangd` 和 `sourcekit-lsp`。

模型会获得上游只读 LSP 能力，用于 definition、references、implementation 和 hover。`semantic_refactor` 额外提供可预览的符号改名：language server 返回多文件 edit 后，OMD 会验证所有路径和文件版本、展示精确 proposal、在一次审批后应用，并请求 diagnostics。发布中途失败会回滚已写文件；回滚不完整时会保留私有恢复日志。

### 复用已有 agent 配置

`oh-my-dsh` 原地读取兼容配置，不会复制或改写原文件：

- `AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.cursorrules`、always-on Cursor rules、Copilot instructions 和用户级 Claude/Codex 指令。
- 项目级和用户级 `.dsh`、`.agents`、`.claude`、`.cursor`、`.codex` skills。
- Claude、Cursor、Codex JSON/TOML 中的 MCP server；定义保持惰性，只有 session 显式激活时才启动。
- 上游支持的 Claude Code / Codex command hooks。
- Claude、Cursor、Codex 命令目录中的 Markdown commands。

项目 MCP、hooks 和导入 skills 只有在显式信任 Git 根目录后才会启用：

```sh
cd path/to/repository
omd trust add .
```

请先审查仓库。信任只会让项目定义进入目录；MCP 进程仍需单独创建激活 proposal 并审批。

### 惰性 MCP 能力控制

导入和预设 MCP server 在发现阶段不会启动进程、展开凭据或注入工具 schema。模型可以搜索 server 名和之前缓存的非敏感工具元数据，再创建激活 proposal。只有执行 `proposal_control apply` 才会为当前 agent session 启动该 server。

常用控制：

- `/omd-mcp [query]`：列出惰性与已激活 server，不会触发激活。
- `mcp_control`：列出、搜索，以及准备激活/停用 proposal。
- `proposal_control`：审批前展示命令或 URL path、脱敏后的参数、工作目录和配置来源，再应用或丢弃 proposal。
- 停用会 dispose 上游 MCP fiber 并移除对应工具。

### 精选插件库

`plugin_control` 把同一套 proposal 平面推进到 harness 本身。它先列出或查看审查过的 dsh 插件，再为当前 session 准备装载或卸载。发现和准备 proposal 时不会 import 插件包；只有你批准 `proposal_control apply` 后，系统才会核对已安装包的精确版本，以及审查过的 `name`/`provide`/`inject` manifest，然后 import 并通过 `agent.ctx.plugin()` 挂载。卸载调用 `fiber.dispose()`，由 Cordis 按逆序撤销插件注册的 effects。

这是 OMD 能授予的最高权限：插件激活后与 harness 同进程运行，拥有完整的环境变量、文件系统和网络权限。Proposal 会明确写出这一点。因此 v1 只能按 id 选择随包提供的 [`presets/plugins.json`](presets/plugins.json)；任意 npm 包名、路径、URL 和运行时安装在接口里都不可表达。`/omd-plugins` 显示插件可用性和当前 session 状态。

第一版插件库刻意只收一个上游插件：

- `dsh-skill-badge`——提供 DeepSeek 官方署名技能；固定在审查过的 `0.1.0-rc.6`，只有经批准的 session 装载才会激活。

准入和审查规则见[《精选插件库策展规范》](docs/organ-bank-curation.md)。

### 插件锻造

`plugin_forge` 是 skill forge 在能力轴上的对应物：Agent 可以为自己编写一个小型 dsh 插件（比如缺失的工具），把**完整源码**装进审批门控的 proposal。在你批准 `proposal_control apply` 之前不写盘、不挂载；批准后源码持久化到 `$DSH_HOME/forged-plugins/<slug>/`（scope `user`）或 `<workspace>/.dsh/forged-plugins/<slug>/`（scope `project`），校验你审查过的 SHA-256 摘要，再经与精选插件库相同的控制器挂载。卸载走 Cordis effects 逆序撤销；`prepare_load` 可在之后的会话里按同一摘要重新挂载已锻造的版本；`/omd-forged` 列出锻造插件的版本、摘要和 session 状态。

静态纪律在 proposal 创建之前强制执行：只接受合法 ESM（V8 经 `node --check` 解析，不执行任何代码）；静态 import 仅允许 `@deepseek-ai/cordis` 和 `@deepseek-ai/dsh-tools`；禁止动态 `import()` 和 `require`；源码 ≤ 32 KiB；必须导出 `name` 和 `apply`，挂载时与声明的 manifest 再次核对。import 白名单是为了审查清晰度，不是沙箱：进程内 JavaScript 无法被限制，注册工具的 execute 体仍能触及 `globalThis`、`fetch` 和 `process`。白名单保证每个模块依赖在审查时可见，但不限制运行时能力。锻造插件以 harness 的完整权限运行，而且这段代码是 Agent 在本次会话中写的——proposal 审查就是全部的信任决策，因此 proposal 携带完整源码、提取出的 import 清单、声明的预期 effects 和疑似密钥告警；commit 结果会把实际观测到的 Cordis effect 标签与声明并列展示。

### 能力发现平面

`capability_search` 是只读搜索入口，覆盖五类能力：模型可见 tools、skills、斜杠命令、惰性/已激活 MCP server，以及精选 session 插件。稳定引用形如 `tool:bash`、`mcp:omd-playwright`、`plugin:dsh-skill-badge`。每条结果带状态、摘要、来源，以及精确下一步：直接调用 tool、加载 skill、执行 `/command`，或走 `mcp_control` / `plugin_control` 的 prepare 动作。发现平面从不启动 MCP 进程、从不 import 包、从不展开凭据、也从不创建 proposal。人类侧对应命令是 `/omd-capabilities [查询]`。

### 上游不会优先做的日用工具

- `@file` 引用：在消息中用 `@path`、`@path:12-40` 或 `@"带空格的路径"` 引用工作区文件。被引用内容随同一 model step 注入、有大小上限，并渲染为 `hash_edit` 可直接使用的 anchor。仅做文本解析（输入框没有自动补全）；工作区之外的文件永远不会被注入。
- `hash_edit` 使用逐行 anchor 和最终 filesystem version guard，安全替换多行内容。
- `semantic_refactor` 创建带版本保护、可恢复的多文件 LSP 改名事务。
- `kernel` 提供 session 级持久 JavaScript/Python 状态，并能回调 dsh 工具。
- 可选 advisor 使用第二个模型复核已完成的顶层回合。
- `/usage` 显示当前会话；`omd usage` 汇总已持久化会话。
- 默认关闭的 DAP 调试：`debug_control` 为 `debugpy`、`lldb-dap` 或自定义 stdio adapter 准备 launch/attach proposal；只有批准后的 apply 才会启动 adapter 和被调试进程。
- 默认关闭的精选 MCP 预设：`memory`、`context7`、`playwright`。
- Skill forge：`skill_control prepare_save` 把本次会话里真正执行并验证过的流程蒸馏成持久的 `SKILL.md`；`/omd-distill [焦点]` 会排入一个起草回合。Proposal 携带精确的写前/写后全文和疑似密钥告警；只有你批准 `proposal_control apply` 后才落盘——原子写入、路径包含性校验、并发修改守卫。scope `project` 写入 `<workspace>/.dsh/skills/`（仅本仓库），scope `user` 写入 `$DSH_HOME/skills/`（所有项目）。上游 skill watcher 实时感知新文件，同一会话即可使用。上限：slug ≤ 41 字符、描述 ≤ 500 字符、正文 ≤ 32 KiB。
- 随包提供 `review-changes`、`systematic-debugging`、`verify-before-done`、`browser-use-cli` skills。
- 脚本式浏览器：随包的 `browser-use-cli` skill 让 Agent 通过普通 shell 工具把 Python 管道给经过审计的 `browser-use` CLI 来驱动真实浏览器，每次执行都走现有的命令审批。该 skill 默认使用一次性 profile 的隔离浏览器、强制关闭厂商遥测、禁止访问私网和云元数据地址；接管用户已登录的 Chrome 必须经过 Chrome 自身的授权弹窗。

## 常用命令

```sh
omd                              # 启动 Web UI
omd headless "修复失败的测试"     # 运行一个任务后退出
omd setup                        # 安装或升级两个 profiles
omd doctor                       # 安装状态、fetch 安全姿态、暴露的监听端口
omd config                       # 输出最终 Cordis 组合
omd usage                        # 汇总已保存会话的 token usage
omd preset list                  # 查看精选 MCP 预设
omd preset enable context7       # 将预设加入惰性 MCP 目录
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

HTTP fetch 默认开启，走 OMD 的加固 provider：IP 字面量和本地惯用域名在发出任何请求前就被拒绝，且每次 DNS 解析都会在建连时重新校验，重定向和 DNS rebinding 都无法触达回环、私有网段、链路本地或云 metadata 地址。上游自带的 provider 没有这层防护，这正是参考组合里 fetch 默认关闭的原因——OMD 选择补上防护而不是继承这份摩擦。（旧的 `OMD_ENABLE_WEB_FETCH` 开关已不再需要。）

```sh
OMD_DISABLE_WEB_FETCH=1 omd        # 彻底关闭 fetch 工具
OMD_WEB_FETCH_ALLOW_PRIVATE=1 omd  # 允许访问私有/内网地址（仅限可信网络）
DSH_WEB_FETCH_PROVIDER=http omd    # 显式退回上游无防护 provider
```

fetch 被关闭时，shell 里对公网 URL 的抓取（`curl`、`wget`、HTTPie）会转为审批提示，而不是静默绕过缺失的工具——这正是模型带着伪装浏览器 User-Agent 偷偷降级到 `curl` 的常见失败模式。对本地和私有地址的抓取（`curl localhost:3000`）永远不会被拦截。

### Advisor

只有同时配置下面两个值后 advisor 才会启用：

```sh
export OMD_ADVISOR_PROVIDER=anthropic
export OMD_ADVISOR_MODEL=claude-fable-5
omd
```

每次复核都会增加延迟和一次额外模型调用。

### 调试

DAP 调试默认关闭：

```sh
OMD_ENABLE_DEBUG=1 omd
```

`debug_control adapters` 列出发现结果：`debugpy`（`python3`/`python` 可 import 时）、`lldb-dap`（PATH 上存在时），以及插件配置里的自定义 stdio adapter。launch 和 attach 只会返回 proposal；必须经用户批准的 `proposal_control apply` 才会启动 adapter 和被调试进程。批准后的 session 支持断点、单步、栈与变量查看，以及在被调试进程内求值表达式——该求值能力会写进审批文本。被调试程序和断点文件必须位于工作区内；`runInTerminal` 反向请求会被拒绝。

### 本地覆盖

修改 profile 自己的 `cordis.patch.yml` 可以覆盖该 profile；`omd setup` 会保留这些文件。`$DSH_HOME/cordis.patch.yml` 在所有 profile 之后应用，因此拥有最终优先级。

### Proposal 与恢复生命周期

能力激活、debug launch/attach、技能保存和源码修改统一使用 `prepare → inspect → approve → commit → verify`。Proposal 只存在于当前 session，不能自行授权；应用时始终进入上游 approval service。

语义重构只接受纯文本 `WorkspaceEdit`。资源创建/删除/改名、server 主动发起的 `workspace/applyEdit` 和 `workspace/executeCommand` 都会被拒绝。恢复日志保存在 `$DSH_HOME/omd/refactors/`，权限为 `0600`；成功应用或回滚后删除。它保证中断后可恢复，但不宣称跨文件系统的崩溃原子性。

## 安全说明

- 可以选择 `danger-full-access`，但它永远不是默认值；提交已准备的 proposal 时仍会要求审批。
- 项目集成受 `omd trust` 保护。
- MCP 定义在发现阶段不会启动、展开环境变量或暴露 schema。只有审批激活后才在 host 侧展开，值不会进入模型提示或元数据缓存。
- 语义重构拒绝 session workspace 之外的 edit，并在写入前重新检查每个已观察文件的版本。
- `@file` 只注入工作区内的文件，有大小上限，并把附件当作数据而不是指令。
- 网页抓取在 URL 校验和 DNS 建连两个环节拦截私有、回环、链路本地和云 metadata 地址（对 rebinding 免疫）。`OMD_WEB_FETCH_ALLOW_PRIVATE=1` 会移除该防护；`DSH_WEB_FETCH_PROVIDER=http` 选择的上游 provider 没有这层防护。
- DAP 调试默认关闭，需 `OMD_ENABLE_DEBUG=1`。launch 和 attach 仍要经过批准的 proposal；被调试路径必须位于工作区内。
- dsh 无法确定当前文件时，不会把 glob-scoped Cursor rule 错误应用到全局。
- 持久 kernel 以当前主机用户身份执行；它默认需要审批，不是安全沙箱。
- dsh 没有 provider-neutral 定价接口，因此不会伪造金额。

## 兼容性

| oh-my-dsh | DeepSeek Harness（`@deepseek-ai/dsh*`） | Node.js                  |
| --------- | --------------------------------------- | ------------------------ |
| 0.1.x     | `0.1.0-rc.6`（精确锁定）                | `^22.19.0 \|\| >=24.0.0` |

上游仍处于 developer preview，因此 `oh-my-dsh` 锁定一个经过验证的版本，绝不静默追随破坏性变更。[每周 canary 工作流](.github/workflows/canary.yml)会额外用 `dsh@next` 测试 overlay，上游即将发布的不兼容变更会先变成 issue，而不是先砸到用户。升级流程见 [docs/upstream-upgrade-playbook.md](docs/upstream-upgrade-playbook.md)。

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

贡献流程和分支规则见 [CONTRIBUTING.md](CONTRIBUTING.md)，其中「Good first contributions」一节列出了门槛最低的入口（内置技能、curated MCP preset、对抗性测试）。改动该放在 overlay 还是上游，见[《为什么是 overlay 而不是 fork》](docs/why-an-overlay-not-a-fork.md)。

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
