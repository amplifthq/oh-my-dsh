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

DeepSeek Harness provides an excellent plugin framework and a conservative reference setup. `oh-my-dsh` turns those building blocks into an opinionated coding environment: sensible profiles, inert reuse of your existing MCP configuration, LSP navigation and recoverable semantic rename, workspace `@file` mentions, stale-safe editing, SSRF-hardened web fetch on by default, optional DAP debugging, notifications, usage reporting, persistent code kernels, and approval-gated skill distillation that turns verified procedures into reusable skills.

It is a native curated distribution, not a fork. You keep upstream's “everything is a plugin” architecture and can override every choice.

> DeepSeek Harness is in developer preview. `oh-my-dsh` pins a tested upstream release instead of silently following breaking changes.

## Quick start

Portable releases ship a self-contained Node.js runtime and production dependency closure for **macOS arm64** and **Linux x64 (glibc)**. No system Node.js, npm, pnpm, or root access is required. CI covers Linux and macOS on Node 22 and 24. Native Windows is not supported; use [WSL2](#windows-wsl2).

### Portable install (recommended)

This URL always follows the latest non-prerelease GitHub Release. Do not pin a raw git tag in the installer URL — those go stale, and `main` can disagree with the published artifacts.

```sh
curl -fsSL https://github.com/amplifthq/oh-my-dsh/releases/latest/download/install.sh | sh
omd setup
omd
```

The bootstrap and the archives come from the same latest release. To pin a published version, keep that same installer URL and set `OMD_VERSION`:

```sh
OMD_VERSION=v0.1.7 curl -fsSL https://github.com/amplifthq/oh-my-dsh/releases/latest/download/install.sh | sh
```

The bootstrap installs under `~/.local/share/oh-my-dsh/`, links `~/.local/bin/omd`, and runs a health check without system Node.js on `PATH`. If `~/.local/bin` is not on your `PATH`, the installer prints the exact export command for your shell.

The first setup can take several minutes. It installs two isolated profiles under `~/.dsh/profiles/`:

- `omd` — interactive Web UI.
- `omd-headless` — one-shot terminal tasks.

### Manual archive install

Download the platform tarball, `SHA256SUMS`, and `release-manifest.json` from the [latest GitHub Release](https://github.com/amplifthq/oh-my-dsh/releases/latest). Verify the digest, extract, and run the packaged `bin/omd setup`.

On macOS, browser-downloaded archives may carry a quarantine attribute that Gatekeeper blocks. Clear it before running:

```sh
xattr -dr com.apple.quarantine oh-my-dsh-*-darwin-arm64.tar.gz
```

### npm install (developers)

The npm package is the developer and composition channel. It requires Node.js `^22.19.0` or `>=24.0.0` on your machine:

```sh
npm install --global oh-my-dsh
omd setup
omd
```

Prefer not to install globally?

```sh
npx oh-my-dsh@latest setup
npx oh-my-dsh@latest
```

### Windows (WSL2)

There is no native Windows portable archive, installer, or CI job. Do not run `install.sh` from PowerShell or `cmd.exe`. Use WSL2 with a glibc distro (Ubuntu is the tested shape) and run the **linux-x64** portable installer inside that Linux environment.

In an elevated PowerShell:

```powershell
wsl --install
```

Reboot if Windows asks, then open the Ubuntu terminal and use the same commands as [Portable install](#portable-install-recommended). The installer detects `Linux-x86_64` and pulls `oh-my-dsh-*-linux-x64.tar.gz`.

Keep the project under the Linux filesystem (`~/...`). Paths under `/mnt/c/` are slower and can break symlink-based profile `node_modules`. Open the Web UI from the `localhost` URL printed inside WSL; Windows 11 can usually reach that loopback address from a host browser. `omd update`, `omd rollback`, and `omd doctor --verify` also run inside WSL.

npm on native Windows is untested. If you try it, you still need Node.js `^22.19.0` or `>=24.0.0` on the Windows side, and it is not a substitute for the portable channel.

Both channels share the same OMD version and Cordis composition. A release is incomplete until npm and every required portable artifact have passed their checks.

## Distribution channels

| Channel      | Audience                                            | Runtime                         | Install                                  |
| ------------ | --------------------------------------------------- | ------------------------------- | ---------------------------------------- |
| **Portable** | End users                                           | Embedded Node.js in the archive | `install.sh` bootstrap or manual tarball |
| **npm**      | Developers, custom profiles, downstream composition | Your Node.js                    | `npm install -g` or `npx`                |

Portable mode is detected from embedded `distribution.json`, not from an environment variable. User state (`~/.dsh/`) is shared between channels, but each profile's `node_modules` is owned by one channel at a time: portable setup symlinks to the immutable closure; npm setup materializes with npm. Neither touches your `cordis.patch.yml`.

## Updating, rollback, and verification

Portable installs support foreground update and rollback without touching user data:

```sh
omd update                  # check stable channel, download, verify, and switch
omd rollback              # switch back to the retained previous version
omd doctor --verify       # verify every file in the selected version against distribution-files.json
```

`omd update` acquires an exclusive lock, verifies SHA-256 digests, runs a health check, and atomically switches `current` only after validation. It never updates a running process or runs in the background. When already current, it exits successfully without mutation.

`omd rollback` switches `current` to the retained `previous` version after checking embedded distribution identity. The version being replaced becomes the new rollback target, so rollback is reversible. It performs no network access and does not modify `~/.dsh/`.

In npm or source mode, `omd update` and `omd rollback` explain that version management goes through npm.

`omd doctor` reports distribution identity (version, platform, upstream dsh pin, embedded Node.js) in portable mode. With `--verify`, it checks every file under the selected version against the embedded SHA-256 manifest.

## Uninstall

Portable uninstall is manual:

```sh
rm -rf ~/.local/share/oh-my-dsh
rm ~/.local/bin/omd
```

`~/.dsh/` holds your profiles, sessions, skills, forged plugins, and patches. OMD never deletes it during update, rollback, or uninstall.

npm uninstall:

```sh
npm uninstall -g oh-my-dsh
```

## Capability tiers

OMD classifies every capability into one of four tiers:

| Tier                     | Meaning                                                                             | Examples                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Core**                 | Ships in the artifact and is enabled by the default composition                     | Upstream web/headless runtime, OMD first-party plugins, proposal controls, hardened web fetch, bundled language servers |
| **Bundled optional**     | Ships in the closure but inert until explicitly activated through the approval path | Curated plugin catalog: `dsh-skill-badge`, `dsh-pkg-info`                                                               |
| **Curated integrations** | Reviewed metadata, setup guidance, or skills; external runtime not in the base      | browser-use CLI, Playwright MCP, Context7 — require separate installation and have their own network behavior           |
| **User growth**          | Lives outside the immutable base; survives update and rollback                      | User skills, Plugin Forge output, local MCP definitions, forged plugins, trust decisions                                |

Features with external prerequisites are documented as curated integrations, not as "included" or "works out of the box."

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

### Curated plugin catalog

`plugin_control` extends the same proposal plane to the harness itself. It can list or inspect reviewed dsh plugins, then prepare a session-scoped load or unload. The package is not imported during discovery or proposal preparation. Only an approved `proposal_control apply` verifies the installed package against the exact version pin and reviewed `name`/`provide`/`inject` manifest, imports it, and mounts it through `agent.ctx.plugin()`. Unload calls `fiber.dispose()`, so Cordis reverses the plugin's registered effects in reverse order.

This is the strongest grant OMD can make: an active plugin runs in-process with the harness's full environment, filesystem, and network privileges. The proposal states that explicitly. V1 therefore accepts only ids from the bundled [`presets/plugins.json`](presets/plugins.json) index; arbitrary npm names, paths, URLs, and runtime installation are not representable. `/omd-plugins` shows catalog availability and session state.

The deliberately small catalog currently contains two reviewed plugins:

- `dsh-skill-badge` — exposes DeepSeek's official attribution skill. It ships at the reviewed `0.1.0-rc.7` pin and is inert until an approved session load.
- `dsh-pkg-info` — adds a read-only `pkg_info` tool for public npm and PyPI metadata. The catalog pins the reviewed community artifact at `0.1.1`, records its repository, publisher, npm integrity, and source commit, and states its registry network and public-metadata exposure before approval.

Catalog admission, rejection evidence, and review requirements are documented in [Plugin catalog curation](docs/organ-bank-curation.md).

### Plugin forge

`plugin_forge` is the capability-axis counterpart of skill forge: the agent can author a small dsh plugin for itself — for example a missing tool — and stage the **complete source** inside an approval-gated proposal. Nothing is written or mounted until you approve `proposal_control apply`; the commit then persists the source under `$DSH_HOME/forged-plugins/<slug>/` (scope `user`) or `<workspace>/.dsh/forged-plugins/<slug>/` (scope `project`), verifies the SHA-256 digest you reviewed, and mounts it through the same controller as the curated catalog. Unload reverses the plugin's Cordis effects; `prepare_load` remounts a previously forged revision in a later session under the same digest pin, and `/omd-forged` lists forged plugins with revision, digest, session state, and attributed invocation counts.

Selection pressure is recorded, not inferred: after a mount, tool invocations are attributed through Cordis effect labels (and any tools that appeared in `schemas()` during that mount) and appended to a per-plugin usage journal. `capability_search` surfaces forged plugins with a `forged` marker; a zero-hit search is recorded as a capability gap under `$DSH_HOME/omd/capability-gaps.jsonl` so later forge/revise/retire decisions have a direction. `/omd-gaps` and `plugin_forge gaps` list those misses. `plugin_forge prepare_promote` assembles a human-reviewed pull-request draft — current source, digest history, usage, gaps, and a catalog entry full of `REPLACE_WITH_*` placeholders — and writes it under the plugin's `promotions/` directory. When `eval_control` is mounted, promote also requires a stored `compare mode=diff` that does not regress and a `compare mode=ablate` that is faithful. The runtime never writes [`presets/plugins.json`](presets/plugins.json). Promoting a session artifact into the curated catalog remains a pull request.

Static discipline is enforced before a proposal can exist: valid ESM only (V8 parses it via `node --check`, executing nothing), static imports only from `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools`, no dynamic `import()` or `require`, source ≤ 32 KiB, and required `name`/`apply` exports that are re-verified against the declared manifest at mount. The import whitelist exists for review clarity, not sandboxing: in-process JavaScript cannot be confined, and a registered tool's execute body can still reach `globalThis`, `fetch`, and `process`. The whitelist guarantees every module dependency is visible at review time; it does not restrict runtime reach. A forged plugin runs with the harness's full privileges, and it was written by the agent during this session — the proposal review is the entire trust decision, so the proposal carries the full source, the extracted import list, declared intended effects, and secret-content warnings, and the commit reports the observed Cordis effect labels next to what was declared.

### Capability discovery plane

`capability_search` is a read-only search surface over tools, skills, slash commands, inert or active MCP servers, curated session plugins, and agent-forged plugins. Stable refs look like `tool:bash`, `mcp:omd-playwright`, `plugin:dsh-skill-badge`, or `plugin:forged/user/<slug>`. Forged hits carry a `forged` marker and route through `plugin_forge`, not `plugin_control`. Each hit returns status, summary, provenance, and an exact next step. Discovery never starts an MCP process, imports a package, expands credentials, or creates a proposal. Zero-hit searches are recorded as capability gaps. `/omd-capabilities [query]` is the human-facing counterpart.

### Eval workflow

`eval_control` scores a frozen harness snapshot with machine assertions. Four actions: `snapshot`, `run`, `compare`, `show`. `run` requires an explicit `snapshot_digest` and never infers the live session. Artifacts live under `$DSH_HOME/omd/eval`; `show` (optional `query`) is the filesystem channel — there is no narrative summary. `compare mode=diff` is the promotion gate; `compare mode=ablate` is the causal with/without test on one skill or plugin. When eval is mounted, `plugin_forge prepare_promote` needs both a non-regressing diff and a faithful ablate; updating a skill with `skill_control prepare_save` needs a faithful ablate (a first save is still a proposal). Scores never read assistant text, an LLM judge, or self-report. Eval does not apply proposals, write the catalog, or mount plugins. `/omd-eval` lists bundled tasks and recent runs. This is the environment.

### Optimizer (proposer only)

`opt_control` picks the next harness mutation from a locked action set — `prepare_promote`, `prepare_forge`, `prepare_unload`, `prepare_save`, `noop` — using a durable policy file under `$DSH_HOME/omd/opt/policy.json`. Two actions: `suggest`, `show`. `suggest` credits new `eval_control compare` results against the last suggestion, observes only candidates that already pass the eval gates, and returns one arm plus a next tool call. It never applies a proposal, invents plugin source or a skill body, or writes [`presets/plugins.json`](presets/plugins.json). `/omd-opt` reads the policy. Select and retain stay on `proposal_control apply`.

### Daily-use tools upstream does not prioritize

- `@file` mentions: reference workspace files in your message as `@path`, `@path:12-40`, or `@"path with spaces"`. The mentioned content is attached to the same model step, bounded in size, and rendered as `hash_edit`-compatible anchors. Parsing is text-only (no composer autocomplete); files outside the workspace are never attached.
- `hash_edit` performs stale-safe multi-line replacement using per-line anchors and a final filesystem version guard.
- `semantic_refactor` prepares version-guarded, recoverable multi-file LSP rename transactions.
- `kernel` provides session-persistent JavaScript and Python state, with callbacks into dsh tools.
- An optional second-model advisor reviews completed top-level turns.
- `/usage` reports the live session; `omd usage` aggregates persisted sessions.
- Opt-in DAP debugging: `debug_control` prepares launch and attach proposals for `debugpy`, `lldb-dap`, or custom stdio adapters; only an approved apply starts the adapter and debuggee.
- Curated, opt-in MCP presets: `memory`, `context7`, and `playwright`.
- Skill forge: `skill_control prepare_save` distills a procedure this session actually verified into a durable `SKILL.md`, and `/omd-distill [focus]` queues a drafting turn. The proposal carries the exact before/after file content plus secret-content warnings; only `proposal_control apply` with your approval writes it — atomically, containment-checked, and stale-guarded against concurrent edits. Scope `project` saves to `<workspace>/.dsh/skills/` for repository-specific procedures; scope `user` saves to `$DSH_HOME/skills/` for every project. The upstream skill watcher picks the file up live, so the skill is usable in the same session. Bounds: slug ≤ 41 chars, description ≤ 500 chars, body ≤ 32 KiB.
- Bundled skills: `review-changes`, `systematic-debugging`, `verify-before-done`, and `browser-use-cli`.
- Script-mode browsing via the bundled `browser-use-cli` skill: the agent drives a real browser by piping Python to the audited `browser-use` CLI through the ordinary shell tool, so every run rides the existing command approval. The skill defaults to an isolated throwaway-profile browser, requires vendor telemetry off, forbids private-network and metadata navigation, and gates the user's logged-in Chrome behind Chrome's own consent popup.

## Commands

```sh
omd                              # start the Web UI
omd headless "fix the tests"     # run one task and exit
omd setup                        # install or upgrade both profiles
omd update                       # portable: check stable channel and install a newer release
omd rollback                     # portable: switch back to the retained previous version
omd doctor [--verify]            # installation status; --verify checks file digests (portable)
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

Capability activation, debug launch/attach, skill saves, and source mutation use the same `prepare → inspect → approve → commit → verify` lifecycle. A proposal is session-local and cannot authorize itself; applying it always reaches the upstream approval service.

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

## Compatibility

| oh-my-dsh   | DeepSeek Harness (`@deepseek-ai/dsh*`) | Node.js / runtime                                     |
| ----------- | -------------------------------------- | ----------------------------------------------------- |
| 0.1.7+      | `0.1.0-rc.7` (exact pin)               | Embedded (portable) or `^22.19.0 \|\| >=24.0.0` (npm) |
| 0.1.0–0.1.6 | `0.1.0-rc.6` (exact pin)               | `^22.19.0 \|\| >=24.0.0`                              |

Upstream is in developer preview, so `oh-my-dsh` pins one tested release and never follows breaking changes silently. A [weekly canary workflow](.github/workflows/canary.yml) additionally tests the overlay against `dsh@next`, so an incompatible upcoming release is filed as an issue before it ships. Upgrades follow [docs/upstream-upgrade-playbook.md](docs/upstream-upgrade-playbook.md).

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for pull-request and branch rules, and its "Good first contributions" section for the easiest entry points (bundled skills, curated MCP presets, adversarial tests). [Why an overlay, not a fork](docs/why-an-overlay-not-a-fork.md) explains where a change belongs.

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
