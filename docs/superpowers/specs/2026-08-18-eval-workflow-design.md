# Eval as a workflow

**Date:** 2026-08-18  
**Status:** Proposed  
**Companion plan:** [`../plans/2026-08-18-eval-workflow.md`](../plans/2026-08-18-eval-workflow.md)  
**Locked surface:** `packages/harness-eval/src/contract.ts` (`eval_control` four actions: `snapshot`, `run`, `compare`, `show` — do not rename)

## Decision

Evaluation is a versioned workflow, not a rubric and not an online judge.

The first user is the agent. It captures a harness snapshot, runs frozen tasks, reads an evidence tree from files, and compares conditions. The human only `proposal_control apply`s mutations (including new eval tasks). `pass` is the conjunction of machine assertions. Assistant text, LLM-as-judge, and self-report are not score fields.

HarnessEval-W is the reference for _workflow shape_ (case-locked plan, sub-questions, tool evidence, skipped-skill reasons). It is not the reference for _reward_: their V1 still freezes plans and routes by case, never by the model under test. OMD keeps that discipline.

## Why this exists

The perceive → vary → select → retain loop has variation (`plugin_forge`, `skill_forge`) and a human select/retain gate. It does not yet have a repeatable, agent-invocable score. Without that score, promotion and distillation optimize self-report.

Three failures to avoid:

1. **Static Q&A only** — a score with no files the agent can `show`/`grep`.
2. **Judge in the RSI loop** — the subject writes or steers the measuring tape during the same `compare`.
3. **Living suite without versions** — new tasks silently change what `regress` means.

## Product constraints

- Overlay only. No upstream patches, no `node_modules` edits, no catalog writes from eval.
- Agent-first: tool schema + `capability_search` + `next` tool names. `/omd-eval` is a human copy.
- Visible ≠ authorized. `eval_control` never applies, mounts, or writes `presets/plugins.json`.
- `run` requires `snapshot_digest`. Never infer `"current"`.
- Intervention is `ablate` only, target `skill:` or `plugin:` (including `plugin:forged/<scope>/<slug>`).
- Routing (which assertions fire) depends on the **task plan**, not on the snapshot being scored.
- A `compare` is only valid when both runs share `task_id` and `suite_digest`.
- Do not commit unless the user asks.

## Three layers

```
C  living suite          propose task → validate → human apply → new suite_digest
B  evidence workflow     plan (frozen per task) → assert → tools → evidence tree
A  frozen scorer         score.json: pass = conjunction; compare diff | ablate
                              ↑
                         eval_control (locked)
```

| Layer | Writes                                        | May evolve during one `compare`? | Who                                             |
| ----- | --------------------------------------------- | -------------------------------- | ----------------------------------------------- |
| A     | `score.json`                                  | No                               | First-party interpreter                         |
| B     | `assertions.json`, `trace.jsonl`, `meta.json` | No (plan is on the task)         | Same runner, different files                    |
| C     | `tasks/<id>/` under an eval root              | Only **between** suite versions  | Agent proposes, validator checks, human applies |

Layer B is HarnessEval’s four steps mapped onto files, not onto a parent LLM that assigns `pass`.

| HarnessEval step | OMD                                                                      |
| ---------------- | ------------------------------------------------------------------------ |
| Select skill     | Read `task.plan.skills`. Record skips with reasons.                      |
| Decompose        | Each plan skill expands to declared `assertions[].id`.                   |
| Find evidence    | First-party assertion kinds call tools/scripts. Pointers go in the tree. |
| Review           | `score` recomputes `pass` from assertion booleans. No second model.      |

## Layer A — frozen scorer

Already locked in `contract.ts`. This spec does not add actions.

**Score record** stays slim: `task_id`, `run_id`, `snapshot_digest`, `condition_digest`, `intervention`, `pass`, `assertions: {id, pass}[]`, `tokens`, `duration_ms`, `error?`. Forbidden keys stay forbidden.

Add one required field when the runner lands: `suite_digest` (64 hex). `parseScoreRecord` must require it and `compareScores` must reject a pair with unequal `suite_digest`. This is an additive lock: old fixture scores in unit tests that omit it fail until updated.

