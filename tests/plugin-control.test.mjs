import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { load as parseYaml } from 'js-yaml'

import {
  organView,
  parseOrganIndex,
  resolveOrganAvailability,
} from '../dist/packages/plugin-control/src/catalog.js'
import { OrganController } from '../dist/packages/plugin-control/src/controller.js'
import {
  IN_PROCESS_PRIVILEGE_WARNING,
  organLoadCommit,
  organUnloadCommit,
  planOrganLoad,
  planOrganUnload,
  readBundledOrganIndex,
  registerOrganOwnerCleanup,
} from '../dist/packages/plugin-control/src/index.js'
import { ProposalStore } from '../dist/packages/proposals/src/index.js'
import * as fixtureOrgan from './fixtures/test-organ.mjs'

function entry(overrides = {}) {
  return {
    id: 'safe-organ',
    module: '@example/safe-organ',
    version: '1.2.3-rc.4',
    summary: 'A deliberately small fixture organ.',
    risk: 'Adds one model-visible fixture capability.',
    manifest: {
      name: 'safe-organ',
      provide: ['fixture'],
      inject: ['tools'],
    },
    config: { enabled: true },
    source: 'upstream',
    ...overrides,
  }
}

function communityProvenance(overrides = {}) {
  return {
    repository: 'https://github.com/example/safe-organ',
    publisher: 'example-publisher',
    integrity: `sha512-${'a'.repeat(86)}==`,
    commit: 'a'.repeat(40),
    ...overrides,
  }
}

async function fakePackage(version = '1.2.3-rc.4') {
  const directory = await mkdtemp(join(tmpdir(), 'omd-organ-package-'))
  const packageJsonPath = join(directory, 'package.json')
  await writeFile(packageJsonPath, `${JSON.stringify({ name: '@example/safe-organ', version })}\n`)
  return packageJsonPath
}

test('parseOrganIndex accepts a curated exact-pinned entry', () => {
  assert.deepEqual(parseOrganIndex(JSON.stringify([entry()])), [entry()])
  assert.deepEqual(parseOrganIndex([entry()]), [entry()])
  const community = entry({ source: 'community', provenance: communityProvenance() })
  assert.deepEqual(parseOrganIndex([community]), [community])
})

test('parseOrganIndex rejects malformed and unsafe entries', () => {
  const cases = [
    [[entry(), entry()], /duplicate/i],
    [[entry({ id: '../escape' })], /id/i],
    [[entry({ module: '../organ.js' })], /module/i],
    [[entry({ module: '/tmp/organ.js' })], /module/i],
    [[entry({ module: 'file:///tmp/organ.js' })], /module/i],
    [[entry({ module: 'https://example.com/organ.js' })], /module/i],
    [[entry({ version: '^1.2.3' })], /version/i],
    [[entry({ version: '1.2.x' })], /version/i],
    [[entry({ version: '1.2.3-01' })], /version/i],
    [[entry({ version: '*' })], /version/i],
    [[entry({ risk: '' })], /risk/i],
    [[entry({ manifest: { inject: [] } })], /provide/i],
    [[entry({ manifest: { provide: [] } })], /inject/i],
    [[entry({ manifest: { provide: 'fixture', inject: [] } })], /provide/i],
    [[entry({ source: 'third-party' })], /source/i],
    [[entry({ source: 'community' })], /provenance/i],
    [
      [entry({ source: 'community', provenance: communityProvenance({ repository: 'http://x' }) })],
      /HTTPS/i,
    ],
    [
      [entry({ source: 'community', provenance: communityProvenance({ integrity: 'sha256-x' }) })],
      /sha512/i,
    ],
    [
      [entry({ source: 'community', provenance: communityProvenance({ commit: 'ABC' }) })],
      /commit/i,
    ],
  ]
  for (const [value, expected] of cases) {
    assert.throws(() => parseOrganIndex(value), expected, JSON.stringify(value))
  }
})

test('resolveOrganAvailability reports available exact versions', async () => {
  const packageJsonPath = await fakePackage()
  const availability = resolveOrganAvailability(entry(), () => ({ packageJsonPath }))
  assert.deepEqual(availability, {
    status: 'available',
    installedVersion: '1.2.3-rc.4',
    packageJsonPath,
  })
})

