# rc.8 file-reference seam

**Date:** 2026-08-20

**Status:** Approved

**Companion plan:** [`../plans/2026-08-20-rc8-file-reference-seam.md`](../plans/2026-08-20-rc8-file-reference-seam.md)

## Decision

DeepSeek Harness rc.8 owns ordinary file-reference discovery. A plain `@path` or `@"path with spaces"` remains ordinary prompt text; OMD does not attach its contents automatically. The model uses the effective `read` tool when it needs those contents.

OMD retains one explicit extension: `@path:start-end` and `@"path with spaces":start-end` attach that line range to the same model step. The snapshot remains workspace-confined, bounded, marked as untrusted data, and rendered as `line:hash|text` rows that can be passed directly to `hash_edit`.

Invalid ranges continue to parse as plain paths. They therefore use upstream read-on-demand semantics and do not trigger an OMD snapshot.

## Why

rc.8 replaces the discovery and composer-completion gap, but its file-reference package deliberately does not read or attach file contents. Removing OMD mentions entirely would also remove explicit line ranges, same-step snapshots, `ctx.fs` containment, headless behavior, and `hash_edit` anchors.

Automatically expanding every upstream-selected `@path` would create a conflicting contract: upstream tells the model to call `read`, while OMD silently injects the same file and may cause duplicate context. Requiring a range makes the expensive behavior explicit and preserves the capability that upstream does not provide.

## Runtime contract

1. `extractMentions()` and `mentionsInMessages()` continue to parse all supported references for compatibility.
2. A new snapshot selector keeps only mentions with a valid start and end line.
3. `MentionRuntime` resolves and attaches only the selector output.
4. Plain mentions do not consume `maxMentions` or `maxTotalBytes` because they are removed before resolution.
5. Only direct user-sourced text can trigger snapshots; plugin and assistant text remain ignored.
6. Existing range resolution, byte caps, workspace containment, binary handling, provenance, and `hash_edit` rendering remain unchanged.

## Prompt contract

The OMD prompt distinguishes the two forms:

- plain `@path`: path-only; use `read` when content is needed;
- explicit `@path:start-end`: the requested range is already attached as hash-anchored data.

The model should not re-read an attached range unless the snapshot reports truncation or it needs lines outside the requested range.

## Documentation contract

English and Chinese documentation and the changelog must describe upstream discovery separately from OMD range snapshots. Security claims must apply only to attached ranges, not to every plain `@file` token. The upstream-upgrade smoke must verify both ordinary file discovery/read behavior and one explicit range snapshot.

## Verification

- A failing regression test proves plain references are excluded while valid bare and quoted ranges remain eligible.
- The mentions test file passes after the minimal selector/runtime change.
- Build, typecheck, formatting check, and the full test suite pass.
- The final diff contains no dependency, bundle-order, editor, or upstream package changes.
