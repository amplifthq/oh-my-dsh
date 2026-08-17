# Plugin Control (Organ Bank) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent propose loading or unloading a dsh plugin ("organ") inside the current session, drawn exclusively from a curated, version-pinned index, mounted through `ctx.plugin()` only after an approved `proposal_control apply`, and unloaded through Cordis's reverse-order effect-disposal chain.

**Architecture:** A `plugin-control` package with three layers. `catalog.ts` is pure: it parses the curated index (`presets/plugins.json`), resolves availability against the running profile (module resolvable + installed version equals the pin), and produces status views. `controller.ts` owns mount/dispose: post-approval dynamic `import()`, manifest verification (declared `provide`/`inject`/name against module reality), `agent.ctx.plugin()` mount settled via `fiber.await()`, per-agent fiber registry, disposal on unload and on agent end. `index.ts` is the Cordis service registering `plugin_control`, `/omd-plugins`, a system-prompt section, and the `plugin-load` / `plugin-unload` proposal kinds — the same shape as `mcp-control`.

**Tech Stack:** TypeScript 7, Cordis fibers/registry (`ctx.plugin`, `Fiber.await/dispose`, `FiberState`), dsh rc.6 (`tools`, `systemPrompt`, `commands`), OMD `proposals`, Node test runner with a real `Context` from `@deepseek-ai/cordis` in tests.

**Verified seams (do not re-derive):**

- `ctx.plugin(plugin, config)` returns `Fiber & PromiseLike<Fiber>`; `fiber.await()` settles load and rethrows config/startup errors; `fiber.dispose()` runs disposers in reverse registration order; `FiberState` is PENDING/LOADING/ACTIVE/FAILED/UNLOADING/DISPOSED (`cordis/lib/types/fiber.d.ts`, `registry.d.ts`).
- `Plugin.Base` carries static `name`, `Config` (standard-schema), `inject`, `provide` — a manifest that can be checked after import and before mount.
- Session-scoped plugin mounting is proven in-repo: `mcp-control` mounts `McpClient` per agent via `agent.ctx.plugin(...)` and disposes on owner end (`packages/mcp-control/src/index.ts` `loadServer`/`disposeOwner`).
- Static audit rejected the original seed candidates: `dsh-attachment` is already backed by the base bundle, `dsh-timeout` is a utility rather than a plugin, and `dsh-code-runtime` is an abstract seam. V1 instead exact-pins the disabled-by-default upstream `dsh-skill-badge` organ as a direct dependency.
- Tests can construct a real `Context` from `@deepseek-ai/cordis` and exercise genuine mount/dispose without any dsh host.

## Global Constraints

- Keep `oh-my-dsh` a Cordis overlay; no upstream patches, no `node_modules` edits.
- **No module code executes before approval.** `list`/`show`/`prepare_load` never `import()` the organ; the catalog's metadata comes only from the curated index. The dynamic import happens inside the approved commit callback.
- **The index is the only load source.** Tool arguments select an entry by id; the module specifier, version pin, and default config always come from the index. Arbitrary specifiers are unrepresentable in the tool schema.
- **Version and manifest verification at commit:** installed `package.json` version must equal the pin; the imported module's `name`/`provide`/`inject` must match the index manifest. Any mismatch aborts before `ctx.plugin()`.
- **In-process privilege is stated, not implied:** every `plugin-load` proposal's effects include the sentence "Runs in-process with the harness's full privileges (environment, filesystem, network) — a stronger grant than MCP activation."
- Organs mount on `agent.ctx` (session-scoped), are tracked per agent, unload via `fiber.dispose()`, and are force-disposed when the owning agent ends.
- No runtime package installation in v1 (`not-installed` entries render an explanation, not an install path). A human-run `omd plugin install` CLI is phase 2; community submission review is phase 3.
- Do not create a git commit unless the user explicitly requests one.

---

### Task 1: Curated index and pure catalog model

**Files:**

- Create: `presets/plugins.json`
- Create: `packages/plugin-control/package.json`
- Create: `packages/plugin-control/src/catalog.ts`
- Create: `tests/plugin-control.test.mjs` (catalog sections)

**Interfaces:**

- Index entry shape: `{ id, module, version, summary, risk, manifest: { name?, provide: string[], inject: string[] }, config?, source: 'upstream' | 'oh-my-dsh' }`.
- Produces `parseOrganIndex(json): OrganIndexEntry[]` (throws on malformed entries; ids unique, versions exact semver pins, module must be a bare specifier).
- Produces `resolveOrganAvailability(entry, resolveModule): OrganAvailability` — `available` (resolvable + version matches pin), `not-installed`, `version-drift` (resolvable but wrong version; carries both versions).
- Produces `organView(entry, availability, active): OrganView` for tool/command output.

