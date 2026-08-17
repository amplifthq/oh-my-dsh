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

## Releases

1. Move the release's changes into a dated version section in `CHANGELOG.md`.
2. Bump the version in `package.json` and `src/index.ts` — they must match; the release workflow verifies both against the tag.
3. Commit, tag `vX.Y.Z`, and push the tag. The Release workflow re-runs every check and publishes to npm with provenance. It requires the `NPM_TOKEN` repository secret (a granular npm automation token).

## Branch rules

`main` rejects force-pushes and deletion. Collaborators merge through pull requests. Repository admins may push directly for small, already-verified fixes.