`compare mode=diff` — promotion gate. `regress` if any assertion that passed on baseline fails on candidate. `faithful` is absent.

`compare mode=ablate` — Faithfulness. Same `snapshot_digest`, baseline intact, candidate ablated. `faithful` iff pass or assertion vector differs. Token/duration shift is `cost_shifted` only.

`promotionAllowed` / `distillJustified` stay as locked.

## Layer B — evidence workflow

### Task document

Bundled path: `packages/harness-eval/tasks/<id>/task.json`  
Admitted user/project path: `$DSH_HOME/omd/eval/tasks/<id>/` or `<workspace>/.dsh/eval/tasks/<id>/`

```json
{
  "id": "forged-tool-invocable",
  "summary": "A forged plugin tool runs after mount and fails when ablated.",
  "suite": "omd-eval-v1",
  "plan": {
    "skills": ["assert-tool-invocable"],
    "skip": [{ "id": "assert-live-headless", "reason": "live runner off" }]
  },
  "fixture": "fixture",
  "assertions": [
    {
      "id": "tool-invocable",
      "skill": "assert-tool-invocable",
      "kind": "tool-execute",
      "tool": "forged_echo",
      "args": { "message": "ping" },
      "expect": "ping"
    }
  ],
  "timeout_ms": 30000
}
```

- `id` matches the directory and `TASK_ID_PATTERN`.
- `plan.skills` is the frozen routing table. The runner must not add skills because the snapshot looks hard.
- `plan.skip` is optional documentation of skills that exist in the library but do not apply to this case (HarnessEval: evidence-grounded skip reasons).
- `assertions[].id` unique; `pass` in the score is their conjunction.
- `kind` is a first-party assertion interpreter. **Agents cannot forge new kinds in v1.** New kinds are a package change.

### Assertion kinds (v1 library)

| Kind                            | Evidence                                                                 | Typical use                   |
| ------------------------------- | ------------------------------------------------------------------------ | ----------------------------- |
| `path-exists` / `path-absent`   | Workspace path after overlay                                             | Extra-write / fixture present |
| `command-exit`                  | Spawn `command` in the overlay cwd, record exit + bounded stdout         | Scripted checks               |
| `tool-execute`                  | Isolated `Context`, mount snapshot plugins (minus ablate), call one tool | Plugin faithfulness           |
| `search-hits` / `search-misses` | `searchCapabilities` over a snapshot-derived catalog                     | Discovery                     |
| `catalog-untouched`             | SHA-256 of `presets/plugins.json` bytes                                  | Promotion safety              |
| `digest-equals`                 | Named digest field equals expected                                       | Snapshot stability            |

`assert-live-headless` is **declared skipped** in v1 plans. Implementing it is a later suite version, behind `OMD_EVAL_LIVE=1`, and must still emit machine assertions (headless process exit + fixture `verify.mjs`), never assistant text.

### Evidence tree

`assertions.json` is the tree (no new `show` file, no new action):

```json
{
  "task_id": "forged-tool-invocable",
  "suite_digest": "…",
  "plan": { "skills": ["assert-tool-invocable"], "skip": [] },
  "nodes": [
    {
      "id": "tool-invocable",
      "skill": "assert-tool-invocable",
      "kind": "tool-execute",
      "tool": "forged_echo",
      "pass": true,
      "evidence_ref": "run:<id>/trace"
    }
  ]
}
```

`score.json` projects `nodes` to `{id, pass}[]`. `trace.jsonl` is append-only tool/script records (no assistant messages). `grep` over `traces` and `assertions` is the Meta-Harness channel.

### Runner (v1)

**Chosen approach: isolated overlay + first-party interpreters. No LLM in the default path.**

| Approach                     | Pros                                                 | Cons                                                          | Verdict       |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- | ------------- |
| Always `omd headless`        | True agent RSI                                       | Needs keys, slow, flaky CI, self-report temptation            | Later, opt-in |
| In-process on the live agent | Cheap                                                | Pollutes the session, cannot ablate safely                    | Rejected      |
| Overlay + interpreters       | Deterministic, testable, plugin Faithfulness is real | Skills that only change prompts stay weakly tested until live | **v1**        |

