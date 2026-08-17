# OMD portable distribution design

**Date:** 2026-08-17  
**Target release:** 0.2.0  
**Status:** Proposed

## Decision

oh-my-dsh is the curated, secure, self-evolving distribution of DeepSeek
Harness. DeepSeek Harness supplies the kernel; OMD owns the tested
composition, safe defaults, curated capabilities, compatibility policy, and
delivery experience.

The distribution remains an overlay, not a fork. “Distribution” describes the
product and its release responsibility; “overlay” describes how it composes
with upstream.

Version 0.2.0 will add self-contained portable releases for macOS arm64 and
Linux x64. A user-level installer will install, update, and roll back those
releases without requiring a system Node.js or npm. The existing npm package
remains a first-class developer and composition channel. Both channels are
built from the same tag and describe the same OMD release.

## Product model

An installed OMD system has two layers:

1. **Immutable trusted base.** An exact Node.js runtime, exact DeepSeek Harness
   packages, OMD code, first-party defaults, and bundled curated plugins.
2. **Mutable user growth layer.** User configuration, sessions, skills, forged
   plugins, local patches, trust decisions, and current session activation.

The OMD version identifies the immutable base, not the complete running agent.
Diagnostics identify a running installation with:

- OMD distribution version;
- upstream DeepSeek Harness version;
- the artifact digest the installer verified and recorded at install time;
- active profile;
- user-layer location; and
- current plugin/skill activation when the harness exposes it.

This preserves reproducible releases without treating a self-evolving harness
as a permanently fixed application.

## Goals

- Install and run OMD without preinstalled Node.js, npm, pnpm, or root access.
- Keep the current Cordis composition and upstream escape hatches intact.
- Produce one tested release across npm and portable channels.
- Make updates atomic and retain a working local rollback target.
- Keep all user-owned state outside the installed version directory.
- Guarantee that core capabilities and bundled plugins need no package
  download after installation.
- Publish enough machine-readable evidence to audit the exact runtime.

## Non-goals for 0.2.0

- Forking or patching DeepSeek Harness.
- A single-file executable.
- Native `.pkg`, `.dmg`, `.deb`, `.rpm`, or GUI installers.
- Windows, macOS x64, Linux arm64, or musl/Alpine artifacts.
- Background or mandatory automatic updates.
- Bundling Python, Chromium, browser-use, or every curated MCP server.
- Installing arbitrary community plugins through the runtime package manager.
- Destructive migration of user data.

## Supported channels

### Portable distribution

This is the zero-prerequisite channel for end users. GitHub Releases publishes:

- `oh-my-dsh-v<VERSION>-darwin-arm64.tar.gz`
- `oh-my-dsh-v<VERSION>-linux-x64.tar.gz`
- `release-manifest.json`
- `SHA256SUMS`
- one SPDX JSON SBOM per platform artifact
- the user-level `install.sh` bootstrap

The supported operating-system floor is the floor supported by the exact
official Node.js runtime embedded in that artifact. Linux x64 targets glibc;
musl is explicitly unsupported in 0.2.0.

### npm

The `oh-my-dsh` npm package continues to support global installation, `npx`,
source development, custom profiles, and downstream composition. It retains
the existing Node.js engine requirement because npm users provide their own
runtime.

The npm package and portable artifacts always use the same OMD version. There
is no separate “distribution version.” A release is incomplete until both npm
and every required portable artifact have passed their checks.

## Portable artifact layout

Each archive expands to one versioned directory:

```text
oh-my-dsh-v<VERSION>/
  bin/
    omd
  runtime/
    bin/node
    LICENSE
  app/
    package.json
    bin/omd
    dist/
    bundles/
    presets/
    node_modules/
  distribution.json
  distribution-files.json
  sbom.spdx.json
  LICENSE
  THIRD_PARTY_NOTICES
```

`bin/omd` is a small POSIX launcher. It resolves its own archive root and
executes `app/bin/omd` with `runtime/bin/node` by absolute path. It never
searches `PATH` for Node.js.

