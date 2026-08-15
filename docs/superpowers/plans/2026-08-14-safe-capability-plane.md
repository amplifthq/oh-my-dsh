# Safe Capability Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session-scoped lazy MCP activation and recoverable semantic LSP refactors behind one proposal, approval, commit, and verification protocol.

**Architecture:** A new `proposals` service owns pending effects and the only approval-gated apply tool. A new `mcpControl` service receives inert server definitions from discovery and mounts upstream MCP fibers only after an approved proposal. A new `refactors` service reuses OMD's language-server catalog, requests safe `WorkspaceEdit` values through a public compatibility transport, converts them into version-guarded file plans, and applies them with a private recovery journal.

**Tech Stack:** TypeScript 7, Cordis services, DeepSeek Harness rc.6 services (`tools`, `fs`, `subprocess`, `approval`), MCP client, LSP JSON-RPC, Node test runner.

## Global Constraints

- Keep `oh-my-dsh` a Cordis overlay; do not patch `node_modules` or ship a DeepSeek Harness fork.
- Preserve Node.js `^22.19.0 || >=24.0.0`.
- Never expand MCP environment placeholders before approved activation.
- Project MCP definitions remain unavailable until `omd trust add`.
- Proposal visibility is not authorization; every `proposal_control.apply` call must return an explicit `ask` decision.
- LSP resource operations and `workspace/executeCommand` are rejected.
- Multi-file refactors are described as validated and recoverable, not crash-atomic.
- Every file write uses the observed `FsVersion`; stale files fail before publication.
- Recovery journals use mode `0600`, live under `$DSH_HOME/omd/refactors`, and are deleted after successful apply or rollback.
- Do not create a git commit unless the user explicitly requests one.

---

### Task 1: Proposal service and approval gate

**Files:**

- Create: `packages/proposals/package.json`
- Create: `packages/proposals/src/index.ts`
- Create: `tests/proposals.test.mjs`

**Interfaces:**

- Produces `Context.proposals: ProposalRuntime`.
- Produces `ProposalRuntime.create(agent, input): ProposalView`.
- Produces `ProposalRuntime.list(agent)`, `show(agent, id)`, `discard(agent, id)`, and `apply(agent, id, exec)`.
- Registers model tool `proposal_control` with actions `list`, `show`, `apply`, and `discard`.

- [ ] Define JSON-safe `ProposalEffect`, `ProposalView`, `ProposalCommitResult`, and private callback-bearing `ProposalRecord`.
- [ ] Write failing tests for monotonic IDs, per-agent isolation, failed-apply terminal state, and discard.
- [ ] Implement the in-memory service using a `WeakMap<Agent, Map<string, ProposalRecord>>`.
- [ ] Register `tools/pre-execute`; return `{ kind: "ask", reason }` only for `proposal_control` action `apply`, otherwise delegate with `next()`.
- [ ] Register `proposal_control`; require `proposal_id` for `show`, `apply`, and `discard`; remove successful and discarded proposals.
- [ ] Run `pnpm test` and inspect `git diff`.

Core input contract:

```ts
export interface CreateProposalInput {
  kind: 'mcp-activate' | 'mcp-deactivate' | 'lsp-refactor' | 'lsp-recovery'
  title: string
  summary: string
  effects: ProposalEffect[]
  commit(exec: ToolRunContext): Promise<ProposalCommitResult>
}
```

### Task 2: Lazy MCP catalog and activation lifecycle

**Files:**

- Create: `packages/mcp-control/package.json`
- Create: `packages/mcp-control/src/index.ts`
- Create: `tests/mcp-control.test.mjs`

**Interfaces:**

- Produces `Context.mcpControl: McpControlRuntime`.
- Consumes `ctx.proposals`, `ctx.tools`, `ctx.commands`, and upstream `McpClient`.
- Produces `configure(agent, { workspace, servers })`.
- Registers `mcp_control` actions `list`, `search`, `prepare_activate`, and `prepare_deactivate`.

- [ ] Define inert `McpServerDefinition`: raw command/args/env or URL/headers, source, workspace, and trust status.
- [ ] Implement stable SHA-256 fingerprints over canonical raw definitions without exposing values in tool results.
- [ ] Implement activation-time `${env:NAME}` and `${NAME}` expansion.
- [ ] Implement redacted server views: no env/header values and no URL userinfo or query.
- [ ] Implement per-agent catalog and active-fiber maps; mount `McpClient` through `agent.ctx.plugin()` only inside an approved proposal commit.
- [ ] Set `failOnStartupError: true`, await the fiber, cache registered `mcp__<namespace>__*` schema metadata, and dispose failed fibers.
- [ ] Implement approved deactivation with `fiber.dispose()`.
- [ ] Persist only fingerprinted tool names/descriptions to `$DSH_HOME/omd/mcp-cache.json` using atomic rename.
- [ ] Implement deterministic token search over server names plus cached tool metadata.
- [ ] Write tests for redaction, deferred expansion, fingerprints, search ranking, and cache invalidation.
- [ ] Run `pnpm test` and inspect `git diff`.

