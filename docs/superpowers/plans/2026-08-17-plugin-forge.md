# Plugin Forge (Agent-Authored Session Plugins) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent author a small dsh plugin for itself in-session — full source carried inside an approval-gated proposal — persisted to a digest-pinned forged-plugin directory, mounted through the existing `OrganController` only after an approved `proposal_control apply`, unloaded through Cordis effect reversal, and remountable in later sessions under the same digest pin. This is the capability-axis counterpart of skill forge: skill forge lets the agent retain verified _experience_; plugin forge lets it grow verified _capability_, both under the same supervision discipline.

**Why now:** the self-evolution loop is perceive → vary → select → retain. Plugin control v1 deliberately made arbitrary packages unrepresentable, which leaves the capability-axis variation step at zero: the agent cannot gain a tool mid-session that is not already in the curated catalog. Plugin forge opens exactly that step while keeping the human review boundary that plugin control established.

**Naming:** user- and model-facing surfaces say **plugin forge** / **forged plugin** everywhere (tool `plugin_forge`, package `plugin-forge`, service `ctx.pluginForge`, directory `forged-plugins/`). The "organ" metaphor stays confined to plugin-control's existing internal identifiers (`OrganController`, `OrganIndexEntry`), which this plan reuses but does not rename.

**Architecture:** A new `plugin-forge` package with the same three-layer shape as `skill-forge`. `document.ts` is pure validation: TypeScript-parser syntax check, static import extraction and whitelisting, size bounds, secret heuristics reuse. `store.ts` owns the filesystem: per-scope forged-plugin roots (`$DSH_HOME/forged-plugins/<slug>/`, `<workspace>/.dsh/forged-plugins/<slug>/`), content-addressed source files (`source.<digest12>.mjs`), a `plugin.json` metadata file, atomic temp+rename writes, symlink refusal, and containment checks — all mirroring the proven skill-forge store. `index.ts` is the Cordis service registering the `plugin_forge` tool, an `/omd-forged` command, a system-prompt section, and the new `plugin-forge` proposal kind. Mount/unmount reuses `OrganController` from `plugin-control` through one new injectable seam (`checkAvailability`), so fiber lifecycle, manifest verification, instance-id stale guards, duplicate/race rejection, and owner disposal are inherited rather than re-implemented.

**Tech Stack:** `node --check --input-type=module` as the authoritative ESM syntax gate (V8 parses, executes nothing) plus `es-module-lexer` for import/export extraction — **implementation deviation:** TypeScript 7's native compiler no longer ships the JS parser API (`ts.createSourceFile` is undefined), so the design's TS-parser scan was replaced by this pair. Cordis fibers (`ctx.plugin`, `fiber.await/dispose`, `getEffects`), dsh rc.6 (`tools`, `commands`, `systemPrompt`), OMD `proposals`, `plugin-control`'s `OrganController` and `verifyManifest`, `skill-forge`'s store patterns, Node test runner with a real `Context`.

**Verified seams (do not re-derive):**

- `OrganControllerOptions` already injects `resolveModule` and `importModule` (`packages/plugin-control/src/controller.ts`); the only missing seam is availability verification, which is hard-wired to the version-pin check inside `performLoad`.
- `verifyManifest(entry, plugin)` compares imported `name`/`provide`/`inject` against the reviewed manifest and is reusable as-is.
- `commitSkillWrite` demonstrates the full safe-write discipline: lexical containment, symlink refusal, realpath containment, SHA-256 stale guard, atomic temp+rename with mode 0644 (`packages/skill-forge/src/store.ts`).
- The proposals pre-execute hook forces an `ask` on every `proposal_control apply`, including under danger-full-access (`packages/proposals/src/index.ts`).
- Skill-write proposals already carry full before/after file content in effect details, so a full-source proposal payload has precedent and renders in existing approval UI.
- Dynamic `import()` of a fixed path is cached by the ESM loader; revisions must go to new content-addressed filenames to avoid stale-module reuse.
- `agent.session.header.cwd` is the workspace root seam used by skill-forge `roots()`.
- **Implementation addition:** bare specifiers do not resolve from `$DSH_HOME/forged-plugins/`, so `ensureImportResolution` links each whitelisted package into `<forge root>/node_modules` as a symlink/junction pointing at the copy the harness itself resolved. The forged source stays byte-for-byte what was reviewed; resolution uses Node's ordinary upward walk.