test('resolveOrganAvailability distinguishes absence and version drift', async () => {
  assert.deepEqual(
    resolveOrganAvailability(entry(), () => undefined),
    {
      status: 'not-installed',
    },
  )
  const packageJsonPath = await fakePackage('1.2.4')
  assert.deepEqual(
    resolveOrganAvailability(entry(), () => ({ packageJsonPath })),
    {
      status: 'version-drift',
      expectedVersion: '1.2.3-rc.4',
      installedVersion: '1.2.4',
      packageJsonPath,
    },
  )
})

test('organView combines reviewed metadata, availability, and session state', async () => {
  const packageJsonPath = await fakePackage()
  const availability = resolveOrganAvailability(entry(), () => ({ packageJsonPath }))
  assert.deepEqual(organView(entry(), availability, true), {
    id: 'safe-organ',
    module: '@example/safe-organ',
    version: '1.2.3-rc.4',
    summary: 'A deliberately small fixture organ.',
    risk: 'Adds one model-visible fixture capability.',
    manifest: {
      name: 'safe-organ',
      provide: ['fixture'],
      inject: ['tools'],
    },
    config: { enabled: true },
    source: 'upstream',
    availability,
    active: true,
  })
})

// --- controller ---

function fixtureEntry(overrides = {}) {
  return entry({
    id: 'fixture-organ',
    module: '@fixture/organ',
    manifest: {
      name: 'fixture-organ',
      provide: ['fixtureOrgan'],
      inject: [],
    },
    config: { fail: false },
    ...overrides,
  })
}

async function fixtureController(options = {}) {
  const packageJsonPath = await fakePackage()
  let imports = 0
  const controller = new OrganController({
    resolveModule: () => ({ packageJsonPath }),
    importModule: async () => {
      imports += 1
      return fixtureOrgan
    },
    ...options,
  })
  return { controller, imports: () => imports }
}

test('OrganController mounts a real Cordis fiber and exposes its effects', async () => {
  fixtureOrgan.resetFixtureEvents()
  const ctx = new Context()
  const owner = {}
  const { controller } = await fixtureController()

  const loaded = await controller.load(owner, ctx, fixtureEntry(), { fail: false })

  assert.equal(loaded.id, 'fixture-organ')
  assert.equal(loaded.fiberState, 'ACTIVE')
  assert.deepEqual(loaded.effectLabels, [
    'ctx.provide("fixtureOrgan")',
    'fixture-organ.reversible-effect',
  ])
  assert.equal(ctx.get('fixtureOrgan').value, 'active')
  assert.deepEqual(fixtureOrgan.fixtureEvents, ['mounted'])
  assert.deepEqual(controller.list(owner), [loaded])

  await ctx.root.fiber.dispose()
})

test('OrganController unload executes the Cordis reversal chain', async () => {
  fixtureOrgan.resetFixtureEvents()
  const ctx = new Context()
  const owner = {}
  const { controller } = await fixtureController()
  await controller.load(owner, ctx, fixtureEntry(), { fail: false })

  assert.equal(await controller.unload(owner, 'fixture-organ'), true)
  assert.equal(ctx.get('fixtureOrgan'), undefined)
  assert.deepEqual(fixtureOrgan.fixtureEvents, ['mounted', 'disposed'])
  assert.deepEqual(controller.list(owner), [])
  assert.equal(await controller.unload(owner, 'fixture-organ'), false)

  await ctx.root.fiber.dispose()
})

test('OrganController rejects version and manifest drift before mounting', async () => {
  fixtureOrgan.resetFixtureEvents()
  const ctx = new Context()
  const owner = {}
  const driftPackage = await fakePackage('9.9.9')
  let imports = 0
  const drift = new OrganController({
    resolveModule: () => ({ packageJsonPath: driftPackage }),
    importModule: async () => {
      imports += 1
      return fixtureOrgan
    },
  })
  await assert.rejects(drift.load(owner, ctx, fixtureEntry(), {}), /version drift/i)
  assert.equal(imports, 0, 'version drift must be rejected before import')

  const packageJsonPath = await fakePackage()
  const mismatch = new OrganController({
    resolveModule: () => ({ packageJsonPath }),
    importModule: async () => ({ ...fixtureOrgan, name: 'unreviewed-name' }),
  })
  await assert.rejects(mismatch.load(owner, ctx, fixtureEntry(), {}), /manifest.*name/i)
  assert.equal(ctx.get('fixtureOrgan'), undefined)
  assert.deepEqual(fixtureOrgan.fixtureEvents, [])

  await ctx.root.fiber.dispose()
})