`app/node_modules` is a production-only dependency closure materialized from
the committed pnpm lockfile with a hoisted (flat) layout. Hoisting is a
requirement, not an optimization: the upstream bundle packages
`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, and
`@deepseek-ai/dsh-headless` are transitive dependencies of `@deepseek-ai/dsh`
rather than direct OMD dependencies, and dsh resolves them from the profile by
bare specifier, so they must be present at the top level of the closure. The
build also adds one internal link, `app/node_modules/oh-my-dsh` pointing at
`app/` itself, so profiles resolve the overlay package the same way. The
closure covers both the `omd` and `omd-headless` profiles, including bundled
optional plugins. It contains no package manager and performs no runtime
dependency installation.

`distribution.json` is embedded, immutable build identity. It records:

- schema version;
- OMD version;
- Git commit and tag;
- platform tuple;
- exact Node.js version;
- exact upstream DeepSeek Harness version;
- lockfile digest;
- build timestamp; and
- the relative SBOM path.

`distribution-files.json` records the SHA-256 digest of every other file in
the version directory. It is generated at build time and backs the optional
integrity check in `omd doctor`.

The external `release-manifest.json` records every artifact filename, byte
size, SHA-256 digest, platform tuple, and matching embedded build identity.
The archive cannot contain its own final archive digest, so embedded identity
and external artifact integrity are separate documents.

## Runtime and profile composition

Portable mode is detected from the embedded `distribution.json`, not from an
ambient environment variable supplied by the user.

The portable dependency closure is built once and shared by the interactive
and headless profiles. `omd setup` in portable mode:

1. creates the user profile directories under `DSH_HOME`;
2. writes profile metadata for the same bundle order used by npm mode;
3. replaces each profile’s `node_modules` with a single symlink to
   `<install root>/current/app/node_modules`;
4. creates a user `cordis.patch.yml` only when none exists; and
5. performs no network request or package-manager invocation.

That one symlink is sufficient because the closure is hoisted and contains the
`oh-my-dsh` self-link: every bundle row, profile plugin dependency, and the
overlay itself resolve by bare specifier from the profile directory. Because
the link points through `current`, update and rollback do not require
re-running setup.

The launcher always selects the profile from the version referenced by the
installer’s `current` link. Node resolves that link to the concrete version
directory at startup, so a process that was already running continues with
its loaded version; the next invocation sees the newly selected version.

A `DSH_HOME` may serve both channels, but a profile runtime is owned by one
channel at a time: portable setup replaces an npm-materialized `node_modules`
directory with the version link, and npm-mode setup re-materializes it with
npm. Both operations are idempotent, and neither touches the user’s
`cordis.patch.yml`.

The existing npm mode keeps its current behavior: it materializes isolated
profiles with npm because npm users chose a package-manager-based channel.
Composition order and user override precedence remain identical in both
channels:

```text
@deepseek-ai/dsh-base
→ @deepseek-ai/dsh-web-app or @deepseek-ai/dsh-headless
→ oh-my-dsh
→ profile/cordis.patch.yml
→ $DSH_HOME/cordis.patch.yml
```

## Capability inclusion contract

The README and diagnostics classify capabilities into four explicit tiers.

### Core

Code ships in the artifact and is enabled by the default OMD composition.
This includes the selected upstream web/headless runtime, OMD first-party
plugins, proposal controls, hardened web fetch, and bundled language tooling.

### Bundled optional

Code ships in `app/node_modules` but is inert until explicitly activated
through OMD’s approval path. The curated plugin catalog entries
`dsh-skill-badge` and `dsh-pkg-info` are bundled optional capabilities in the
first portable release.

### Curated integrations

OMD ships reviewed metadata, setup guidance, or skills, but the external
runtime is not in the portable base. browser-use CLI, Playwright MCP, Context7,
and other external MCP servers belong here unless separately bundled in a
future release. Documentation must state their prerequisites and network
behavior rather than calling them built in.

### User growth

User skills, Plugin Forge output, local MCP definitions, and user-installed
extensions live outside the immutable base. Updating or rolling back OMD never
deletes or overwrites them.

## Installation layout

The default user-level layout is:

```text
~/.local/share/oh-my-dsh/
  versions/
    <VERSION>/
  current -> versions/<VERSION>
  previous -> versions/<PREVIOUS_VERSION>
  install-state.json
  update.lock

