# Skill Forge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent distill a verified, repeatable procedure from the current session into a durable `SKILL.md`, written only through the existing proposal → approval → commit → verify lifecycle, and picked up live by the upstream skill watcher without a restart.

**Architecture:** A new `skill-forge` package provides pure document validation/rendering plus a `SkillForgeRuntime` service that registers `skill_control`. `prepare_save` returns a `skill-write` proposal with exact before/after content; an approved commit performs an atomic, containment-checked, stale-guarded host-side write into `$DSH_HOME/skills/<slug>/SKILL.md` (user scope) or `<workspace>/.dsh/skills/<slug>/SKILL.md` (project scope). `@deepseek-ai/dsh-skill-filesystem` watches those roots (`watch` defaults to `true`), so a saved skill becomes available in the same session.

**Tech Stack:** TypeScript 7, Cordis services, dsh rc.6 (`tools`, `systemPrompt`, `commands`), OMD `proposals`, Node test runner.

**Verified seams (do not re-derive):**

- Upstream native skill roots are `$DSH_HOME` and `$DSH_AGENTS_HOME` plus project equivalents; frontmatter is YAML with `name`, `description`, `whenToUse` (see `presets/skills/*/SKILL.md`).
- `dsh-skill-filesystem` watches host-local skill roots by default (`watch: z.boolean().default(true)` in its config).
- Upstream ships no skill-writing tool (`dsh-tools` types contain none); this capability is genuinely missing.
- The proposal plane (`packages/proposals`) already provides per-agent isolation, single-commit semantics, and the `ask` approval gate.

## Global Constraints

- Keep `oh-my-dsh` a Cordis overlay; no upstream patches, no `node_modules` edits.
- Proposal visibility is never authorization; every `skill_control` save flows through `proposal_control apply` and its `ask` decision.
- All writes are atomic (temp + rename), containment-checked after path resolution, and stale-guarded: capture the existing file's content hash at prepare, recheck at commit, fail the proposal on drift.
- Skill content is bounded: slug `^[a-z0-9][a-z0-9-]{0,40}$`, description ≤ 500 chars, body ≤ 32 KiB.
- Secret-looking content produces warnings surfaced in the proposal effects, never a silent save.
- Do not create a git commit unless the user explicitly requests one.

---

### Task 1: Pure skill document model

**Files:**

- Create: `packages/skill-forge/package.json`
- Create: `packages/skill-forge/src/document.ts`
- Create: `tests/skill-forge.test.mjs` (document sections)

**Interfaces:**

- Produces `validateSkillInput(input): SkillDocument` (throws on violation).
- Produces `renderSkillMarkdown(document): string` and `parseSkillMarkdown(content): SkillDocument`.
- Produces `detectSecretLikeContent(content): string[]` (warnings, not rejections).
- Produces `planSkillWrite(document, existingContent?): SkillWritePlan` with `action: 'create' | 'update'`, rendered `after`, optional `before`, and `warnings`.

- [x] Define `SkillDocument` (`slug`, `description`, `whenToUse?`, `body`) and frontmatter render/parse that round-trips the bundled preset skills byte-for-byte modulo key order.
- [x] Enforce slug, description, and body bounds; reject path-flavored slugs (`../`, absolute, unicode dots) at validation, not only at path resolution.
- [x] Implement secret heuristics (`sk-…`, `AKIA…`, `ghp_…`, `-----BEGIN … PRIVATE KEY`, `<NAME>_KEY=`-style assignments) returning human-readable warnings.
- [x] Write failing tests first: round-trip, every rejection class, warning detection, create-vs-update plans.
- [x] Run the focused test file and inspect `git diff`.

### Task 2: Roots, containment, stale guard, atomic write

**Files:**

- Create: `packages/skill-forge/src/store.ts`
- Extend: `tests/skill-forge.test.mjs` (store sections)

**Interfaces:**