test('OrganController rejects concurrent duplicate loads', async () => {
  fixtureOrgan.resetFixtureEvents()
  const ctx = new Context()
  const owner = {}
  const packageJsonPath = await fakePackage()
  let releaseImport
  const importGate = new Promise((resolve) => {
    releaseImport = resolve
  })
  const controller = new OrganController({
    resolveModule: () => ({ packageJsonPath }),
    importModule: async () => {
      await importGate
      return fixtureOrgan
    },
  })

  const first = controller.load(owner, ctx, fixtureEntry(), {})
  await assert.rejects(controller.load(owner, ctx, fixtureEntry(), {}), /already loading/i)
  releaseImport()
  await first
  await assert.rejects(controller.load(owner, ctx, fixtureEntry(), {}), /already active/i)

  await ctx.root.fiber.dispose()
})

test('OrganController cleans up a fiber whose startup fails', async () => {
  fixtureOrgan.resetFixtureEvents()
  const ctx = new Context()
  const owner = {}
  const { controller } = await fixtureController()

  await assert.rejects(
    controller.load(owner, ctx, fixtureEntry(), { fail: true }),
    /startup failed/i,
  )
  assert.equal(ctx.get('fixtureOrgan'), undefined)
  assert.deepEqual(controller.list(owner), [])
  assert.deepEqual(fixtureOrgan.fixtureEvents, [])

  await ctx.root.fiber.dispose()
})

test('OrganController disposeOwner unloads every owned organ', async () => {
  fixtureOrgan.resetFixtureEvents()
  const ctx = new Context()
  const owner = {}
  const { controller } = await fixtureController()
  await controller.load(owner, ctx, fixtureEntry(), {})

  await controller.disposeOwner(owner)

  assert.equal(ctx.get('fixtureOrgan'), undefined)
  assert.deepEqual(controller.list(owner), [])
  assert.deepEqual(fixtureOrgan.fixtureEvents, ['mounted', 'disposed'])
  await ctx.root.fiber.dispose()
})

test('OrganController disposal aborts and joins an in-flight import', async () => {
  fixtureOrgan.resetFixtureEvents()
  const ctx = new Context()
  const owner = {}
  const packageJsonPath = await fakePackage()
  let enterImport
  const importEntered = new Promise((resolve) => {
    enterImport = resolve
  })
  let releaseImport
  const importGate = new Promise((resolve) => {
    releaseImport = resolve
  })
  const controller = new OrganController({
    resolveModule: () => ({ packageJsonPath }),
    importModule: async () => {
      enterImport()
      await importGate
      return fixtureOrgan
    },
  })
  const loadResult = controller.load(owner, ctx, fixtureEntry(), {}).then(
    () => undefined,
    (error) => error,
  )
  await importEntered

  const disposal = controller.disposeOwner(owner)
  releaseImport()
  await disposal
  const error = await loadResult

  assert.match(String(error), /owner disposed|aborted/i)
  assert.deepEqual(controller.list(owner), [])
  assert.equal(ctx.get('fixtureOrgan'), undefined)
  await assert.rejects(controller.load(owner, ctx, fixtureEntry(), {}), /disposed owner/i)
  await ctx.root.fiber.dispose()
})

test('an injected checkAvailability gates the load before any import', async () => {
  fixtureOrgan.resetFixtureEvents()
  const ctx = new Context()
  const owner = {}
  let imports = 0
  const blocked = new OrganController({
    importModule: async () => {
      imports += 1
      return fixtureOrgan
    },
    checkAvailability: () => {
      throw new Error('injected availability failure')
    },
  })
  await assert.rejects(
    blocked.load(owner, ctx, fixtureEntry(), {}),
    /injected availability failure/,
  )
  assert.equal(imports, 0)

  const allowed = new OrganController({
    importModule: async () => {
      imports += 1
      return fixtureOrgan
    },
    checkAvailability: () => {},
  })
  const loaded = await allowed.load(owner, ctx, fixtureEntry(), {})
  assert.equal(loaded.fiberState, 'ACTIVE')
  assert.equal(imports, 1)
  await allowed.unload(owner, loaded.id, loaded.instanceId)
  await ctx.root.fiber.dispose()
})

