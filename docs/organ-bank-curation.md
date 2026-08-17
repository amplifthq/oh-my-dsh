# Organ bank curation

The OMD organ bank is a reviewed allowlist for plugins that an agent may propose mounting inside its own session. It is not an npm search index. Every accepted entry becomes eligible for an in-process privilege grant, so a small bank with explicit evidence is preferable to broad coverage.

The machine-readable index is [`presets/plugins.json`](../presets/plugins.json).

## Admission requirements

An organ is eligible only when all of the following are true:

1. **Useful and composable.** It adds a bounded capability and can be mounted on `agent.ctx` without replacing or conflicting with a bundle-managed service.
2. **Exact version.** `version` is one semver value, never a range. The package is a direct OMD dependency so Node resolves the same reviewed artifact in development and installed profiles.
3. **Provenance.** The package comes from a known repository and publisher. Record the source (`upstream` or `oh-my-dsh`) and verify the npm package metadata against that repository.
4. **Side-effect-free import.** Static inspection of the published entrypoint finds no process, network, filesystem mutation, global listener, timer, credential read, or service registration at module top level. Such work belongs in the Cordis `apply` body so approval precedes it and disposal can reverse it.
5. **Reviewed manifest.** The exported plugin `name`, `provide`, and `inject` values are copied into the index. Commit re-verifies all three before calling `ctx.plugin()`.
6. **Explicit risk.** `risk` states what model-visible behavior or host capability activation can change. The generic full-process privilege warning is added separately to every load proposal.
7. **Reversible effects.** Every resource created by `apply` is owned by Cordis effects or services and is released by `fiber.dispose()`. If reversal cannot be demonstrated, the package is not admitted.
8. **Safe defaults.** `config` is the minimal reviewed configuration. Overrides are shown exactly in the proposal and revalidated by the plugin's `Config` schema at mount.

## Review checklist

- [ ] Pin the dependency exactly in `package.json` and the lockfile.
- [ ] Inspect the published `package.json`, entrypoint, types, and source map/source when available.
- [ ] Confirm the package is not already active in `@deepseek-ai/dsh-base`, a mode bundle, or `bundles/omd.cordis.yml`.
- [ ] Record and compare `name`, `provide`, and `inject`.
- [ ] Search the module top level for I/O, process mutation, timers, listeners, and eager singleton construction.
- [ ] Enumerate every effect produced after mount and show how disposal reverses it.
- [ ] Add a test proving no importer call occurs before proposal apply.
- [ ] Add tests for version drift, manifest drift, startup failure cleanup, duplicate loads, unload, and owner teardown.
- [ ] Run the package, full suite, pack, profile configuration, and installed-profile load/unload smoke checks.

## Current bank

`dsh-skill-badge` at `0.1.0-rc.6` is the first organ. Its module top level builds immutable provider metadata and file URLs; it reads the bundled Markdown only when the skill is requested. `apply` registers one provider on the existing `skills` service, and Cordis removes that registration on disposal.

The initial design considered `dsh-attachment`, `dsh-timeout`, and `dsh-code-runtime`. They were not admitted: attachment is already backed by `dsh-attachment-local` in the base bundle, timeout is a utility library rather than a Cordis plugin, and code-runtime is an abstract service seam rather than a concrete organ.

Forged plugins (`plugin_forge`) are session artifacts, not catalog entries: they live under the forged-plugin roots, are identified by source digest instead of a package pin, and never appear in `presets/plugins.json`. Promoting a forged plugin into this catalog is a phase-3 human process — a pull request with the full source, digest history, and review evidence — and the runtime never writes the catalog.

## Later phases

### Phase 2: human-run installation

`omd plugin install <id>` may install the index's exact pin into a profile after showing provenance and risk. It remains a human CLI operation: `plugin_control` will never accept package names or run a package manager. Session mount still requires a separate proposal and approval.

### Phase 3: community submissions

Community entries require a pull request that supplies the checklist evidence, package provenance, automated import-safety checks where practical, and a maintainer review. Signing or attestations may strengthen provenance, but they do not replace source review: a correctly signed in-process plugin can still be unsafe.
