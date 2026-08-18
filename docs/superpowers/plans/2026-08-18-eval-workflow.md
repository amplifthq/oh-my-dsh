# Eval Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the locked `eval_control` surface into a real evaluation workflow: frozen suite + overlay runner + evidence tree files + compare gates, with the agent as the first user and the human still the only `apply`.

**Architecture:** Keep `contract.ts` as the action lock. Add `task.ts` (documents + suite digest), `store.ts` (eval filesystem), `snapshot.ts` (live capture), `overlay.ts` (ablate), `interpret.ts` (first-party assertion kinds). `index.ts` stops returning a dry plan and writes runs. `prepare_promote` refuses without a non-regressing `compare mode=diff` on the bundled suite.

**Tech Stack:** Existing OMD overlay (Cordis `Context`, `defineTool`, Node test runner, atomic temp+rename from skill-forge/plugin-forge). No LLM in the default runner. No new npm dependencies.

**Spec:** [`../specs/2026-08-18-eval-workflow-design.md`](../specs/2026-08-18-eval-workflow-design.md)

## Global Constraints

- Overlay only: no upstream patches, no `node_modules` edits, never write `presets/plugins.json`.
- Do not rename or add `eval_control` actions. Additive score field: `suite_digest` (required).
- Assertion kinds are first-party. No session-forged eval kinds in this plan.
- `run` requires `snapshot_digest`. Intervention is `ablate` only on `skill:` / `plugin:`.
- Compare pairs must share `task_id` and `suite_digest`.
- Routing follows `task.plan` only — never the snapshot under test.
- Agent-first tool/`next` copy. `/omd-eval` is secondary.
- Do not create a git commit unless the user explicitly requests one.

---

### Task 1: Task document, suite digest, assertion kind table

**Files:**

- Create: `packages/harness-eval/src/task.ts`
- Modify: `packages/harness-eval/src/contract.ts` (`ScoreRecord.suite_digest`, `compareScores` suite check, `parseScoreRecord`)
- Extend: `tests/harness-eval.test.mjs`

**Interfaces:**

- `EvalAssertionKind = 'path-exists' | 'path-absent' | 'command-exit' | 'tool-execute' | 'search-hits' | 'search-misses' | 'catalog-untouched' | 'digest-equals'`
- `EvalTaskDocument { id, summary, suite, plan: { skills: string[], skip?: { id: string, reason: string }[] }, fixture?: string, assertions: EvalTaskAssertion[], timeout_ms: number }`
- `EvalTaskAssertion { id, skill, kind: EvalAssertionKind, ...kind fields }`
- `parseEvalTaskDocument(value: unknown): EvalTaskDocument` — `id` is `TASK_ID_PATTERN`; every `kind` is in the table; every `plan.skills` entry is referenced by ≥1 assertion; assertion ids unique; `timeout_ms` integer 1_000–120_000.
- `taskDigest(taskDir: string, document: EvalTaskDocument): Promise<string>` — hash canonical document plus every file under `fixture/` (sorted POSIX paths, file bytes).
- `suiteDigest(entries: { id: string, task_digest: string }[]): string` — canonical sort by `id`.
- `parseScoreRecord` requires `suite_digest` (`DIGEST_PATTERN`).
- `compareScores` throws `compare requires both runs to share suite_digest` when they differ.

- [x] Update existing score fixtures in `tests/harness-eval.test.mjs` to include a shared `SUITE` digest constant so current compare tests still pass.
- [x] Tests: valid task parse; reject unknown kind; reject plan skill with no assertion; suite digest changes when an assertion id changes; compare rejects mismatched `suite_digest`.
- [x] `npm run build && node --test --test-concurrency=1 tests/harness-eval.test.mjs`

---

### Task 2: Eval store — snapshot blobs, run writes, index, show/grep I/O

**Files:**

- Create: `packages/harness-eval/src/store.ts`
- Extend: `tests/harness-eval.test.mjs`

**Interfaces:**