test('registered agent-context cleanup disposes owned organs', async () => {
  fixtureOrgan.resetFixtureEvents()
  const ctx = new Context()
  const owner = { id: 'agent-fixture', ctx }
  const { controller } = await fixtureController()
  await controller.load(owner, ctx, fixtureEntry(), {})
  const disposeOwnerEffect = registerOrganOwnerCleanup(owner, controller)

  await disposeOwnerEffect()

  assert.deepEqual(controller.list(owner), [])
  assert.equal(ctx.get('fixtureOrgan'), undefined)
  assert.deepEqual(fixtureOrgan.fixtureEvents, ['mounted', 'disposed'])
  await ctx.root.fiber.dispose()
})

// --- proposal planning and commit ---

test('planOrganLoad exposes the exact pin, manifest, config, risk, and privilege grant', () => {
  const provenance = communityProvenance()
  const planned = planOrganLoad(
    fixtureEntry({ config: { fail: false, level: 1 }, source: 'community', provenance }),
    {
      level: 2,
    },
  )
  assert.deepEqual(planned.config, { fail: false, level: 2 })
  assert.equal(planned.effects.length, 1)
  const effect = planned.effects[0]
  assert.equal(effect.type, 'plugin-load')
  assert.equal(effect.target, '@fixture/organ@1.2.3-rc.4')
  assert.equal(effect.details.id, 'fixture-organ')
  assert.equal(effect.details.module, '@fixture/organ')
  assert.equal(effect.details.version, '1.2.3-rc.4')
  assert.deepEqual(effect.details.manifest, fixtureEntry().manifest)
  assert.deepEqual(effect.details.config, planned.config)
  assert.equal(effect.details.risk, fixtureEntry().risk)
  assert.deepEqual(effect.details.provenance, provenance)
  assert.equal(effect.details.privilege, IN_PROCESS_PRIVILEGE_WARNING)
  assert.match(effect.summary, /full privileges/i)
})

test('a plugin-load proposal imports nothing before approved apply', async () => {
  fixtureOrgan.resetFixtureEvents()
  const ctx = new Context()
  const owner = {}
  const store = new ProposalStore()
  const { controller, imports } = await fixtureController()
  const planned = planOrganLoad(fixtureEntry(), {})
  const proposal = store.create(owner, {
    kind: 'plugin-load',
    title: planned.title,
    summary: planned.summary,
    effects: planned.effects,
    commit: organLoadCommit(planned, controller, owner, ctx),
  })

  assert.equal(imports(), 0)
  assert.equal(proposal.status, 'pending')
  const result = await store.apply(owner, proposal.id, {})
  assert.equal(imports(), 1)
  assert.match(result.summary, /ACTIVE/)
  assert.equal(controller.list(owner)[0].fiberState, 'ACTIVE')
  assert.equal(ctx.get('fixtureOrgan').value, 'active')

  await controller.disposeOwner(owner)
  await ctx.root.fiber.dispose()
})

test('a plugin-unload proposal reverses the reviewed live effects', async () => {
  fixtureOrgan.resetFixtureEvents()
  const ctx = new Context()
  const owner = {}
  const store = new ProposalStore()
  const { controller } = await fixtureController()
  await controller.load(owner, ctx, fixtureEntry(), {})
  const planned = planOrganUnload(controller.list(owner)[0])
  assert.equal(planned.effects[0].details.instanceId, planned.active.instanceId)
  assert.deepEqual(planned.effects[0].details.effectLabels, [
    'ctx.provide("fixtureOrgan")',
    'fixture-organ.reversible-effect',
  ])
  const proposal = store.create(owner, {
    kind: 'plugin-unload',
    title: planned.title,
    summary: planned.summary,
    effects: planned.effects,
    commit: organUnloadCommit(planned, controller, owner),
  })

  const result = await store.apply(owner, proposal.id, {})
  assert.match(result.summary, /Unloaded/)
  assert.equal(ctx.get('fixtureOrgan'), undefined)
  assert.deepEqual(fixtureOrgan.fixtureEvents, ['mounted', 'disposed'])

  await ctx.root.fiber.dispose()
})

test('a stale unload proposal cannot dispose a replacement organ instance', async () => {
  fixtureOrgan.resetFixtureEvents()
  const ctx = new Context()
  const owner = {}
  const { controller } = await fixtureController()
  const first = await controller.load(owner, ctx, fixtureEntry(), {})
  const stale = planOrganUnload(first)
  await controller.unload(owner, first.id, first.instanceId)
  const replacement = await controller.load(owner, ctx, fixtureEntry(), {})
  assert.notEqual(replacement.instanceId, first.instanceId)

  await assert.rejects(organUnloadCommit(stale, controller, owner)({}), /changed since approval/i)
  assert.equal(controller.list(owner)[0].instanceId, replacement.instanceId)
  assert.equal(ctx.get('fixtureOrgan').value, 'active')

  await controller.unload(owner, replacement.id, replacement.instanceId)
  await ctx.root.fiber.dispose()
})

