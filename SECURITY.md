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

## Boundaries, not vulnerabilities

- Persistent kernels execute as your host user after approval; they are not a sandbox.
- An approved DAP session evaluates expressions inside the debuggee process; the approval text states this capability.
- `OMD_WEB_FETCH_ALLOW_PRIVATE=1` and `DSH_WEB_FETCH_PROVIDER=http` intentionally remove the fetch guard.
- Recovery journals make interrupted refactors recoverable; they do not claim filesystem-wide crash atomicity.

We will acknowledge a valid report and work on a fix before any public disclosure.