- [x] Define the index schema and seed it by auditing the profile closure: include only uncomposed upstream organs whose top-level module code is side-effect-free on import, each with a one-line risk statement and reviewed manifest. The audit admitted `dsh-skill-badge` and recorded why the three original candidates were rejected.
- [x] `parseOrganIndex` rejects: duplicate ids, relative/absolute/URL module specifiers, version ranges (`^`, `~`, `>=`, `x`, `*`), invalid prerelease pins, missing risk text, manifest without `provide`/`inject` arrays.
- [x] Availability resolution takes an injectable `resolveModule(specifier) → { packageJsonPath } | undefined` so tests never depend on the host installation; the production resolver uses `createRequire` against the package's own URL without executing module code.
- [x] Tests: parse/reject classes, availability for available/not-installed/version-drift, view shape.
- [x] Run the focused test file and inspect `git diff`.

### Task 2: Mount/dispose controller against real Cordis fibers

**Files:**

- Create: `packages/plugin-control/src/controller.ts`
- Create: `tests/fixtures/test-organ.mjs` (fixture plugin: `name`, `provide`, `inject`, `Config`, registers a reversible effect and a marker service)
- Extend: `tests/plugin-control.test.mjs` (controller sections)

**Interfaces:**

- Produces `OrganController` with `load(owner, ownerCtx, entry, config, importModule, signal): Promise<LoadedOrgan>`, `unload(owner, id): Promise<boolean>`, `list(owner): ActiveOrganView[]`, `disposeOwner(owner): Promise<void>`.
- `LoadedOrgan` carries `id`, `fiberState`, and effect labels from `fiber.getEffects()`.

- [x] `load`: refuse duplicate active/loading id per owner; import only inside commit; verify installed version and exact reviewed manifest; mount via `ownerCtx.plugin(...)`; require ACTIVE; dispose on failure.
- [x] `unload`: bind approval to a monotonic organ instance id, await `fiber.dispose()`, verify DISPOSED, and remove the exact instance.
- [x] `disposeOwner`: abort and join in-flight imports/startups, dispose every remaining fiber, and reject later loads for the disposed owner.
- [x] Tests against a real `new Context()` cover load, observed effect reversal, manifest/version drift, duplicate/racing load, startup cleanup, in-flight cleanup, and owner-effect cleanup.
- [x] Run the focused test file and inspect `git diff`.

### Task 3: Runtime service, tool, command, prompt, proposal kinds

**Files:**

- Create: `packages/plugin-control/src/index.ts`
- Modify: `packages/proposals/src/index.ts` (extend `ProposalKind` with `'plugin-load' | 'plugin-unload'`)
- Extend: `tests/plugin-control.test.mjs` (runtime sections)

**Interfaces:**

- Produces `Context.pluginControl: PluginControlRuntime` (`static inject = ['tools', 'proposals', 'commands', 'systemPrompt']`).
- Registers `plugin_control` with actions `list`, `show`, `prepare_load` (`plugin_id`, optional `config` merged over index defaults), `prepare_unload` (`plugin_id`).
- Registers `/omd-plugins` listing bank status and active organs.

- [x] `prepare_load` effects carry the exact pin, summary, risk, manifest, merged config, and full-process privilege sentence; commit reports ACTIVE and effect labels.
- [x] `prepare_unload` effects carry the active organ instance id and live effect labels; stale approvals cannot unload replacements.
- [x] Runtime and agent lifecycle signals/effects own proposal cancellation and controller cleanup.
- [x] System-prompt section (order 111) describes curated inert organs and forbids premature activation claims.
- [x] Export pure proposal planners and commit factories for end-to-end `ProposalStore` tests.
- [x] Tests cover effect shape, pre-approval zero import, load/unload commits, failed commits, stale unload, and the real bundled bank entry.
- [x] Run `pnpm test` and inspect `git diff`.

### Task 4: Distribution wiring, documentation, verification

**Files:**

- Modify: `bundles/omd.cordis.yml` (row after `omd-mcp-control`)
- Modify: `package.json` (exports `./plugin-control`; `presets/plugins.json` already ships via `presets`)
- Modify: `README.md`, `README.zh.md`, `SECURITY.md`, `CHANGELOG.md`
- Create: `docs/organ-bank-curation.md`

**Interfaces:**

- Exports `oh-my-dsh/plugin-control`.
- Bundle row loads after `proposals` and `mcp-control`.

- [x] Add the bundle row and package export.
- [x] Document the organ bank, approval gate, full-process privilege, reversal, v1 contents, and curated-only boundary in both READMEs.
- [x] Add the plugin-plane threat model and explicit no-sandbox boundary to SECURITY.md.
- [x] Add `docs/organ-bank-curation.md` with admission evidence, checklist, and phase 2/3 path.
- [x] Add Plugin Control under `0.1.5 - Unreleased`.
- [x] Run format, typecheck, the full test suite, pack dry-run, temp-profile config, installed export, and real `dsh-skill-badge` ACTIVE → DISPOSED smoke.

---

## Out of scope (recorded so it stays out)

- Runtime `npm install` of organs — phase 2 is a human-run `omd plugin install <id>` that installs the pinned version into the profile; the agent still only proposes mounts of installed organs.
- Community submission pipeline and signing — phase 3; requires the curation doc's checklist to become CI.
- Replacing composed bundle rows (e.g. swapping the editor organ live) — needs a conflict story between bundle-managed and session-managed fibers first.
- Sandboxing or capability-restricting a mounted organ — Cordis offers no such boundary; curation and approval are the only defenses, and SECURITY.md says so.