test('a failed plugin-load commit stays failed and mounts nothing', async () => {
  fixtureOrgan.resetFixtureEvents()
  const ctx = new Context()
  const owner = {}
  const store = new ProposalStore()
  const driftPackage = await fakePackage('9.9.9')
  let imports = 0
  const controller = new OrganController({
    resolveModule: () => ({ packageJsonPath: driftPackage }),
    importModule: async () => {
      imports += 1
      return fixtureOrgan
    },
  })
  const planned = planOrganLoad(fixtureEntry(), {})
  const proposal = store.create(owner, {
    kind: 'plugin-load',
    title: planned.title,
    summary: planned.summary,
    effects: planned.effects,
    commit: organLoadCommit(planned, controller, owner, ctx),
  })

  await assert.rejects(store.apply(owner, proposal.id, {}), /version drift/i)
  assert.equal(imports, 0)
  assert.equal(ctx.get('fixtureOrgan'), undefined)
  assert.deepEqual(controller.list(owner), [])
  assert.equal(store.show(owner, proposal.id).status, 'failed')

  await ctx.root.fiber.dispose()
})

test('the bundled catalog loads every exact-pinned plugin only on proposal apply', async () => {
  const entries = readBundledOrganIndex()
  assert.deepEqual(
    entries.map(({ id, module, version }) => ({ id, module, version })),
    [
      {
        id: 'dsh-skill-badge',
        module: '@deepseek-ai/dsh-skill-badge',
        version: '0.1.0-rc.8',
      },
      {
        id: 'dsh-pkg-info',
        module: 'dsh-pkg-info',
        version: '0.1.1',
      },
    ],
  )
  const ctx = new Context()
  ctx.provide('skills', { registerProvider() {} })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const owner = {}
  const store = new ProposalStore()
  let imports = 0
  const controller = new OrganController({
    importModule: async (specifier) => {
      imports += 1
      return import(specifier)
    },
  })

  for (const catalogEntry of entries) {
    const planned = planOrganLoad(catalogEntry, {})
    const proposal = store.create(owner, {
      kind: 'plugin-load',
      title: planned.title,
      summary: planned.summary,
      effects: planned.effects,
      commit: organLoadCommit(planned, controller, owner, ctx),
    })

    const importsBeforeApply = imports
    assert.equal(controller.list(owner).length, 0)
    const result = await store.apply(owner, proposal.id, {})
    assert.equal(imports, importsBeforeApply + 1)
    assert.match(result.summary, /ACTIVE/)
    const active = controller.list(owner)[0]
    assert.equal(active.id, catalogEntry.id)

    if (catalogEntry.id === 'dsh-pkg-info') {
      assert.ok(ctx.tools.schemas().some((schema) => schema.name === 'pkg_info'))
    }
    await controller.unload(owner, active.id, active.instanceId)
    assert.deepEqual(controller.list(owner), [])
    if (catalogEntry.id === 'dsh-pkg-info') {
      assert.ok(ctx.tools.schemas().every((schema) => schema.name !== 'pkg_info'))
    }
  }
  await ctx.root.fiber.dispose()
})

test('the bundled catalog provenance matches the frozen lockfile artifacts', async () => {
  const lockfile = parseYaml(await readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'))
  const rootDependencies = lockfile.importers['.'].dependencies
  const packages = lockfile.packages

  for (const catalogEntry of readBundledOrganIndex()) {
    const dependency = rootDependencies[catalogEntry.module]
    assert.ok(dependency, `${catalogEntry.module} must be a direct dependency`)
    assert.equal(dependency.specifier, catalogEntry.version)
    assert.ok(
      dependency.version === catalogEntry.version ||
        dependency.version.startsWith(`${catalogEntry.version}(`),
      `${catalogEntry.module} must resolve to ${catalogEntry.version}`,
    )

    const snapshotPrefix = `${catalogEntry.module}@${catalogEntry.version}`
    const packageRecord = packages[snapshotPrefix]
    assert.ok(packageRecord, `${snapshotPrefix} must have one frozen package record`)
    assert.equal(
      catalogEntry.provenance.integrity,
      packageRecord.resolution.integrity,
      `${snapshotPrefix} integrity must match pnpm-lock.yaml`,
    )
  }
})
