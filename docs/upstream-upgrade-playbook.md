# Upstream upgrade playbook

How to move the pinned `@deepseek-ai/dsh*` release without breaking the overlay. Upstream is in developer preview: assume every release may move a seam.

## Signals

- The [weekly canary](../.github/workflows/canary.yml) fails: the _next_ upstream release breaks the overlay. Fix ahead of time or file upstream — do not wait for users to hit it.
- Upstream publishes a new release and the canary is green: bump at the next convenient point.

## Rules

- Every `@deepseek-ai/dsh*` pin moves together, to the same exact version. Never one package at a time, never a range.
- An upgrade PR contains only the bump and whatever the bump forces. No feature changes.

## Procedure

1. Branch, then update every pin in `package.json` to the new exact version and run `pnpm install`.
2. `pnpm typecheck && pnpm test`.
3. Real-profile smoke, in a throwaway home:

   ```sh
   DSH_HOME=$(mktemp -d) node bin/omd setup
   DSH_HOME=<same dir> node bin/omd doctor
   DSH_HOME=<same dir> node bin/omd config > /dev/null
   ```

4. Manual pass in the Web UI: activate one MCP preset through a proposal, run one `semantic_refactor` rename end to end (preview → approve → diagnostics), one web fetch, select one ordinary `@file` reference and verify the model reads it on demand, submit one explicit `@file:start-end` range and verify its hash anchors arrive in the same step, `/usage`.
5. If a seam broke: prefer fixing the overlay; when the change looks unintentional, file a minimal reproduction upstream and link the canary run. Do not patch `node_modules`, do not fork.
6. Update the README compatibility table (both languages), add a CHANGELOG entry, and release per [CONTRIBUTING.md](../CONTRIBUTING.md).

## Seams to re-verify on every bump

| Upstream contract                                                      | Overlay consumers                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `tools/pre-execute` ask/deny middleware                                | proposals (apply gate), web-guard (shell fetch), debug                         |
| `tools/post-execute` waterfall (after a tool body settles)             | plugin-forge usage attribution                                                 |
| `WebFetchProvider` + `WebError` codes                                  | web-guard provider registration                                                |
| LSP `ServerConfig` + stdio transport                                   | lsp-auto; refactor's one-shot client dials the same servers                    |
| `ctx.fs` versioned reads and replace-if-version writes                 | editor (`hash_edit`), refactor apply/rollback                                  |
| `McpClient` plugin mount/dispose and tool namespace shape              | mcp-control activation lifecycle                                               |
| `ctx.plugin()` mount, `Fiber.await/dispose`, plugin `provide`/`inject` | plugin-control controller; plugin-forge mounts through it                      |
| `ctx.tools.schemas(scope)`, `ctx.skills.snapshot`, `ctx.commands.list` | capability-discovery unified catalog; plugin-forge mount-time tool attribution |
| `fileReferences.list`, mention grammar, and read-on-demand prompt      | upstream Web completion; OMD explicit-range snapshot selector and prompt       |
| `decodeStorageRecord` + session log layout (`.jsonl`, `.jsonl.zstd`)   | `omd usage`                                                                    |
| Approval service semantics (`ask` is never auto-granted)               | proposals, debug, danger-full-access behavior                                  |
| Bundle patch ordering, `--profile`, `--dump-config`                    | `bin/omd`, `bundles/omd.cordis.yml`                                            |
| System prompt sections and command registration                        | banner, discovery, mcp-control, capability-discovery                           |

If a bump silently changes one of these without a changelog entry, that is worth an upstream issue on its own.
