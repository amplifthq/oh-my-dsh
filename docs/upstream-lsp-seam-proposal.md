# Draft: a public LSP mutation seam for DeepSeek Harness

Status: draft, to be filed against [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). Tracked here so the argument and scope are agreed before it becomes an upstream issue/PR.

## Problem

rc.6 exposes exactly four read-only LSP operations (definitions, references, implementations, hover) and rejects `workspace/applyEdit`. Any distribution that wants semantic rename must fork or run a parallel LSP stack.

`oh-my-dsh` chose the parallel stack: [`packages/refactor/src/lsp-client.ts`](../packages/refactor/src/lsp-client.ts) opens a bounded one-shot connection per rename against the same server binaries `dsh-lsp` already manages. It works, and it stays inside upstream's security posture (text-only edits, no resource operations, no `executeCommand`). But it is the heaviest private seam in the overlay: a duplicate initialize/shutdown lifecycle, duplicate position-encoding negotiation, and language servers that see two clients for one workspace.

## Proposed public contracts

1. **Rename.** `textDocument/prepareRename` and `textDocument/rename` routed over the connections `dsh-lsp` already owns, returning a normalized, text-only `WorkspaceEdit`. Resource operations (create/rename/delete), server-driven `workspace/applyEdit`, and `workspace/executeCommand` remain rejected — the policy both projects already enforce, but stated and enforced in one place.
2. **Pull diagnostics.** `textDocument/diagnostic` exposure so a caller can verify a workspace after applying an edit.
3. **Version-guarded batch apply.** An `fs` operation that takes `(edits, observedVersions)` and fails before the first write when any file is stale, so multi-file apply does not need N racy single-file writes.

## Why upstream and not the overlay

- The rename seam requires access to the live server connections; a second client is architecturally worse for every downstream, not just this one.
- The safety policy (text-only edits) is upstream's own; today it exists twice and can drift.
- Every distribution that adds mutation without this seam will make the same duplicate-stack choice.

## What the overlay deletes when this lands

- The one-shot client (~270 lines) and its transient document lifecycle.
- Duplicated position-encoding conversion.
- One full server handshake per rename (user-visible latency).

`oh-my-dsh` keeps its product layer unchanged: proposal preview, single approval, recovery journal, and post-apply diagnostics reporting.

## Before filing

- [ ] Link the exact rc contracts this extends (`dsh-lsp`, `dsh-tool-lsp`, `dsh-fs` types).
- [ ] Attach a latency measurement: one-shot handshake vs. routed request on a warm server.
- [ ] Offer the `workspace-edit` normalizer (parsing, encoding conversion, overlap rejection, tests) as the starting implementation.
