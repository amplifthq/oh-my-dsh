# Changelog

All notable changes to `oh-my-dsh` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org) while the project is pre-1.0 (breaking changes may
land in minor versions, never silently in patches).

Upstream compatibility for each release is listed in the
[README compatibility table](README.md#compatibility).

## [Unreleased]

### Added

- `eval_control` (`oh-my-dsh/harness-eval`) is a four-action eval workflow
  (`snapshot`, `run`, `compare`, `show`) mounted after plugin-forge. It
  captures a harness snapshot, runs the bundled `omd-eval-v1` suite in an
  isolated overlay, writes score/assertion/trace files under
  `$DSH_HOME/omd/eval`, and compares conditions. `compare mode=diff` is the
  promotion gate; `compare mode=ablate` is the causal with/without test.
  Scores are machine assertions only. Eval never applies proposals or writes
  `presets/plugins.json`. `/omd-eval` lists tasks and recent runs.
- `opt_control` (`oh-my-dsh/harness-opt`) is a two-action proposer
  (`suggest`, `show`) mounted after eval. It keeps a durable bandit over
  `prepare_promote`, `prepare_forge`, `prepare_unload`, `prepare_save`, and
  `noop` in `$DSH_HOME/omd/opt/policy.json`. `suggest` credits new eval
  compares, observes legal candidates (eval gates still apply), and returns
  one arm plus a next tool call. It never applies proposals, writes plugin
  source or skill bodies, or writes `presets/plugins.json`. `/omd-opt` reads
  the policy file.
- Plugin forge selection pressure: tool invocations are attributed through
  Cordis effect labels (and mount-time schema diffs), persisted per forged
  plugin, and shown by `plugin_forge usage` / `/omd-forged`.
- `capability_search` indexes forged plugins with a `forged` marker and
  records authoritative zero-hit searches as a capability-gap journal that
  steers `plugin_forge`. `/omd-gaps` lists recent misses.
- `plugin_forge prepare_promote` writes a human-reviewed promotion packet
  (`AUDIT.md`, placeholder catalog draft, usage, revision log). When
  `eval_control` is mounted, promote requires a stored non-regressing
  `compare mode=diff` and a faithful `compare mode=ablate`. Updating an
  existing skill with `skill_control prepare_save` requires the same
  faithful ablate. The runtime never writes `presets/plugins.json`.

### Fixed

- Portable `omd` no longer treats a leftover npm/source profile as ready.
  `dsh-scope` tags standing mounts with a per-module `Symbol`, so a mixed
  rc.6/rc.7 graph makes the standard preset's `dsh-persona` land on the
  global prompt layer and fail session resume with
  `deployment:persona is already registered`. Launch and `omd doctor` now
  detect a stale profile tree and relink it to the current portable
  closure.
- Session resume no longer reads `mcpControl` through the agent scope.
  Discovery now uses the host plugin context that declared the inject, so
  resume does not fail with `cannot get property "mcpControl" without inject`.

### Changed

- Upstream compatibility: upgraded all directly pinned `@deepseek-ai/dsh*`
  dependencies to `0.1.0-rc.8`, and updated `@deepseek-ai/dsh-skill-badge` in
  the curated catalog to `0.1.0-rc.8` with its reviewed npm integrity hash.
- File references now follow the rc.8 seam: ordinary `@path` references remain
  path-only and are read on demand, while only explicit `@path:start-end`
  ranges receive OMD's bounded, `hash_edit`-compatible same-step snapshot.
- DeepSeek Harness `rc.8` changes the schema of its opt-in SQLite session
  persistence provider without supplying a migration. OMD's default profiles
  continue to use canonical JSONL session logs and are unaffected; custom
  compositions that enabled SQLite persistence must retain the old database
  and configure a new `rc.8` database instead of opening it in place.
- README documents Windows as WSL2-only: install the linux-x64 portable
  distribution inside Ubuntu, keep projects on the Linux filesystem, and do
  not run `install.sh` from PowerShell or `cmd.exe`.

## [0.1.7] - 2026-08-18

### Added

- Portable distribution for macOS arm64 and Linux x64 (glibc): self-contained
  archives embed an exact official Node.js runtime, a hoisted production
  dependency closure, and immutable build identity (`distribution.json`,
  `distribution-files.json`, SPDX SBOM). No system Node.js, npm, or root
  access is required.
- Bootstrap installer (`install.sh`): downloads the stable-channel release
  manifest, verifies SHA-256 digests, extracts atomically, runs a health
  check without system Node.js on `PATH`, and links `~/.local/bin/omd`.
- `omd update`: foreground portable update through the stable channel with
  exclusive locking, digest verification, health check, and atomic `current`
  switch. Already-current installs exit without mutation.
- `omd rollback`: switches `current` to the retained `previous` version after
  validating embedded distribution identity. Reversible and offline; never
  modifies `DSH_HOME`.
- `omd doctor --verify`: verifies every file in the selected portable version
  against the embedded SHA-256 manifest in `distribution-files.json`.
- Dual-channel releases: npm package (developer/composition channel) and
  portable artifacts (end-user channel) share the same OMD version from one tag.
- Curated plugin catalog: admitted the first community entry,
  `dsh-pkg-info@0.1.1`, after reviewing the exact npm artifact and source
  commit. An approved session load adds the read-only `pkg_info` tool for
  npm and PyPI registry metadata queries; unload removes it through the
  real Cordis effect chain. The curation ledger records the rejected
  candidates and their concrete SSRF, containment, mount-side-effect, or
  runtime-schema failures.

### Changed

- Upstream compatibility: upgraded all `@deepseek-ai/dsh*` dependencies to
  `0.1.0-rc.7`, and updated `@deepseek-ai/dsh-skill-badge` in the curated
  catalog to `0.1.0-rc.7` with its reviewed npm integrity hash.
- README quick start leads with the portable installer at
  `releases/latest/download/install.sh`. Pins use `OMD_VERSION` instead of a
  versioned raw git URL. Capability tiers (Core, Bundled Optional, Curated
  Integrations, User Growth) are documented explicitly.
- Community catalog entries now require machine-readable repository,
  publisher, npm SHA-512 integrity, and optional reviewed-commit provenance.
  The same evidence is copied into the load proposal for approval.
- Portable `omd setup` symlinks profile `node_modules` to the immutable
  closure instead of calling npm. npm-mode setup behavior is unchanged.

## [0.1.6] - 2026-08-17

### Added

- Plugin forge: `plugin_forge prepare_forge` lets the agent author a small dsh
  plugin for itself and stage the complete source inside an approval-gated
  proposal. Only an approved `proposal_control apply` persists the source
  (digest-pinned, atomic, containment-checked, stale-guarded — the skill-forge
  write discipline) under `$DSH_HOME/forged-plugins/` or
  `<workspace>/.dsh/forged-plugins/` and mounts it through the plugin-control
  controller. Static discipline before any proposal exists: valid ESM verified
  by `node --check` without executing, static imports only from
  `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools` (review clarity, not a
  sandbox), no dynamic `import()`/`require`, source ≤ 32 KiB, required
  `name`/`apply` exports verified against the declared manifest at mount.
  `prepare_load` remounts a forged revision in later sessions under the same
  digest pin; `prepare_unload` reverses its Cordis effects; `/omd-forged`
  lists revisions, digests, and session state. The commit result reports
  observed Cordis effect labels next to the declared intended effects.

### Changed

- Plugin control now says "plugin" everywhere the model or the user can see it
  (system prompt, tool and command descriptions, proposal titles and effects,
  error messages, and the `plugin-instance-N` id prefix), finishing the
  organ-bank → curated-plugin-catalog rename that the READMEs already adopted.
  Internal identifiers such as `OrganController` are unchanged, and no tool
  names, actions, or schemas changed.

## [0.1.5] - 2026-08-17

### Added

- Bundled `browser-use-cli` skill: script-mode browsing through the ordinary
  shell tool. The agent pipes Python to the `browser-use` CLI (audited at
  0.13.8 / browser-harness 0.1.9), so every browser action rides existing
  command approval instead of adding a new tool surface. The skill defaults to
  an isolated throwaway-profile browser, mandates `ANONYMIZED_TELEMETRY=false`
  (which also disables default vendor cloud sync), forbids private-network and
  cloud-metadata navigation, forbids automated MFA entry and vendor cloud
  browsers, and permits attaching to the user's logged-in Chrome only through
  Chrome's own per-session consent popup.

- Skill forge: `skill_control prepare_save` distills a session-verified
  procedure into a durable `SKILL.md`, and `/omd-distill [focus]` queues a
  drafting turn. Saves flow through the proposal plane — the proposal carries
  the exact before/after file content and secret-content warnings, and only an
  approved `proposal_control apply` writes the file (atomic temp+rename,
  containment-checked after path resolution, SHA-256 stale guard against
  concurrent edits, symlinked targets rejected). Scope `project` writes
  `<workspace>/.dsh/skills/<slug>/SKILL.md`, scope `user` writes
  `$DSH_HOME/skills/<slug>/SKILL.md`; the upstream skill watcher picks new
  files up live. Content bounds: slug ≤ 41 chars, single-line description
  ≤ 500 chars, body ≤ 32 KiB.
- Plugin control and its curated organ bank: `plugin_control` lists and inspects
  exact-pinned entries, then prepares session-scoped load/unload proposals.
  Discovery and proposal preparation import no plugin code; approved load
  rechecks the installed version and reviewed `name`/`provide`/`inject`
  manifest before `agent.ctx.plugin()` mounts it. Unload and agent teardown
  await Cordis effect reversal. Arbitrary packages and runtime installation
  are unrepresentable in v1. The first bank entry is the upstream
  `dsh-skill-badge@0.1.0-rc.6`.
- Capability discovery plane: `capability_search` and `/omd-capabilities`
  search model-visible tools, skills, slash commands, MCP servers, and curated
  session plugins through stable refs (`tool:…`, `mcp:…`, `plugin:…`). Hits
  return status and an exact next action; activation still requires the
  existing `mcp_control` / `plugin_control` prepare path plus an approved
  `proposal_control apply`. Discovery itself never starts processes, imports
  packages, expands credentials, or creates proposals.

## [0.1.4] - 2026-08-17

First release cut from a tagged commit through the provenance-signed release
workflow.

### Added

- `CHANGELOG.md`, release tags, and a GitHub Actions release workflow that
  re-runs all checks and publishes to npm with provenance.
- CI now runs on macOS in addition to Linux (Node 22 and 24), plus an
  end-to-end smoke job that installs the real profiles (`omd setup`) and runs
  `omd doctor`.
- Adversarial security tests: decimal/octal/hex IPv4 literal forms, IPv4-mapped
  IPv6 metadata addresses, credential-bearing redirects, unsupported charsets,
  DNS rebinding simulation via an injectable resolver, cross-agent proposal
  access, concurrent double-apply, tampered refactor journals, and incomplete
  rollback crash shapes.
- A weekly upstream canary workflow that tests against `@deepseek-ai/dsh*@next`
  and opens an issue when a coming upstream release breaks the overlay.
- Upstream upgrade playbook (`docs/upstream-upgrade-playbook.md`) and a draft
  proposal for an upstream LSP mutation seam
  (`docs/upstream-lsp-seam-proposal.md`).
- Contributor entry points: a feature/idea issue template, a demo recording
  script, and “Why an overlay, not a fork” (`docs/why-an-overlay-not-a-fork.md`).

### Changed

- The redundant `time_now` tool was removed; zoned time context already covers
  it.
- The advisor example model in the README is now `claude-fable-5`.
- Pre-commit hooks (husky + lint-staged) format staged files automatically.

### Fixed

- In-flight DAP request timers stay on the event loop, so a headless run can
  no longer exit while a debug adapter request is pending.
- `oh-my-dsh/index` exported a stale `version` (`0.1.2`); it now matches the
  package version and is verified at release time.

### Security

- Hostnames with a trailing dot (`localhost.`, `foo.internal.`) are now
  classified as private at URL-validation time instead of only at connect
  time.

## [0.1.3] - 2026-08-14

### Added

- SSRF-hardened web fetch is on by default through the `omd-safe` provider:
  private, loopback, link-local, and cloud-metadata destinations are rejected
  before the request and re-validated at every DNS resolution (rebinding-safe).
  `OMD_DISABLE_WEB_FETCH=1` turns the tool off; `OMD_WEB_FETCH_ALLOW_PRIVATE=1`
  admits private destinations on trusted networks.
- When fetch is disabled, shell fetches of public URLs (`curl`, `wget`,
  HTTPie) prompt for approval instead of silently bypassing the missing tool.
  Local and private URLs are never intercepted.
- The launch directory is pre-registered as a workspace, so the Web UI picker
  starts where you are.
- Desktop notification when input is queued behind a running turn.
- README hero image and project badges.

## [0.1.2] - 2026-08-14

### Added

- The safe capability plane: a session-local `proposals` service with one
  approval-gated apply tool, lazy MCP capability control (`mcp_control`) over
  an inert server catalog, and `semantic_refactor` — previewable,
  version-guarded, recoverable multi-file LSP rename with private recovery
  journals.
- Workspace `@file` mentions (`@path`, `@path:12-40`, `@"path with spaces"`)
  attached to the same model step as bounded, `hash_edit`-compatible anchors.
- Opt-in DAP debugging (`OMD_ENABLE_DEBUG=1`): `debug_control` prepares launch
  and attach proposals for `debugpy`, `lldb-dap`, or custom stdio adapters;
  only an approved apply starts the adapter and debuggee.

## [0.1.1] - 2026-08-14

### Fixed

- Profile installation from the npm registry (rather than a source checkout).

## [0.1.0] - 2026-08-14

### Added

- Initial distribution: `omd` (Web UI) and `omd-headless` profiles on pinned
  DeepSeek Harness, `workspace-write + ask` defaults, bundled and discovered
  language servers with `hash_edit` stale-safe editing, inert reuse of
  existing agent configuration (instructions, skills, MCP servers, hooks,
  commands) gated by `omd trust`, persistent code kernels, an optional
  second-model advisor, desktop notifications, usage reporting, and curated
  MCP presets (`memory`, `context7`, `playwright`).
