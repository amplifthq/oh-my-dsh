# rc.8 File-Reference Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let rc.8 own ordinary `@file` discovery and read-on-demand behavior while preserving OMD's explicit, bounded, hash-anchored line-range snapshots.

**Architecture:** Keep the existing parser and resolver contracts intact. Add one pure selection function between user-message parsing and resolution; `MentionRuntime` consumes only that selection. Then update public copy so plain paths and explicit range snapshots have distinct semantics.

**Tech Stack:** TypeScript, Cordis `agent/pre-step`, DeepSeek Harness rc.8, Node test runner, Prettier. No new dependencies.

**Spec:** [`../specs/2026-08-20-rc8-file-reference-seam-design.md`](../specs/2026-08-20-rc8-file-reference-seam-design.md)

## Global Constraints

- Plain `@path` and `@"path with spaces"` remain path-only and never trigger OMD content injection.
- Only valid `:start-end` ranges trigger an OMD snapshot.
- Preserve `extractMentions()` and `mentionsInMessages()` behavior for callers that need the complete parsed set.
- Preserve user-source filtering, workspace containment, caps, binary handling, provenance, and `hash_edit` anchors.
- Do not change dependency pins, bundle ordering, or upstream packages.
- No new npm dependencies.

---

### Task 1: Select explicit ranges for snapshot expansion

**Files:**

- Modify: `tests/mentions.test.mjs`
- Modify: `packages/mentions/src/index.ts`

**Interfaces:**

- Consumes: `mentionsInMessages(messages: readonly UserMessage[]): Mention[]`
- Produces: `snapshotMentionsInMessages(messages: readonly UserMessage[]): Mention[]`
- `MentionRuntime.expand()` resolves only `snapshotMentionsInMessages()` output.

- [ ] **Step 1: Write the failing selection test**

Add a user message containing `@plain.ts`, `@range.ts:2-4`, `@"plain path.md"`, `@"range path.md":5-6`, and an invalid range. Assert that `snapshotMentionsInMessages()` returns only the two valid ranged mentions. Keep the existing `mentionsInMessages()` assertion proving all direct-user mentions still parse.

- [ ] **Step 2: Run the focused test and verify red**

Run `npm run build && node --test --test-concurrency=1 tests/mentions.test.mjs`.

Expected: the new assertion fails because `snapshotMentionsInMessages` is not implemented.

- [ ] **Step 3: Implement the minimal selection seam**

Add a pure exported function that filters `mentionsInMessages()` to entries where both `start` and `end` are defined. Change only `MentionRuntime.expand()` to use it. Update the module comment and OMD system-prompt section so plain references are read on demand and ranged references are already attached.

- [ ] **Step 4: Verify green**

Run `npm run build && node --test --test-concurrency=1 tests/mentions.test.mjs`.

Expected: all mention parser, selector, resolver, cap, and renderer tests pass.

---

### Task 2: Publish the narrowed product contract

**Files:**

- Modify: `packages/mentions/package.json`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/upstream-upgrade-playbook.md`

**Interfaces:**

- Public syntax: plain `@path` is upstream path-only discovery; `@path:start-end` is an OMD same-step snapshot.
- Security claim: only OMD range snapshots are workspace-confined, bounded, and treated as data.

- [ ] **Step 1: Update package and README copy**

Replace claims that every `@file` mention is injected. State that rc.8 provides Web discovery/completion, the model reads plain references on demand, and explicit valid ranges receive bounded `hash_edit` anchors from OMD. Apply equivalent wording in English and Chinese, and record the behavior change under the changelog's Unreleased section.

- [ ] **Step 2: Strengthen the upgrade smoke**

Change the Web manual check from an ambiguous `@file` mention to two checks: select one ordinary file reference and verify the model reads it on demand; submit one explicit line range and verify the same-step anchored snapshot.

- [ ] **Step 3: Run repository verification**

Run, in order:

```sh
npx prettier --write packages/mentions/src/index.ts tests/mentions.test.mjs packages/mentions/package.json README.md README.zh.md CHANGELOG.md docs/upstream-upgrade-playbook.md docs/superpowers/specs/2026-08-20-rc8-file-reference-seam-design.md docs/superpowers/plans/2026-08-20-rc8-file-reference-seam.md
npm run typecheck
npm test
npm run format:check
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 4: Review and commit**

Inspect `git diff --stat`, `git diff`, and `git status --short`. Confirm no dependency pin, bundle, editor, or generated build artifact is included. Commit the cohesive migration as `feat: narrow @file snapshots to explicit ranges`.

## Self-review

- The selector task covers ordinary, quoted, ranged, invalid-range, and user-source semantics.
- The documentation task covers English, Chinese, package metadata, changelog, security wording, and upgrade verification.
- No placeholder requirements, new dependency, upstream patch, or unrelated refactor is present.