## Honest security framing (repeat in docs and system prompt)

- A forged plugin runs **in-process with the harness's full privileges** — the plugin-control privilege sentence applies, plus one more: _this code was written by the agent during this session_, so the proposal review is the entire trust decision.
- The static import whitelist exists for **review clarity, not sandboxing**. In-process JavaScript cannot be confined: a registered tool's execute body can still reach `globalThis`, `fetch`, and `process`. The whitelist guarantees every module dependency is visible at review time; it does not restrict runtime reach. State this verbatim in the README and never claim isolation.
- Prompt-injection is the realistic attack: a poisoned page or file steers the agent into authoring a malicious plugin. Mitigations: the proposal shows the complete bounded source (≤ 32 KiB), the extracted import list, declared-vs-intended effects, and secret warnings; the digest pin prevents post-review substitution; the user approval is the boundary.

## Global Constraints

- Keep `oh-my-dsh` a Cordis overlay; no upstream patches, no `node_modules` edits.
- **No authored code executes before approval.** `prepare_forge`/`prepare_load` validate with the TypeScript _parser_ only (no execution, no `eval`, no `vm`); the dynamic import happens inside the approved commit callback.
- **Digest is the identity.** Every mount re-reads the source file, recomputes SHA-256, and requires equality with the reviewed digest before import. Write commits carry the same stale guard as skill forge (expected digest of `plugin.json`, or absence for first forge).
- **v1 source discipline (enforced by AST scan, all violations reject):** ESM only; static imports only from the whitelist `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools`; no dynamic `import()`, no `require`, no `node:` builtins, no relative or URL specifiers; source ≤ 32 KiB; must export `name` and an `apply` function (default or named).
- **Declared manifest is verified at mount:** the imported module's `name`/`provide`/`inject` must equal the reviewed manifest (reuse `verifyManifest`); the commit result reports actual `fiber.getEffects()` labels next to the declared intended effects so drift is visible immediately.
- Forged plugins mount on `agent.ctx` (session-scoped), are tracked per agent through the shared controller instance, unload via effect reversal, and are force-disposed when the owning agent ends.
- Forge never installs packages and never touches the curated catalog: `presets/plugins.json` stays human-curated; forged plugins live only under the forged-plugin roots and are unrepresentable as curated entries.
- Do not create a git commit unless the user explicitly requests one.

---

### Task 1: Pure document model — validation, import scan, rendering

**Files:**

- Create: `packages/plugin-forge/package.json`
- Create: `packages/plugin-forge/src/document.ts`
- Create: `tests/plugin-forge.test.mjs` (document sections)

**Interfaces:**

- `ForgedPluginInput { slug, summary, manifest: { name, provide: string[], inject: string[] }, intendedEffects: string[], source, config? }`
- `validateForgedPluginInput(input): ForgedPluginDocument` — slug via skill-forge `SLUG_PATTERN`; summary single-line ≤ 500; `manifest.name` must equal the slug-derived plugin name; `provide`/`inject` ≤ 8 entries each, deduped; `intendedEffects` 1–8 single-line strings; source ≤ 32 KiB.
- `scanPluginSource(source): PluginSourceReport` — parse with `ts.createSourceFile` (ESM, no execution); reject syntax diagnostics; walk the AST to collect every `ImportDeclaration` specifier; reject dynamic `import(...)` call expressions, `require` identifiers, `export =`, and CommonJS artifacts; verify every specifier is in `IMPORT_WHITELIST`; verify an exported `apply` function and exported `name` exist syntactically. Returns `{ imports: string[], exportsApply: boolean, exportsName: boolean }` for the proposal payload.
- `pluginDigest(source): string` (SHA-256 hex) and `contentAddressedFilename(digest): string` (`source.<first 12 hex>.mjs`).
- Secret warnings: reuse `detectSecretLikeContent` from skill-forge (import across packages like plugin-control imports proposals types).

