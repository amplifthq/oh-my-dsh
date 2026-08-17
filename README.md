<p align="center">
  <img src="https://raw.githubusercontent.com/amplifthq/oh-my-dsh/main/assets/hero.svg" alt="oh-my-dsh" width="800">
</p>

<p align="center">
  <strong>A curated distribution of <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>.</strong><br>
  Overlay, not a fork.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/oh-my-dsh"><img src="https://img.shields.io/npm/v/oh-my-dsh?style=flat&colorA=222222&colorB=CB3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/oh-my-dsh"><img src="https://img.shields.io/npm/dm/oh-my-dsh?style=flat&colorA=222222&colorB=CB3837" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/amplifthq/oh-my-dsh?style=flat&colorA=222222&colorB=58A6FF" alt="license"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/oh-my-dsh?style=flat&colorA=222222&colorB=5FA04E" alt="Node.js"></a>
</p>

<p align="center">
  English | <a href="README.zh.md">中文</a>
</p>

DeepSeek Harness provides an excellent plugin framework and a conservative reference setup. `oh-my-dsh` turns those building blocks into an opinionated coding environment: sensible profiles, inert reuse of your existing MCP configuration, LSP navigation and recoverable semantic rename, workspace `@file` mentions, stale-safe editing, SSRF-hardened web fetch on by default, optional DAP debugging, notifications, usage reporting, and persistent code kernels.

It is a Cordis bundle, not a fork. You keep upstream's “everything is a plugin” architecture and can override every choice.

> DeepSeek Harness is in developer preview. `oh-my-dsh` pins a tested upstream release instead of silently following breaking changes.

## Quick start

Requires Node.js `^22.19.0` or `>=24.0.0`. CI covers Linux and macOS on Node 22 and 24; Windows is not yet tested — use WSL2.

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
- Web fetch on by default through an SSRF-hardened provider — private, loopback, link-local, and cloud-metadata destinations are blocked before the request and again at connect time.
- Zoned time context and desktop notifications for approvals, long-running turns, and input queued behind a running turn.
- The launch directory is pre-registered as a workspace, so the Web UI picker starts where you are.
- Upstream multi-provider support through the Web Models page.

### Code intelligence

Bundled language servers cover TypeScript/JavaScript, Python, JSON, HTML, CSS/SCSS/Less, and YAML. If installed on your PATH, `rust-analyzer`, `gopls`, `clangd`, and `sourcekit-lsp` are discovered automatically.

The model receives upstream's read-only LSP operations for definitions, references, implementations, and hover. `semantic_refactor` adds previewable symbol rename: the language server returns a multi-file edit, OMD validates every path and file version, shows an exact proposal, applies it after one approval, and requests diagnostics. Failed publication rolls back completed writes; an incomplete rollback leaves a private recovery journal.

### Reuse your existing agent setup

`oh-my-dsh` reads compatible configuration in place; it does not copy or rewrite it:

- Instructions from `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, always-on Cursor rules, Copilot instructions, and user-level Claude/Codex files.
- Skills from project and user `.dsh`, `.agents`, `.claude`, `.cursor`, and `.codex` roots.
- MCP servers from Claude, Cursor, and Codex JSON/TOML configuration. Definitions stay inert until a session explicitly activates one.
- Supported Claude Code and Codex command hooks.
- Markdown commands from Claude, Cursor, and Codex command directories.

Project MCP, hooks, and imported skills are disabled until you explicitly trust the Git root:

```sh
cd path/to/repository
omd trust add .
```

Review the repository first. Trust makes project definitions discoverable; an MCP process still requires a separate activation proposal and approval.

### Lazy MCP capability control

Imported and preset MCP servers are catalogued without starting a process, expanding credentials, or injecting tool schemas. The model can search server names and previously cached non-secret tool metadata, then prepare an activation proposal. Only `proposal_control apply` starts that server for the current agent session.

Useful controls:

- `/omd-mcp [query]` lists inert and active servers without activating them.
- `mcp_control` lists, searches, and prepares activation or deactivation.
- `proposal_control` shows the command or URL path, arguments with credential values redacted, working directory, and source config before applying with user approval.
- Deactivation disposes the upstream MCP fiber and removes its tools.

### Daily-use tools upstream does not prioritize

- `@file` mentions: reference workspace files in your message as `@path`, `@path:12-40`, or `@"path with spaces"`. The mentioned content is attached to the same model step, bounded in size, and rendered as `hash_edit`-compatible anchors. Parsing is text-only (no composer autocomplete); files outside the workspace are never attached.
- `hash_edit` performs stale-safe multi-line replacement using per-line anchors and a final filesystem version guard.
- `semantic_refactor` prepares version-guarded, recoverable multi-file LSP rename transactions.
- `kernel` provides session-persistent JavaScript and Python state, with callbacks into dsh tools.
- An optional second-model advisor reviews completed top-level turns.
- `/usage` reports the live session; `omd usage` aggregates persisted sessions.
- Opt-in DAP debugging: `debug_control` prepares launch and attach proposals for `debugpy`, `lldb-dap`, or custom stdio adapters; only an approved apply starts the adapter and debuggee.
- Curated, opt-in MCP presets: `memory`, `context7`, and `playwright`.
- Bundled skills: `review-changes`, `systematic-debugging`, and `verify-before-done`.

## Commands

```sh
omd                              # start the Web UI
omd headless "fix the tests"     # run one task and exit
omd setup                        # install or upgrade both profiles
omd doctor                       # installation status, web fetch posture, exposed listeners
omd config                       # print the final Cordis composition
omd usage                        # aggregate saved-session token usage
omd preset list                  # list curated MCP presets
omd preset enable context7       # add a preset to the inert MCP catalog
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