`run`:

1. Resolve task (bundled, then user, then project). Reject unknown `task_id`.
2. Build overlay from `snapshot_digest` + optional `intervention`.
3. Execute each assertion in plan order with `timeout_ms`.
4. Allocate `run_id` (`run-` + 12 lowercase hex from `randomBytes`).
5. Write `meta.json`, `intervention.json`, `assertions.json`, `trace.jsonl`, `score.json`, append `index.jsonl`.
6. Return the locked envelope (`files` + `next`).

Overlay construction:

- Temp directory under `os.tmpdir()`, prefix `omd-eval-`, deleted in `finally`.
- Skills: copy `SKILL.md` files listed in the snapshot except an ablated `skill:` target.
- Forged plugins: copy source + metadata except an ablated `plugin:forged/…` target.
- Catalog plugins: in-memory list for `search-*` / `tool-execute` mount set; ablate drops that id.
- `cordis.patch.yml`: materialize bytes from the snapshot’s recorded digest (store the blob next to `snapshot.json` as `patch.yml` when capturing).
- Fixture: copy `tasks/<id>/fixture/` into the overlay cwd when present.

`tool-execute` uses a fresh `Context` (same pattern as `tests/plugin-forge.test.mjs`), not the user’s session.

Tokens in v1 default to `{ input: 0, output: 0 }` unless a kind records real usage. Duration is wall clock for the run.

### Snapshot capture

`snapshot` reads the live agent and writes `omd/eval/snapshots/<digest>/`:

- `snapshot.json` — composition already defined (`skills[]`, `plugins[]`, `patch_digest`)
- `patch.yml` — exact bytes hashed into `patch_digest` (empty file iff digest is `""`)
- copies or content-addressed blobs for each skill/plugin body so a later overlay does not depend on the live tree still being there

Digest algorithm stays `snapshotDigest()` in `contract.ts`. Capture must sort and normalize refs the same way.

## Layer C — living suite

### Suite identity

`suite_digest` = SHA-256 of the canonical list `{ id, task_digest }[]` sorted by `id`, where `task_digest` hashes the task.json bytes (not the fixture tree — fixtures are included by hashing every file under `fixture/` the same way). Changing one assertion id changes the suite.

Bundled suite id is `omd-eval-v1`. Adding a bundled task is a package release. That is how the measuring tape evolves: **new suite version**, not a hot patch during `compare`.

### Case construction (not in the v1 runner)

Agent-authored tasks use a new proposal kind `eval-task`:

- Effects show full `task.json` and a file list of the fixture (paths + digests, bodies in details if ≤ 32 KiB total).
- Commit writes under user or project eval-task root (same containment / symlink / stale-guard discipline as skill-forge).
- Runtime **never** writes into `packages/harness-eval/tasks/` (that is git / release).

Independent validator (same process, not a second LLM) **before** a proposal can exist:

- `id` matches `TASK_ID_PATTERN` and the directory name.
- Every `assertions[].kind` is in the first-party library.
- Every `plan.skills` entry is referenced by at least one assertion.
- `command-exit` / fixture paths stay inside the task directory (lexical + realpath).
- Fixture has no secret-like content (`detectSecretLikeContent`).
- Same snapshot + task dry-run twice in the interpreter → identical `{id, pass}[]` (no live LLM).

Fail → no proposal. This is HarnessEval’s Validation Agent, as code.

v1 ships **only bundled tasks**. `eval-task` is a later plan so the runner and suite digest exist first.

## Agent-first loop

```
eval_control snapshot
eval_control run  { task_id, snapshot_digest }
eval_control run  { task_id, snapshot_digest, intervention }
eval_control compare { mode: "ablate", task_id, snapshot_digest, target }
eval_control compare { mode: "diff", task_id, baseline, candidate }
plugin_forge prepare_promote   # only if promotionAllowed
proposal_control apply         # human
```