~/.local/bin/
  omd -> ../share/oh-my-dsh/current/bin/omd

~/.dsh/
  profiles/
  sessions/
  forged-plugins/
  ...
```

`OMD_INSTALL_ROOT` and `DSH_HOME` remain explicit overrides. The default
installer never uses `sudo` and never edits shell startup files. When
`~/.local/bin` is not on `PATH`, it prints the exact export command suitable
for the current shell.

Installed versions are immutable inputs. The installer owns only the install
root and the `~/.local/bin/omd` link. OMD runtime state belongs under
`DSH_HOME`.

## Installer behavior

The documented convenience command is:

```sh
curl -fsSL https://github.com/amplifthq/oh-my-dsh/releases/latest/download/install.sh | sh
```

Documentation also provides a download-inspect-run form and a tag-pinned URL.
The convenience command treats GitHub, TLS, and repository release permissions
as its bootstrap trust root. SHA-256 verification protects artifact integrity
after that bootstrap; it does not independently authenticate a compromised
GitHub release. GitHub build provenance is published for independent audit.

This bootstrap replaces the repository’s existing `install.sh`, which today
wraps `npm install --global`. Exactly one script carries that name: the
portable bootstrap, versioned in the repository and uploaded as a release
asset from the same tag. npm-channel users follow the documented npm commands
directly and no longer go through an installer script, so `install.sh` also
leaves the npm package’s `files` list.

The bootstrap:

1. normalizes the host to a supported platform tuple;
2. obtains the release manifest of the latest non-prerelease release — the
   stable channel — from the fixed OMD repository;
3. derives the artifact name locally and rejects manifest URLs or paths outside
   the expected release namespace;
4. downloads the archive into a private staging directory;
5. verifies its SHA-256 digest and validates archive paths before extraction;
6. extracts into a new version directory on the same filesystem as `current`;
7. runs the packaged health check with a fresh temporary `HOME`, `DSH_HOME`,
   and a `PATH` that contains neither system Node.js nor npm;
8. records the old selection as `previous`, then atomically replaces `current`;
9. stores the verified artifact digest and its manifest entry in
   `install-state.json`;
10. installs the stable user-level command link; and
11. retains the previous version for rollback.

Unsupported platforms fail before creating an install root. An existing
installation remains selected until every staging check succeeds.

Known macOS limitation: the 0.2.0 archives are not code-signed or notarized.
`curl` does not set the quarantine attribute, so the documented bootstrap
works, but an archive downloaded with a browser and extracted manually may be
blocked by Gatekeeper. The documentation states this and shows the `xattr`
command that clears the attribute; native signing is a future-release
decision.

## Update and rollback

### `omd update`

Portable mode adds a foreground, user-requested update command. It:

- checks only the stable channel;
- reports the current and candidate versions;
- returns successfully without mutation when already current;
- acquires an exclusive install lock;
- follows the same download, verification, extraction, and health-check path
  as first installation;
- switches `current` only after validation; and
- prints the local rollback command.

It never updates an already-running process and never updates in the
background. npm mode tells the user to update through npm rather than
self-modifying a package-manager-owned installation.

### `omd rollback`

Rollback switches `current` to the retained `previous` version after checking
that its embedded distribution identity is valid. The version being replaced
becomes the new rollback target, so rollback can be reversed. It performs no
network access and does not modify `DSH_HOME`.

### Version retention

The current and previous versions are always retained. Older unreferenced
versions may be removed only after a successful switch. Failed staging
directories are cleaned on the next installer invocation.

### User-data compatibility

OMD 0.2.x must not perform destructive or one-way migration of `DSH_HOME`.
New fields and directories are additive. If a future release requires an
incompatible migration, that release must introduce a separate backup,
compatibility, and rollback design before implementation.

## Concurrency and interruption

Install, update, and rollback serialize through an atomic lock in the install
root. The lock records the owning process and start time. A live lock causes a
clear failure; a stale lock can be removed only after verifying that its owner
is no longer running.

All downloads and extraction happen in uniquely named staging paths. Signal or
process interruption may leave staging data, but cannot move `current`.
Before changing selection links, the manager atomically writes a transaction
record — a field of `install-state.json` — containing the operation, old
`current`, old `previous`, and candidate version. Each symlink replacement and
state-file replacement uses same-filesystem atomic rename. On the next
invocation, an open transaction is reconciled from the actual link states:

- `current` and `previous` both still name their old versions: the operation
  never took effect; clear the transaction.
- `previous` was rewritten but `current` still names the old version: both
  links name complete versions; restore `previous` from the record and clear
  the transaction.
- `current` names the candidate: the switch happened; complete the remaining
  metadata (including a rollback’s reverse pointer) and clear the transaction.

`current` therefore always names either the complete old version or the
complete new version, never a partial tree.

## Security model

### Guarantees

- Exact direct dependencies and the complete transitive closure come from the
  committed lockfile.
- The build downloads an exact official Node.js archive and verifies it
  against Node.js’s published checksum before extracting the runtime.
- Runtime setup never executes a package manager.
- Artifact hashes are verified before extraction.
- Archive entries with absolute paths, parent traversal, or escaping symlink
  targets are rejected.
- Portable profile links cannot resolve outside the selected version and
  declared user-state roots.
- Every release publishes an SPDX JSON SBOM and GitHub build provenance.
- Plugin activation remains proposal-gated; bundling does not imply activation.

### Trust boundaries

- The installer trusts the OMD GitHub repository, its release permissions, and
  HTTPS bootstrap.
- OMD trusts the reviewed upstream and community artifacts recorded in its
  lockfile and catalog provenance.
- External integrations are outside the self-contained guarantee and keep
  their existing approval, prerequisite, and network boundaries.
- Changing install-root files changes the trusted base. `omd doctor` checks
  distribution identity on every run; on explicit request it re-hashes the
  selected version against `distribution-files.json` and reports any mismatch.

### Runtime patching

The portable artifact never patches upstream files or `node_modules`. OMD’s
changes remain visible Cordis bundle rows. The user’s patch file retains final
composition precedence.

## Failure semantics

- **Unsupported platform:** fail before download or filesystem mutation.
- **Network or manifest failure:** preserve `current`; leave no selected
  partial version.
- **Checksum or archive validation failure:** delete staging data, preserve
  `current`, and report the failed verification.
- **Disk-full or extraction failure:** preserve `current`; report the staging
  path if cleanup also fails.
- **Health-check failure:** retain the candidate for diagnostics only when the
  user explicitly asks; otherwise remove it and preserve `current`.
- **Atomic-switch failure:** preserve the selected version and use the
  transaction record to restore the prior rollback metadata.
- **Corrupt current installation:** `omd doctor` identifies the broken
  distribution identity or file-manifest mismatch and offers local rollback
  when `previous` is valid.
- **No rollback target:** fail without mutation and say that no retained
  version exists.

Errors must distinguish program installation from user data. No recovery path
may suggest deleting `~/.dsh` as a routine fix.

## Release pipeline

A `v*` tag drives one coordinated release:

1. Validate formatting, types, unit tests, real profile smoke tests, tag/version
   equality, and a frozen lockfile.
2. On native macOS arm64 and Linux x64 runners, check out the tag and
   materialize the hoisted production closure directly from the workspace and
   its frozen pnpm lockfile (`pnpm deploy` or equivalent). The npm tarball is
   never the input to the portable payload: installing a packed tarball does
   not consume the pnpm lockfile, so its transitive closure would be
   unverified.
3. Build the npm tarball from the same tagged checkout and check that its file
   list matches the `app/` payload (excluding `node_modules` and generated
   identity files), so both channels provably ship the same reviewed code.
4. Download and verify the exact platform Node.js runtime.
5. Generate embedded distribution identity, the file-digest manifest,
   third-party notices, and the platform SBOM.
6. Build each archive and run artifact-level tests after extraction.
7. Upload matrix outputs to a final release job.
8. Generate `SHA256SUMS` and the external release manifest from the tested
   bytes.
9. Publish build provenance for the archives and manifest.
10. Publish npm only after every required platform artifact passes.
11. Create or update the GitHub Release with all portable artifacts and notes.

Publishing is retry-safe. npm publication may be skipped when the exact version
already exists, and GitHub assets are compared before retry rather than
silently replaced with different bytes.

## Verification strategy

### Pure tests

- platform normalization and unsupported-platform rejection;
- release-manifest parsing and fixed repository/path enforcement;
- distribution identity parsing;
- file-digest manifest generation and verification;
- version comparison and stable-channel selection;
- install-state transitions;
- lock acquisition and stale-lock handling;
- archive-entry path and symlink validation;
- current/previous transition planning; and
- bundled-versus-npm mode detection.

### Filesystem integration tests

- first install into an empty temporary root;
- reinstalling the same version is idempotent;
- update creates a new version and preserves user files;
- rollback switches versions without network access;
- interrupted staging never changes `current`;
- checksum mismatch, malformed manifest, extraction failure, and failed health
  check all preserve the selected version;
- concurrent update attempts serialize;
- stale staging cleanup does not remove current or previous;
- portable setup adopts an npm-materialized profile runtime and npm-mode setup
  re-materializes it, in both directions; and
- custom `OMD_INSTALL_ROOT` and `DSH_HOME` remain isolated.

### Artifact smoke tests

Each platform runner tests the final compressed bytes by:

1. starting with fresh `HOME` and `DSH_HOME`;
2. removing system Node.js, npm, and pnpm from the child `PATH`;
3. installing through the same bootstrap path used by users;
4. running `omd --version`, `omd doctor`, and `omd config`;
5. starting both interactive and headless profiles far enough to prove
   bare-specifier resolution of every bundle row — including the transitive
   upstream bundle packages — and composition;
6. loading and unloading each bundled curated plugin through the real proposal
   and Cordis effect chain;
7. updating from the previous fixture release;
8. rolling back and proving the previous version starts; and
9. checking that user configuration and forged-plugin fixtures survive both
   transitions.

Network-dependent model calls and curated external integrations are not part of
the portable artifact gate.

## Documentation changes

The README quick start leads with the portable installer, followed by manual
archive verification and npm installation. The architecture statement remains
“Overlay, not a fork.”

Installation documentation also covers manual uninstall — remove the install
root and the `~/.local/bin/omd` link; `~/.dsh` belongs to the user and is
never removed by tooling — and the macOS Gatekeeper note for
browser-downloaded archives.

The capability list labels every item as core, bundled optional, curated
integration, or user growth. Features with external prerequisites cannot use
“included” or “works out of the box.”

Release notes include:

- OMD and upstream versions;
- embedded Node.js version;
- supported platform tuples;
- artifact checksums and provenance links;
- capability additions or removals;
- known external prerequisites; and
- rollback compatibility.

## Rollout

0.2.0 is the first portable-distribution release and carries the currently
unreleased curated-catalog expansion. It is a minor-version milestone because
OMD begins accepting responsibility for a complete runtime, platform
artifacts, installation, updates, and rollback.

The npm path remains supported throughout rollout. Portable releases become
the README’s recommended path only after both platform artifact smoke tests
pass in the tagged release workflow.

Additional platforms, native installers, background updates, and bundled
browser runtimes require usage evidence and separate designs.

## Acceptance criteria

The design is realized when:

- a user on supported hardware can install and start OMD without system
  Node.js or npm;
- both profiles and every bundled optional plugin resolve entirely from the
  selected immutable version;
- the same tag publishes matching npm and portable identities;
- update failure cannot replace a working installation;
- local rollback restores the previous program without changing user data;
- release artifacts include checksums, SBOMs, and provenance;
- `omd doctor` distinguishes distribution identity from mutable user state;
  and
- documentation does not describe externally provisioned integrations as
  bundled capabilities.
