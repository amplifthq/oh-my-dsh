# Contributing

English is the default for issues and pull requests. 中文也可以。

`oh-my-dsh` is an overlay, not a fork. Changes belong here when they are a curated default, a host-side guard, or a capability upstream does not ship. Do not patch `@deepseek-ai/dsh*` in `node_modules`.

## Setup

Requires Node.js `^22.19.0` or `>=24.0.0`, and pnpm.

```sh
pnpm install
pnpm format:check
pnpm typecheck
pnpm test
```

Commits run Prettier on staged files, then typecheck and tests. `pnpm format` rewrites the tree.

`pnpm test` builds, then runs `tests/*.test.mjs`.

## Pull requests

Open a PR against `main`. CI must stay green (typecheck and tests on Node 22 and 24).

Keep the change one concern. Match the surrounding style. Update both `README.md` and `README.zh.md` when the change is user-facing.

Do not bump the package version in a feature PR. Releases are a separate step.

Upstream `@deepseek-ai/dsh*` packages are pinned to the same release. Bump them together, never one at a time.

## Branch rules

`main` rejects force-pushes and deletion. Collaborators merge through pull requests. Repository admins may push directly for small, already-verified fixes.
