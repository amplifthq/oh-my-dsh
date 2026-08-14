# oh-my-dsh

[![npm](https://img.shields.io/npm/v/oh-my-dsh?logo=npm)](https://www.npmjs.com/package/oh-my-dsh)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [中文](README.zh.md)

**A batteries-included, daily-driver distribution of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

DeepSeek Harness provides an excellent plugin framework and a conservative reference setup. `oh-my-dsh` turns those building blocks into an opinionated coding environment: sensible profiles, automatic reuse of your existing agent configuration, LSP navigation, stale-safe editing, notifications, usage reporting, and persistent code kernels.

It is a Cordis bundle, not a fork. You keep upstream's “everything is a plugin” architecture and can override every choice.

> DeepSeek Harness is in developer preview. `oh-my-dsh` pins a tested upstream release instead of silently following breaking changes.

## Quick start

Requires Node.js `^22.19.0` or `>=24.0.0`.

```sh
npm install --global oh-my-dsh
omd setup
omd
```

The first setup can take several minutes. It installs two isolated profiles under `~/.dsh/profiles/`:

- `omd` — interactive Web UI.
- `omd-headless` — one-shot terminal tasks.

Prefer not to install globally?

```sh
npx oh-my-dsh@latest setup
npx oh-my-dsh@latest
```

## What you get

### A coding profile that is useful immediately

- `workspace-write + ask` permissions: productive by default without silently granting full host access.
- Native tools and upstream Code Mode available together.
- Explicit compaction, timeout, instruction-budget, and coding-persona defaults.
- Zoned time context and desktop notifications for approvals and long-running turns.
- Upstream multi-provider support through the Web Models page.

### Code intelligence

Bundled language servers cover TypeScript/JavaScript, Python, JSON, HTML, CSS/SCSS/Less, and YAML. If installed on your PATH, `rust-analyzer`, `gopls`, `clangd`, and `sourcekit-lsp` are discovered automatically.

The model receives upstream's read-only LSP operations for definitions, references, implementations, and hover.

### Reuse your existing agent setup

`oh-my-dsh` reads compatible configuration in place; it does not copy or rewrite it:

- Instructions from `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, always-on Cursor rules, Copilot instructions, and user-level Claude/Codex files.
- Skills from project and user `.dsh`, `.agents`, `.claude`, `.cursor`, and `.codex` roots.
- MCP servers from Claude, Cursor, and Codex JSON/TOML configuration.
- Supported Claude Code and Codex command hooks.
- Markdown commands from Claude, Cursor, and Codex command directories.

Project MCP, hooks, and imported skills are disabled until you explicitly trust the Git root:

```sh
cd path/to/repository
omd trust add .
```

Review the repository first. Trusted integrations may start processes or consume credentials.

### Daily-use tools upstream does not prioritize

- `hash_edit` performs stale-safe multi-line replacement using per-line anchors and a final filesystem version guard.
- `kernel` provides session-persistent JavaScript and Python state, with callbacks into dsh tools.
- An optional second-model advisor reviews completed top-level turns.
- `/usage` reports the live session; `omd usage` aggregates persisted sessions.
- Curated, opt-in MCP presets: `memory`, `context7`, and `playwright`.
- Bundled skills: `review-changes`, `systematic-debugging`, and `verify-before-done`.

## Commands

```sh
omd                              # start the Web UI
omd headless "fix the tests"     # run one task and exit
omd setup                        # install or upgrade both profiles
omd doctor                       # inspect installation status
omd config                       # print the final Cordis composition
omd usage                        # aggregate saved-session token usage
omd preset list                  # list curated MCP presets
omd preset enable context7       # enable a preset; restart to apply
omd trust add .                  # trust this repository's integrations
omd dsh --help                   # invoke the underlying dsh CLI
```

## Configuration

### Models

Configure DeepSeek or upstream's multi-provider adapter in the Web Models page. The latter supports OpenAI, Anthropic, Google, OpenRouter, and compatible gateways.

### Search and fetch

Search selection follows:

1. `DSH_WEB_SEARCH_PROVIDER`
2. Exa when `EXA_API_KEY` is present
3. Perplexity when `PERPLEXITY_API_KEY` is present
4. DeepSeek search

HTTP fetch is off by default because upstream rc.6 does not yet provide complete private-network/SSRF protection:

```sh
OMD_ENABLE_WEB_FETCH=1 omd
```

Enable it only when you accept that risk.

### Advisor

The advisor is disabled until both values are configured:

```sh
export OMD_ADVISOR_PROVIDER=anthropic
export OMD_ADVISOR_MODEL=claude-sonnet-4-5
omd
```

It adds latency and another model call to each reviewed turn.

### Local overrides

Edit either profile's `cordis.patch.yml` for profile-specific changes. `omd setup` preserves these files. `$DSH_HOME/cordis.patch.yml` applies after every profile and therefore has the final word.

## Security notes

- `danger-full-access` is available but never the default.
- Project integrations are gated by `omd trust`.
- Environment placeholders in trusted MCP configuration are expanded on the host and are never injected into prompts.
- Glob-scoped Cursor rules are not applied globally when dsh cannot determine the active file.
- Persistent kernels execute as your host user. They require approval by default and are not a sandbox.
- Monetary cost is not estimated because dsh does not expose provider-neutral pricing.

## Architecture

The published package is a formal dsh bundle. Its composition order is:

```text
@deepseek-ai/dsh-base
→ @deepseek-ai/dsh-web-app or @deepseek-ai/dsh-headless
→ oh-my-dsh
→ profile/cordis.patch.yml
→ $DSH_HOME/cordis.patch.yml
```

The bundle lives in [`bundles/omd.cordis.yml`](bundles/omd.cordis.yml); individual plugins live under [`packages/`](packages/).

## Development

```sh
git clone https://github.com/amplifthq/oh-my-dsh.git
cd oh-my-dsh
pnpm install
pnpm typecheck
pnpm test
./bin/omd setup
./bin/omd
```

## License

[MIT](LICENSE). Not affiliated with or endorsed by DeepSeek.
