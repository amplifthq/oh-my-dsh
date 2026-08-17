# Changelog

All notable changes to `oh-my-dsh` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org) while the project is pre-1.0 (breaking changes may
land in minor versions, never silently in patches).

Upstream compatibility for each release is listed in the
[README compatibility table](README.md#compatibility).

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