- `EvalRoots { dshHome: string, workspace?: string, bundledTasks: string }`
- `evalStoreRoot(roots): string` → `{dshHome}/omd/eval`
- `writeSnapshot(roots, composition, blobs: { patch?: Buffer, files: { ref: string, bytes: Buffer }[] }): Promise<{ digest: string, dir: string }>`
- `readSnapshot(roots, digest): Promise<StoredSnapshot | undefined>` — composition + blobs; `digestMatches` on rehash.
- `writeRun(roots, input: { task_id, snapshot_digest, suite_digest, intervention, score, tree, traces: object[], meta }): Promise<{ run_id: string }>` — `run_id = 'run-' + randomBytes(6).toString('hex')`; atomic per-file temp+rename; refuse symlink run dirs (copy skill-forge `assertSafeTarget` shape).
- `readRun(roots, run_id)` / `listRuns(roots, filter?: { task_id?, snapshot_digest? })`
- `appendIndex(roots, row)` — `index.jsonl`, retain last 2_000 rows (same cap idea as forge usage).
- `showArtifact(roots, artifact, max_bytes): Promise<{ content: string, truncated: boolean, path: string }>`
- `grepEvalStore(roots, query, scope: GrepScope, limit = GREP_DEFAULT_HITS): Promise<{ ref, path, line }[]>`

- [x] Tests: snapshot round-trip; run write then `show` score/trace; grep finds an assertion id; symlink run directory refused; catalog file is never opened for write.
- [x] Focused test file green.

---

### Task 3: Live snapshot capture

**Files:**

- Create: `packages/harness-eval/src/snapshot.ts`
- Extend: `tests/harness-eval.test.mjs`

**Interfaces:**

- `captureSnapshot(input: { skills: { ref, bytes }[], plugins: { ref, bytes, revision? }[], patchBytes: Buffer | null }): SnapshotComposition` then `writeSnapshot`.
- `captureFromAgent(agent, roots, deps: { listSkills, listPlugins, readPatch }): Promise<{ digest: string }>` — normalize refs via `normalizeInterventionTarget`; `patch_digest` is `''` when no patch file.
- Live paths: user/project skills from the same roots skill-forge uses; forged plugins via `ctx.get('pluginForge')?.listForDiscovery` plus source bytes; catalog plugins via `pluginControl.list`; patch from workspace `cordis.patch.yml` if present.

- [x] Test with fake deps (no live agent): same composition twice → same digest; swapping plugin bytes changes digest; skill ref encoding matches `capabilityRef`.
- [x] Focused test file green.

---

### Task 4: Overlay + ablate

**Files:**

- Create: `packages/harness-eval/src/overlay.ts`
- Extend: `tests/harness-eval.test.mjs`

**Interfaces:**

- `buildOverlay(input: { snapshot: StoredSnapshot, intervention: Intervention | null, fixtureDir?: string }): Promise<{ cwd: string, dispose(): Promise<void>, mountedPluginRefs: string[], skillRefs: string[] }>`
- Temp dir `join(tmpdir(), 'omd-eval-' + randomBytes(8).toString('hex'))`.
- Copy snapshot blobs; omit the ablated target (compare via `normalizeInterventionTarget`).
- Copy fixture directory into `cwd` when provided (containment: fixture must sit under the task dir).
- `dispose` `rm` recursive force; always called from runner `finally`.

- [x] Tests: intact overlay lists forged plugin file; ablate removes it; fixture file appears in cwd; `dispose` deletes the temp tree; ablating `tool:bash` is rejected before build (contract already rejects; overlay should not see it).
- [x] Focused test file green.

---

### Task 5: Interpreter + bundled `omd-eval-v1` tasks

**Files:**

- Create: `packages/harness-eval/src/interpret.ts`
- Create: `packages/harness-eval/tasks/snapshot-stable/task.json`
- Create: `packages/harness-eval/tasks/forged-tool-invocable/task.json` (+ `fixture/` echo plugin source matching plugin-forge `ECHO_SOURCE` / `TOOLSMITH_SOURCE` style)
- Create: the other six bundled tasks from the spec (minimal fixtures)
- Extend: `tests/harness-eval.test.mjs`

**Interfaces:**

- `interpretRun(input: { task: EvalTaskDocument, overlay, snapshot, suite_digest }): Promise<{ score: ScoreRecord, tree: EvidenceTree, traces: object[] }>`
- Kind dispatch:
  - `path-exists` / `path-absent` — `lstat` under `overlay.cwd` only (reject `..`).
  - `command-exit` — `spawn` with `cwd: overlay.cwd`, no shell, argv array from the assertion; timeout `task.timeout_ms`.
  - `tool-execute` — new `Context`, mount remaining forged/catalog plugins from overlay files, `defineTool` execute, compare string result to `expect`.
  - `search-hits` / `search-misses` — build descriptors from overlay refs, `searchCapabilities`.
  - `catalog-untouched` — hash repo `presets/plugins.json` (read-only).
  - `digest-equals` — compare two digest strings from the assertion.