- Produces `resolveSkillTarget(scope, slug, { dshHome, workspace }): { root, directory, path }`.
- Produces `readExistingSkill(path): { content, digest } | undefined`.
- Produces `commitSkillWrite(target, plan, expectedDigest?): Promise<void>`.

- [x] Resolve user scope to `$DSH_HOME/skills/<slug>/SKILL.md` and project scope to `<workspace>/.dsh/skills/<slug>/SKILL.md`; reject project scope when the session has no workspace.
- [x] After resolution, require the realpath of the target directory's parent chain to stay inside the chosen root; reject symlinked skill directories via `lstat`.
- [x] Stale guard: `prepare` records the existing file's SHA-256 (or absence); `commit` re-reads and fails on mismatch without writing.
- [x] Atomic write: `mkdir -p`, temp file + `rename`, mode `0644`; no temp residue on failure.
- [x] Tests: containment violations, symlink rejection, stale-digest failure, atomicity on injected rename failure, successful create and update.
- [x] Run the focused test file and inspect `git diff`.

### Task 3: Runtime service, tool, command, and prompt

**Files:**

- Create: `packages/skill-forge/src/index.ts`
- Modify: `packages/proposals/src/index.ts` (extend `ProposalKind` with `'skill-write'`)
- Extend: `tests/skill-forge.test.mjs` (runtime sections)

**Interfaces:**

- Produces `Context.skillForge: SkillForgeRuntime`.
- Consumes `ctx.proposals`, `ctx.tools`, `ctx.systemPrompt`, `ctx.commands`.
- Registers `skill_control` with action `prepare_save` (`scope`, `name`, `description`, `when_to_use?`, `body`).
- Registers the `/omd-distill` command expanding to a distillation instruction.

- [x] Add `'skill-write'` to `ProposalKind`; update proposals tests if the union is asserted anywhere.
- [x] `prepare_save` validates, plans, and creates a proposal whose effects carry target path, action, warnings, and full before/after content; the commit callback runs the Task 2 store write with the recorded digest.
- [x] Resolve the session workspace from the same source the refactor package uses for containment; user scope must work with no workspace.
- [x] Add a `systemPrompt` section (order 110): after a non-trivial task yields a verified, repeatable procedure, offer `skill_control prepare_save`; never claim a skill was saved before an approved apply.
- [x] Register `/omd-distill`: instructs the model to draft slug, description, when-to-use, and body from the current session, then call `prepare_save`.
- [x] Tests: tool argument validation, proposal effect shape (before/after/warnings present), commit path end-to-end against a temp `DSH_HOME`, failed-commit proposal state.
- [x] Run `pnpm test` and inspect `git diff`.

### Task 4: Distribution wiring, documentation, verification

**Files:**

- Modify: `bundles/omd.cordis.yml`
- Modify: `package.json` (exports)
- Modify: `README.md`, `README.zh.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Exports `oh-my-dsh/skill-forge`.
- Bundle row loads after `proposals`.

- [x] Add the bundle row and package export; keep `files`/`dist` publishing intact.
- [x] Document the growth loop in both READMEs (daily-use tools section): `skill_control`, `/omd-distill`, approval gating, live pickup, bounds, and the project-vs-user scope rule.
- [x] Add the `CHANGELOG.md` entry under a new `0.1.5` heading (unreleased).
- [x] Run `pnpm format:check`, `pnpm typecheck`, `pnpm test`.
- [x] Run `npm pack --dry-run` and verify the new package ships.
- [x] Run `DSH_HOME=$(mktemp -d) node bin/omd setup && node bin/omd config` and verify the new row resolves.

---

## Out of scope (recorded so it stays out)

- `prepare_remove` / skill deletion — a later, smaller proposal kind.
- Kernel-script → persistent tool promotion — same flywheel, much larger security surface.
- `plugin_control` (session-scoped organ swap from a curated catalog) — the flagship this feature feeds; needs the Cordis registry seam and a curation pipeline first.
