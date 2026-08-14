# oh-my-dsh

English | [中文](README.zh.md)

An opinionated, daily-driver distribution layer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It is not a fork. `oh-my-dsh` is a formal dsh profile plus a Cordis plugin bundle: upstream keeps its “everything is a plugin” architecture, while this package adds cross-tool discovery, code navigation, stale-safe editing, notifications, usage reporting, an optional advisor, and persistent code kernels.

> DeepSeek Harness is still in developer preview. oh-my-dsh pins a compatible upstream version and validates upgrades deliberately.

## Install

Requires Node `^22.19 || >=24`.

After the package is published:

```sh
npx oh-my-dsh setup
npx oh-my-dsh
```

Or install globally:

```sh
npm install -g oh-my-dsh
omd setup
omd
```

From source:

```sh
git clone https://github.com/amplifthq/oh-my-dsh.git
cd oh-my-dsh
pnpm install
pnpm build
./bin/omd setup
./bin/omd
```

`setup` creates two formal profiles under `$DSH_HOME/profiles/` (normally `~/.dsh/profiles/`):

- `omd` for the Web UI.
- `omd-headless` for one-shot tasks.

Put personal overrides in each profile's `cordis.patch.yml`; later `omd setup` upgrades preserve that file.

## Commands

```sh
omd                              # start the Web UI
omd headless "fix the tests"     # run one task and exit
omd config                       # print the final composition
omd doctor                       # inspect installation status
omd usage                        # sum token usage from saved sessions
omd preset list                  # list curated MCP presets
omd preset enable context7       # enable a preset; restart to apply
omd trust add .                  # trust this repo's imported integrations
omd dsh --help                   # invoke the underlying dsh CLI
```

## Layer 1: a daily-driver distribution

The profile defaults to `workspace-write + ask`, exposes both native tools and upstream Code Mode, uses explicit compaction and timeout policies, enables time context, and supplies a coding persona centered on small changes, preservation of user work, and evidence before completion.

Upstream's dormant `llm-pi-ai` adapter remains available through the Web Models page for OpenAI, Anthropic, Google, OpenRouter, and compatible gateways.

### LSP included

TypeScript/JavaScript, Python, JSON, HTML, CSS/SCSS/Less, and YAML language servers are bundled. `rust-analyzer`, `gopls`, `clangd`, and `sourcekit-lsp` are added when found on PATH.

The model gets upstream's read-only `lsp` tool for definitions, references, implementations, and hover.

### Cross-tool discovery

Existing files are read in place and never rewritten:

- Instructions: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, global Claude/Codex instructions, `.cursorrules`, always-on `.cursor/rules/*.mdc`, and Copilot instructions.
- Skills: project and user `.dsh`, `.agents`, `.claude`, `.cursor`, and `.codex` skill roots.
- MCP: user and project Claude, Cursor, and Codex configurations. `${env:NAME}` expands only in host configuration and never enters prompts.
- Hooks: the command-hook subset supported by upstream's Claude Code and Codex bridges.
- Commands: Markdown commands from `.claude/commands`, `.cursor/commands`, and `.codex/prompts` become dsh slash commands; native dsh commands win collisions.

Scoped Cursor rules with globs are not injected globally because dsh does not currently expose a current-file scope. Applying them everywhere would be incorrect.

Project MCP, hooks, and cross-tool skills can start processes or indirectly consume credentials, so they are skipped by default. Run `omd trust add <path>` only after reviewing the repository. Trust is persisted by Git root, and Web sessions discover project integrations from their own workspace. User-home configuration remains user-managed.

### Web search and fetch

Search selects `DSH_WEB_SEARCH_PROVIDER`, then Exa when `EXA_API_KEY` exists, Perplexity when `PERPLEXITY_API_KEY` exists, and finally DeepSeek search.

Upstream rc.6's HTTP fetch provider does not yet provide complete private-network/SSRF protection, so fetch is off by default. Set `OMD_ENABLE_WEB_FETCH=1` only when you explicitly accept that risk.

## Layer 2: daily-use gaps

- `hash_edit` reads `line:hash|text` anchors and requires every `expected_anchors` entry in an inclusive replacement range. Any changed interior or boundary line produces a stale-anchor error before the version-guarded write.
- The optional advisor reviews each completed top-level turn with a second provider/model and injects only actionable concerns into the next step.
- Desktop notifications fire for approval requests and turns longer than 15 seconds.
- `/usage` reports the current session; `omd usage` aggregates saved sessions. Monetary cost is explicitly unavailable because dsh has no provider-neutral pricing contract.
- `kernel` provides session-persistent JavaScript (`state`) and Python globals. Cells can call dsh tools with `await tool(name, args)` or `tool(name, args)`. Kernel calls require approval by default and are not a security sandbox.
- Optional MCP presets: `memory`, `context7`, and `playwright`.
- Bundled skills: `review-changes`, `systematic-debugging`, and `verify-before-done`.

Enable the advisor with:

```sh
export OMD_ADVISOR_PROVIDER=anthropic
export OMD_ADVISOR_MODEL=claude-sonnet-4-5
omd
```

## Architecture and development

The bundle is [`bundles/omd.cordis.yml`](bundles/omd.cordis.yml); plugins live in `packages/*`. The published package exposes a formal `dsh.bundle.patch`. Composition order is:

```text
@deepseek-ai/dsh-base
→ @deepseek-ai/dsh-web-app or @deepseek-ai/dsh-headless
→ oh-my-dsh
→ profile/cordis.patch.yml
→ $DSH_HOME/cordis.patch.yml
```

Local verification:

```sh
pnpm typecheck
pnpm test
./bin/omd config
```

## License

[MIT](LICENSE). Not affiliated with or endorsed by DeepSeek.