System-prompt section (order ~113, after plugin-forge): snapshot before run; `show`/`grep` for evidence; `compare` before claiming a skill/plugin helped or preparing promote; eval never applies.

`plugin_forge prepare_promote` (v1 gate): require a stored compare with `mode=diff`, `!regress`, `suite_digest` equal to the active bundled suite, and the candidate snapshot listing the forged plugin being promoted; **and** a stored `mode=ablate` compare that is `distillJustified` (faithful) for that plugin. If either is missing, throw and point at `eval_control compare`. Updating an existing skill with `skill_control prepare_save` requires the same faithful ablate on `skill:<slug>`. A first skill save is still a proposal (the skill is not yet in a snapshot to ablate).

## Bundled tasks (v1 suite)

Eight tasks, all interpreter-only:

1. `snapshot-stable` — two captures of the same composition → same digest.
2. `forged-tool-invocable` — fixture forged echo tool runs; ablate fails `tool-invocable`.
3. `forged-search-hit` — `capability_search` style catalog includes `plugin:forged/…`.
4. `catalog-untouched` — `presets/plugins.json` digest matches the shipped file.
5. `gap-is-not-a-score` — a search miss writes no `pass: true` from text (assert gap journal shape only).
6. `ablate-changes-condition` — intact vs ablate `condition_digest` differ.
7. `no-extra-write` — after `command-exit` of a no-op verify, overlay cwd has no files outside the fixture allowlist.
8. `score-rejects-judge` — loading a planted illegal `score.json` fails `parseScoreRecord` (meta-eval of the scorer).

These prove the workflow and give plugin promotion a real `compare`. They do not claim to rank foundation models.

## Security / Misevolution

- Eval assertion kinds are first-party. Session-forged plugins must not register `eval_control` or overwrite the eval store root.
- Traces redact secret-like strings (reuse skill-forge detector); redacted queries already exist for gaps.
- Overlay temps are not the user’s workspace; `tool-execute` does not inherit the live agent’s tools except what the snapshot lists.
- The subject agent can propose tasks (later) but cannot change kinds or `suite_digest` of an in-flight compare.

## Non-goals (this spec)

- Training a harness engineer or mounting Python BO.
- `opt_control` (shipped separately as `oh-my-dsh/harness-opt`; proposer only).
- Web eval UI.
- World-model video metrics.
- Evaluator that adds skills while scoring a candidate.
- Bundling HarnessEval-W.

## File map

| Path                                     | Responsibility                                                  |
| ---------------------------------------- | --------------------------------------------------------------- |
| `packages/harness-eval/src/contract.ts`  | Locked surface; add `suite_digest` to score/compare             |
| `packages/harness-eval/src/task.ts`      | Parse/validate `task.json`, suite digest, assertion kinds table |
| `packages/harness-eval/src/store.ts`     | Eval roots, atomic run writes, index, snapshot blobs            |
| `packages/harness-eval/src/snapshot.ts`  | Capture live skills/plugins/patch                               |
| `packages/harness-eval/src/overlay.ts`   | Temp overlay + ablate                                           |
| `packages/harness-eval/src/interpret.ts` | Execute kinds, build tree, project score                        |
| `packages/harness-eval/src/index.ts`     | `eval_control` execute → real handlers; `/omd-eval`; prompt     |
| `packages/harness-eval/tasks/*`          | Bundled `omd-eval-v1`                                           |
| `packages/plugin-forge/src/index.ts`     | `prepare_promote` compare gate                                  |
| `bundles/omd.cordis.yml`                 | Mount `oh-my-dsh/harness-eval` after plugin-forge               |
| `tests/harness-eval.test.mjs`            | Contract + store + overlay + interpreter + runtime              |

## Acceptance

- Same snapshot + task, two runs → identical `{id, pass}[]` and `suite_digest`.
- Ablating the forged echo plugin flips `forged-tool-invocable` and sets `distillJustified` on that pair.
- `compare mode=diff` across different `suite_digest` throws.
- Planted judge fields in `score.json` throw.
- `presets/plugins.json` bytes unchanged after any eval action.
- Full suite (`npm test`) green; plugin-forge promote without a diff compare is rejected once the gate lands.