- Skip `plan.skip` skills: they do not produce assertion nodes.
- Project `tree.nodes` → `score.assertions`; `pass` is conjunction; tokens `{input:0,output:0}` unless a kind sets them.

- [x] Tests: forged echo `tool-execute` passes intact and fails after ablate; `catalog-untouched` passes; path escape `../` rejected; planted `judge` in a fake score file still rejected by `parseScoreRecord`; two interpret passes on the same overlay match.
- [x] `suiteDigest` of the eight bundled tasks is stable (snapshot the hex in the test).
- [x] Focused test file green.

---

### Task 6: Wire `eval_control` execute to the store/runner

**Files:**

- Modify: `packages/harness-eval/src/index.ts`
- Extend: `tests/harness-eval.test.mjs`

**Interfaces:**

- `HarnessEvalRuntime extends Service`, `inject = ['tools', 'commands', 'systemPrompt']`, optional `ctx.get('pluginForge')` / `pluginControl` / `skills` like capability-discovery.
- `provide('harnessEval')`.
- `execute` → `parseEvalControlRequest` → handlers:
  - `tasks` — list bundled + admitted store tasks
  - `snapshot` — `captureFromAgent` then envelope + `nextAfterSnapshot`
  - `run` — interpret + `writeRun`
  - `score` — re-read tree, recompute `pass`, rewrite `score.json` if assertions changed (they should not)
  - `compare` — load scores; `ablate` mode uses `nextMissingAblatePair` when a run is missing
  - `show` / `grep` / `runs` — store
- Persist compare results under `compares/<digest>/compare.json` (`compare` digest = hash of mode + task + suite + run ids / intervention).
- Command `/omd-eval` — list tasks and last 10 runs (human copy).
- System prompt `omd:harness-eval` order 113: snapshot before run; files not summaries; compare before promote; eval does not apply.

- [x] Runtime test with mocked agent + tmp `DSH_HOME`: `snapshot` → `run` `forged-tool-invocable` → `run` with ablate → `compare mode=ablate` → `faithful: true`.
- [x] `run` without `snapshot_digest` still throws (contract).
- [x] Focused test file green.

---

### Task 7: Mount, discovery, promote gate, docs

**Files:**

- Modify: `bundles/omd.cordis.yml` — insert `omd-harness-eval` / `oh-my-dsh/harness-eval` after `omd-plugin-forge`
- Modify: `packages/plugin-forge/src/index.ts` — `preparePromote` loads the latest matching diff compare from the eval store; throw if missing or `regress` or snapshot omits this slug
- Modify: `tests/plugin-forge.test.mjs` — promote without compare rejected; with a planted non-regress compare allowed
- Modify: `README.md`, `README.zh.md`, `CHANGELOG.md` Unreleased, `docs/organ-bank-curation.md` (eval does not admit catalog entries)

- [x] `capability_search` finds `tool:eval_control` after mount (existing discovery runtime test pattern).
- [x] `prepare_promote` error text tells the agent to call `eval_control compare`.
- [x] `presets/plugins.json` byte-identical in the promote test (existing assertion).
- [x] `npm test` (full suite), `npm run typecheck`, `npx prettier --write` on touched files.

---

## Later plans (do not implement here)

- Proposal kind `eval-task` + validator (Layer C).
- `OMD_EVAL_LIVE=1` headless assertion kind and a new suite version `omd-eval-v2`.
- `trace_control`. Usage, gaps, and compare files are enough to observe.
- Living suite / `eval-task`, `OMD_EVAL_LIVE`, self-apply, BO, or an LLM judge.

---

## Spec coverage

| Spec section                                | Task  |
| ------------------------------------------- | ----- |
| `suite_digest` on scores/compare            | 1     |
| Filesystem artifacts                        | 2     |
| Live snapshot blobs                         | 3     |
| Ablate overlay                              | 4     |
| Kinds + eight bundled tasks + evidence tree | 5     |
| Agent-facing execute / prompt / command     | 6     |
| Bundle mount + promote gate + docs          | 7     |
| `eval-task` / live headless                 | Later |