HTTP fetch is on by default and routes through OMD's hardened provider. IP-literal and conventionally-local destinations are rejected before any request, and every DNS resolution is re-validated at connect time, so redirects and DNS rebinding cannot reach loopback, private-range, link-local, or cloud-metadata addresses. Upstream's own provider ships without this protection, which is why fetch stays off in the reference setup — OMD closes the gap instead of inheriting the friction. (The previous `OMD_ENABLE_WEB_FETCH` opt-in is superseded.)

```sh
OMD_DISABLE_WEB_FETCH=1 omd        # turn the fetch tool off entirely
OMD_WEB_FETCH_ALLOW_PRIVATE=1 omd  # allow private/internal destinations (trusted networks only)
DSH_WEB_FETCH_PROVIDER=http omd    # explicit opt-out to upstream's unprotected provider
```

When fetch is disabled, shell fetches of public URLs (`curl`, `wget`, HTTPie) prompt for approval instead of silently bypassing the missing tool — the common failure mode where a model degrades to `curl` with a spoofed browser User-Agent. Fetches of local and private URLs (`curl localhost:3000`) are never intercepted.

### Advisor

The advisor is disabled until both values are configured:

```sh
export OMD_ADVISOR_PROVIDER=anthropic
export OMD_ADVISOR_MODEL=claude-fable-5
omd
```

It adds latency and another model call to each reviewed turn.

### Debugging

Debug Adapter Protocol support is off by default:

```sh
OMD_ENABLE_DEBUG=1 omd
```

`debug_control adapters` lists what was discovered: `debugpy` (when importable by `python3`/`python`), `lldb-dap` (when on PATH), plus custom stdio adapters from plugin configuration. Launching or attaching always returns a proposal; only `proposal_control apply` with user approval spawns the adapter and debuggee. An approved session supports breakpoints, stepping, stack and variable inspection, and expression evaluation inside the debuggee process — that evaluation capability is stated in the approval text. Debuggee programs and breakpoint files must stay inside the workspace, and `runInTerminal` reverse requests are rejected.

### Local overrides

Edit either profile's `cordis.patch.yml` for profile-specific changes. `omd setup` preserves these files. `$DSH_HOME/cordis.patch.yml` applies after every profile and therefore has the final word.

### Proposal and recovery lifecycle

Capability activation, debug launch/attach, and source mutation use the same `prepare → inspect → approve → commit → verify` lifecycle. A proposal is session-local and cannot authorize itself; applying it always reaches the upstream approval service.

Semantic refactors accept text-only `WorkspaceEdit` results. Resource create/delete/rename operations, server-driven `workspace/applyEdit`, and `workspace/executeCommand` are rejected. Recovery journals live under `$DSH_HOME/omd/refactors/` with mode `0600` and are deleted after successful apply or rollback. They make interrupted work recoverable, but do not claim filesystem-wide crash atomicity.

## Security notes

- `danger-full-access` is available but never the default. It still asks before committing a prepared proposal.
- Project integrations are gated by `omd trust`.
- MCP definitions do not start, expand environment placeholders, or expose schemas during discovery. Expansion happens on the host only after an approved activation and values never enter prompts or metadata caches.
- Semantic refactors reject edits outside the session workspace and recheck every observed file version before writing.
- `@file` mentions attach only workspace files, stay bounded, and treat attached content as data rather than instructions.
- Web fetch blocks private, loopback, link-local, and cloud-metadata destinations both at URL validation and at DNS-connect time (rebinding-safe). `OMD_WEB_FETCH_ALLOW_PRIVATE=1` removes that guard; `DSH_WEB_FETCH_PROVIDER=http` selects upstream's provider, which has no such protection.
- DAP debugging is off until `OMD_ENABLE_DEBUG=1`. Launch and attach still require an approved proposal; debuggee paths stay inside the workspace.
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

See [CONTRIBUTING.md](CONTRIBUTING.md) for pull-request and branch rules.

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
