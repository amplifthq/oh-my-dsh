# Security

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/amplifthq/oh-my-dsh/security/advisories/new). Do not open a public issue or pull request for an unfixed security problem.

## Supported versions

Only the latest `0.1.x` release receives security fixes.

## What OMD guards, and how it is verified

This distribution adds host-side guards on top of DeepSeek Harness. Each guard ships with adversarial tests under [`tests/`](tests/); a report that bypasses one of them is especially useful.

- **Web fetch (SSRF).** Private, loopback, link-local, CGNAT, and cloud-metadata destinations are rejected at URL validation and re-validated at every DNS resolution. Tested adversarially: decimal, hex, octal, and shorthand IPv4 literals; IPv4-mapped and NAT64 IPv6 forms; trailing-dot hostnames; credential-bearing redirect hops; cross-origin redirects; DNS rebinding; and mixed public/private resolutions (rejected outright, never retried on the public address).
- **Proposal approval.** `proposal_control apply` always returns an `ask` decision to the upstream approval service; proposal visibility is never authorization. Tested: cross-agent access to a foreign proposal id, concurrent double-apply committing exactly once, apply after discard, and failed proposals staying terminal.
- **Refactor transactions.** Multi-file edits are version-guarded and journaled with mode `0600`. Tested: stale-version preflight, rollback after a mid-apply failure, incomplete rollback preserving a `rollback-needed` journal, tampered-journal rejection, and recovery refusal after unrelated edits.
- **MCP capability plane.** Imported server definitions stay inert — no process start, no environment expansion, no schema injection — until an approved activation. Tested: credential redaction in server views, deferred placeholder expansion, and fingerprint invalidation of cached metadata.
- **Plugin capability plane.** Curated plugin modules are not imported by listing, inspection, or proposal preparation. An approved load rechecks the installed package against an exact version pin, verifies its exported `name`/`provide`/`inject` manifest against the reviewed index, and mounts it only on the requesting agent context. Unload and agent teardown await the Cordis fiber's reverse-order disposal chain. Tested with real Cordis fibers: zero imports before apply, version and manifest drift rejected before mount, failed startup cleanup, duplicate-load exclusion, session-owner cleanup, and observed reversal of both a provided service and a labeled effect.

## Boundaries, not vulnerabilities

- An approved plugin runs inside the harness process with the host user's full environment, filesystem, and network access. This is a stronger grant than MCP activation. OMD's defenses are curation, exact pins, manifest verification, explicit approval, and session scoping; Cordis does not sandbox a mounted plugin.
- Persistent kernels execute as your host user after approval; they are not a sandbox.
- An approved DAP session evaluates expressions inside the debuggee process; the approval text states this capability.
- `OMD_WEB_FETCH_ALLOW_PRIVATE=1` and `DSH_WEB_FETCH_PROVIDER=http` intentionally remove the fetch guard.
- Recovery journals make interrupted refactors recoverable; they do not claim filesystem-wide crash atomicity.

We will acknowledge a valid report and work on a fix before any public disclosure.
