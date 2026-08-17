# Why an overlay, not a fork

`oh-my-dsh` describes itself as "a curated distribution of DeepSeek Harness. Overlay, not a fork." This document explains what that means technically, why we hold the line, and what it implies for contributions.

## What the overlay is

DeepSeek Harness (dsh) is built on Cordis: everything — tools, filesystem, approvals, the web UI — is a plugin in a composition. A distribution therefore does not need to fork anything to change almost everything. `oh-my-dsh` is a formal dsh bundle whose composition order is:

```text
@deepseek-ai/dsh-base
→ @deepseek-ai/dsh-web-app or @deepseek-ai/dsh-headless
→ oh-my-dsh
→ profile/cordis.patch.yml
→ $DSH_HOME/cordis.patch.yml
```

Every OMD opinion — safe-by-default web fetch, the proposal/approval plane, lazy MCP, semantic refactors, notifications — is a plugin row that you can override or remove in your own patch file. The last word always belongs to the user's `cordis.patch.yml`, not to us.

## Why not fork

A fork of a developer-preview harness buys you one thing: the freedom to change internal code. It costs you everything else:

- **Upstream velocity.** dsh is moving fast toward its stable release. A fork re-merges every upstream change forever; an overlay just re-verifies its seams (we keep an explicit [seam list](upstream-upgrade-playbook.md) and a weekly `dsh@next` canary).
- **Security fixes.** Upstream fixes flow to users on the next pin bump, not after a manual merge.
- **Trust.** You can read [`bundles/omd.cordis.yml`](../bundles/omd.cordis.yml) and know exactly what OMD changes. A fork's diff is unreviewable in practice.
- **User escape hatches.** Anything we choose, you can unchoose per profile. Forks make opinions mandatory.

## The discipline this imposes

The overlay rule is a constraint we accept on purpose:

- We never patch `node_modules` or ship modified upstream code.
- When a capability needs an upstream change, we extend the public seam in our own plugin first (the semantic-refactor client does this today) and propose the seam upstream (see the [LSP mutation seam draft](upstream-lsp-seam-proposal.md)) — then delete our private code when it lands.
- We deliberately do not rebuild what upstream already owns: the TUI, plan/goal/loop orchestration, peer messaging, provider routing, or the session engine. Cloning those would quietly turn the distribution into a maintenance fork with extra steps.

## When a fork would be right

Honesty requires the counterfactual: if upstream stopped maintaining dsh, or moved against the values this distribution exists for (approval-gated capability, inert-by-default integrations), a fork would become the correct call. Neither is true today, and the overlay keeps that option open — all of OMD's code already lives outside the upstream tree.

## What this means for contributions

Changes belong in `oh-my-dsh` when they are one of:

1. **A curated default** — a better out-of-box choice that upstream reasonably leaves neutral.
2. **A host-side guard** — protection the model cannot bypass (SSRF guard, proposal gate, journal recovery).
3. **A capability upstream does not ship** — built against public seams, with an upstream-first exit plan when it needs private ones.

If your idea re-implements upstream, take it upstream — we will happily pin the release that includes it.