### Task 3: Discovery becomes inert and session-scoped

**Files:**

- Modify: `packages/discovery/src/index.ts`
- Modify: `tests/discovery.test.mjs`

**Interfaces:**

- Consumes `ctx.mcpControl.configure()`.
- Stops mounting imported MCP servers directly.
- Preserves skills, instructions, commands, hooks, and trust behavior.

- [ ] Remove environment expansion from `normalizeServer`; preserve placeholders as raw strings.
- [ ] Remove global and project `mountMcp()` calls.
- [ ] During agent setup, merge user definitions with trusted project definitions, label source/scope, and call `agentCtx.mcpControl.configure()`.
- [ ] Keep untrusted project definitions outside the catalog while retaining the existing warning.
- [ ] Update discovery tests to prove secrets remain placeholders before activation and untrusted project definitions are excluded.
- [ ] Run `pnpm test` and inspect `git diff`.

### Task 4: Pure semantic edit planner

**Files:**

- Create: `packages/refactor/package.json`
- Create: `packages/refactor/src/workspace-edit.ts`
- Create: `tests/refactor.test.mjs`

**Interfaces:**

- Produces `normalizeWorkspaceEdit(raw): NormalizedDocumentEdit[]`.
- Produces `applyTextEdits(content, edits, encoding): string`.
- Produces `validateEditPlan(files): void`.

- [ ] Parse `WorkspaceEdit.changes` and text-only `documentChanges`.
- [ ] Reject create, rename, delete, command, non-file URI, duplicate document version, malformed range, and overlapping edit operations.
- [ ] Implement UTF-8, UTF-16, and UTF-32 LSP position conversion with CRLF-normalized text.
- [ ] Sort edits from the end of each file before applying.
- [ ] Write tests covering multi-file rename, Unicode offsets, overlapping edits, malformed responses, and unsupported resource operations.
- [ ] Run the focused refactor tests and inspect `git diff`.

### Task 5: Refactor provider, proposal, and recovery journal

**Files:**

- Create: `packages/refactor/src/index.ts`
- Create: `packages/refactor/src/lsp-client.ts`
- Create: `packages/refactor/src/journal.ts`
- Modify: `packages/lsp-auto/src/index.ts`
- Modify: `tests/lsp-auto.test.mjs`
- Extend: `tests/refactor.test.mjs`

**Interfaces:**

- Produces `Context.refactors: RefactorRuntime`.
- Produces `registerServer(id, config): disposer`.
- Registers `semantic_refactor` actions `prepare_rename`, `list_recovery`, and `prepare_recovery`.
- Consumes the same `ServerConfig` table that `lsp-auto` gives upstream read-only LSP.

- [ ] Register every discovered LSP server with both upstream `LspStdio` and `ctx.refactors`.
- [ ] Implement one-shot public `LspConnection` initialization, `didOpen`, `textDocument/rename`, shutdown, and bounded termination.
- [ ] Advertise text-only workspace edit capabilities and reject inbound `workspace/applyEdit`.
- [ ] Resolve every returned file through `ctx.fs`, require containment under the session workspace, read text plus `FsVersion`, and build exact proposal effects.
- [ ] On approved apply, preflight every version, write a `0600` journal, then publish writes sequentially with `replaceIfVersion`.
- [ ] On failure, roll back already-written files with their post-write versions; retain the journal only if rollback cannot complete.
- [ ] Implement recovery proposals that restore originals only when current content matches the journal's applied content.
- [ ] After success, run pull diagnostics when supported and return verification status without failing a completed refactor when diagnostics are unavailable.
- [ ] Write tests for journal permissions, apply success, stale preflight, rollback, and recovery refusal after unrelated edits.
- [ ] Run `pnpm test` and inspect `git diff`.

### Task 6: Distribution wiring, documentation, and verification

**Files:**

- Modify: `bundles/omd.cordis.yml`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `src/index.ts` only if the release version is intentionally changed

**Interfaces:**

- Exports `oh-my-dsh/proposals`, `oh-my-dsh/mcp-control`, and `oh-my-dsh/refactor`.
- Loads services before discovery and LSP auto-registration.

- [ ] Add package exports and publish files through the existing `dist` inclusion.
- [ ] Add bundle rows in order: proposals → MCP control → refactor → LSP auto → discovery.
- [ ] Document lazy MCP commands, activation approval, semantic rename preview/apply, recovery, limitations, and security boundaries.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `npm pack --dry-run` and verify all three plugin outputs and package manifests are included.
- [ ] Run `./bin/omd config` and verify all new rows resolve.
- [ ] Run `git diff --check` and review the complete diff without committing.