- [x] Validation rejects: oversized source, multi-line summary, empty/duplicate manifest arrays, manifest name mismatch, missing intended effects.
- [x] AST scan rejects: syntax errors, non-whitelisted imports (`node:fs`, relative, URL), dynamic `import()`, `require`, missing `apply`/`name` exports; accepts a well-formed plugin registering one tool via `defineTool`.
- [x] Scan is total: adversarial inputs (huge unicode, comments hiding imports, template-string specifiers) never execute code and never bypass the specifier collection (dynamic specifiers are rejected as dynamic import).
- [x] Tests: acceptance and each rejection class; digest and filename determinism.
- [x] Run the focused test file and inspect `git diff`.

### Task 2: Store — forged-plugin roots, atomic writes, digest-guarded reads

**Files:**

- Create: `packages/plugin-forge/src/store.ts`
- Extend: `tests/plugin-forge.test.mjs` (store sections)

**Interfaces:**

- `resolveForgedPluginTarget(scope, slug, roots): ForgedPluginTarget` — roots identical in shape to `SkillRoots`; user → `$DSH_HOME/forged-plugins/<slug>/`, project → `<workspace>/.dsh/forged-plugins/<slug>/`; lexical containment identical to skill forge.
- `plugin.json` shape: `{ slug, scope, summary, manifest, intendedEffects, sourceFile, digest, revision, createdAt, updatedAt }` — JSON, mode 0644, atomic temp+rename.
- `readForgedPlugin(target): ForgedPlugin | undefined` — reads `plugin.json`, reads the referenced source file, recomputes the digest, and reports `digestMatches`; never throws on absence.
- `commitForgedPluginWrite(target, plan, expectedMetaDigest?)` — assertSafeTarget semantics copied from skill forge (symlink refusal on directory, `plugin.json`, and source file; realpath containment); stale guard over the SHA-256 of the current `plugin.json` content (absence required for first forge); writes the content-addressed source file first (`wx` flag — collision means identical content, acceptable), then `plugin.json` via temp+rename; best-effort unlink of the previously referenced source file after success.
- `listForgedPlugins(roots): ForgedPluginSummary[]` — readdir both roots, tolerate malformed entries by reporting them as `invalid` with the reason instead of throwing.

- [x] Containment, symlink refusal, and stale-guard tests mirror the skill-forge store suite (reuse its test patterns).
- [x] Revision flow: second forge writes a new content-addressed file, bumps `revision`, updates `plugin.json` atomically, removes the orphaned old source file; a failed rename leaves no partial state.
- [x] `readForgedPlugin` flags digest mismatch (tampered source) without throwing; `listForgedPlugins` surfaces invalid directories honestly.
- [x] Run the focused test file and inspect `git diff`.

### Task 3: Controller availability seam in plugin-control

**Files:**

- Modify: `packages/plugin-control/src/controller.ts`
- Extend: `tests/plugin-control.test.mjs` (seam sections)

**Interfaces:**

- Extend `OrganControllerOptions` with `checkAvailability?: (entry: OrganIndexEntry) => Promise<void> | void`; default preserves the exact current behavior (`resolveOrganAvailability` + not-installed / version-drift errors) so plugin-control is bitwise-unchanged in behavior.
- `performLoad` calls the injected check where the inline availability block sits today; everything downstream (import, `verifyManifest`, mount, ACTIVE requirement, failure disposal) is untouched.

- [x] Existing plugin-control tests pass unmodified (default path unchanged).
- [x] New test: an injected `checkAvailability` that throws blocks the load before `importModule` is called; one that passes proceeds to mount a fixture plugin from a file URL via injected `importModule`.
- [x] Run the focused test file and inspect `git diff`.

### Task 4: Runtime — tool, command, prompt, proposal kind, wiring

**Files:**

- Create: `packages/plugin-forge/src/index.ts`
- Modify: `packages/proposals/src/index.ts` (extend `ProposalKind` with `'plugin-forge'`)
- Modify: `package.json` (add `./plugin-forge` export), `bundles/omd.cordis.yml` (bundle row after `omd-plugin-control`)
- Extend: `tests/plugin-forge.test.mjs` (runtime sections)

**Interfaces:**

- `PluginForgeRuntime extends Service`, `inject = ['tools', 'proposals', 'commands', 'systemPrompt']`, provides `ctx.pluginForge`; owns one `OrganController` instance configured with `importModule: (fileUrl) => import(fileUrl)` and per-entry `checkAvailability` = re-read + digest equality + re-run `scanPluginSource` (defense in depth at commit time).
- Tool `plugin_forge` actions:
  - `list` / `show` — read-only over `listForgedPlugins` + active state from the controller; never imports.
  - `prepare_forge {scope, name, summary, manifest, intended_effects, source, config?}` — validate + scan + plan write; proposal kind `plugin-forge`; effect details carry the **full source**, digest, import list, declared manifest, intended effects, warnings, and the in-process privilege sentences; commit = `commitForgedPluginWrite` then controller load (write survives a failed mount — the source stays inert on disk for revision; the proposal reports the mount error).
  - `prepare_load {scope, name}` — remount a previously forged plugin in a later session; effects again carry the full current source and digest (the reviewer sees exactly what will run _this_ time); proposal kind `plugin-load`; commit = digest-checked controller load.
  - `prepare_unload {name}` — instance-id stale-guarded; proposal kind `plugin-unload`; commit = controller unload.
- Command `/omd-forged` lists forged plugins with scope, revision, digest prefix, active/invalid status.
- System-prompt section (order 112): forged plugins are agent-authored, in-process, and inert until an approved apply; never claim one is active before the apply reports Cordis state ACTIVE; prefer revising a failed plugin over retrying the same source.
- Forged `OrganIndexEntry` construction: `id` = slug, `module` = source file URL, `version` = `0.0.<revision>`, `source` = `'oh-my-dsh'` — constructed programmatically, never parsed through `parseOrganIndex` (whose bare-specifier rule guards only the curated index).
- Owner cleanup mirrors plugin-control: `registerOrganOwnerCleanup` per agent, lifecycle abort on service disposal.

- [x] End-to-end runtime test with a real `Context` and mocked agent: forge proposal → apply → file written, fiber ACTIVE, tool registered by the fixture plugin is invocable; unload reverses the effect; remount via `prepare_load` in a fresh owner works; tampered source between prepare and apply is rejected by the digest check.
- [x] Failed mount leaves the source on disk, proposal `failed`, nothing mounted; a revision through `prepare_forge` then succeeds.
- [x] `prepare_forge` output includes warnings and the import list; adversarial source (non-whitelisted import) is rejected at prepare, never reaching a proposal.
- [x] Run the full suite (`pnpm test`), typecheck, format.

### Task 5: Documentation and release notes

**Files:**

- Modify: `README.md`, `README.zh.md` (feature section + security framing verbatim; Chinese name 插件锻造), `CHANGELOG.md` (`0.1.6 - Unreleased`), `docs/upstream-upgrade-playbook.md` (new seam rows: `ts` parser API, `ctx.plugin` mount path shared with plugin-control), `docs/organ-bank-curation.md` (note: forged plugins are session artifacts, not catalog entries; promotion is phase 3)

- [x] README documents the whitelist-is-not-a-sandbox sentence verbatim in both languages.
- [x] CHANGELOG entry states the full flow and bounds.
- [x] Run format, typecheck, full tests; inspect `git diff`.

---

## Later phases (out of scope for this plan)

- **Phase 2 — selection pressure:** per-plugin usage counters (tool invocations attributed via effect labels), forged plugins surfaced in `capability_search` with a `forged` marker, and a capability-gap log (recorded `capability_search` misses) that gives forging a direction. These generate the evidence for what to forge, revise, or retire.
- **Phase 3 — promotion path:** `plugin_forge prepare_promote` assembles an audit packet (source, digest history, manifest, usage stats, revision log) as a human-reviewed pull request draft against `presets/plugins.json` / a real package — the bridge from session artifact to curated catalog entry. Runtime never writes the catalog.
