import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'

import { parseOrganIndex } from '../dist/packages/plugin-control/src/catalog.js'
import {
  contentAddressedFilename,
  checkModuleSyntax,
  IMPORT_WHITELIST,
  pluginDigest,
  scanPluginSource,
  SOURCE_MAX_BYTES,
  validateForgedPluginInput,
} from '../dist/packages/plugin-forge/src/document.js'
import {
  CATALOG_PLACEHOLDERS,
  mergeAttributedTools,
  planCapabilityGap,
  shouldRecordSearchMiss,
  toolsFromEffectLabels,
  toolsFromSource,
} from '../dist/packages/plugin-forge/src/evidence.js'
import { readCapabilityGaps, readRevisionLog } from '../dist/packages/plugin-forge/src/journal.js'
import {
  commitForgedPluginWrite,
  ensureImportResolution,
  listForgedPlugins,
  metaDigestOf,
  planForgedPluginWrite,
  readForgedPlugin,
  resolveForgedPluginTarget,
} from '../dist/packages/plugin-forge/src/store.js'
import {
  forgedEntry,
  PluginForgeRuntime,
  verifyForgedState,
} from '../dist/packages/plugin-forge/src/index.js'
import { ProposalStore } from '../dist/packages/proposals/src/index.js'
import { capabilityRef } from '../dist/packages/capability-discovery/src/catalog.js'
import { HarnessEvalRuntime, bundledTasksDir } from '../dist/packages/harness-eval/src/index.js'
import {
  compareScores,
  conditionDigest,
  evalCanonical,
  evalSha256Hex,
} from '../dist/packages/harness-eval/src/contract.js'
import {
  bundledSuiteDigest,
  writeCompare,
  writeRun,
  writeSnapshot,
} from '../dist/packages/harness-eval/src/store.js'

const ECHO_SOURCE = `export const name = 'forged-echo'
export const provide = ['forgedEcho']
export const inject = []

export function apply(ctx, config) {
  ctx.provide('forgedEcho', { value: (config && config.value) || 'active' })
}
`

const TOOLSMITH_SOURCE = `import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'forged-toolsmith'
export const provide = []
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'forged_echo',
      description: 'Echo a message back, proving a forged tool is invocable.',
      parameters: {
        message: { type: 'string', required: true, description: 'Message to echo.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args) => args.message,
    }),
  )
}
`

const BROKEN_SOURCE = `export const name = 'forged-echo'
export const provide = ['forgedEcho']
export const inject = []

export function apply() {
  throw new Error('forged fixture startup failure')
}
`

function input(overrides = {}) {
  return {
    slug: 'forged-echo',
    summary: 'Provide a tiny echo service for tests.',
    manifest: { name: 'forged-echo', provide: ['forgedEcho'], inject: [] },
    intendedEffects: ['provide the forgedEcho service'],
    source: ECHO_SOURCE,
    ...overrides,
  }
}

// --- document ---

test('validateForgedPluginInput normalizes a full valid input', () => {
  const document = validateForgedPluginInput(input({ summary: '  Echo service.  ' }))
  assert.equal(document.summary, 'Echo service.')
  assert.deepEqual(document.manifest, { name: 'forged-echo', provide: ['forgedEcho'], inject: [] })
  assert.deepEqual(document.intendedEffects, ['provide the forgedEcho service'])
  assert.equal(document.config, undefined)
})

test('validateForgedPluginInput rejects malformed inputs', () => {
  const cases = [
    [input({ slug: '../escape' }), /slug/i],
    [input({ slug: 'Upper' }), /slug/i],
    [input({ summary: 'a\nb' }), /single line/i],
    [input({ summary: 'x'.repeat(501) }), /500/],
    [input({ manifest: { name: 'other', provide: [], inject: [] } }), /manifest\.name must equal/i],
    [input({ manifest: { name: 'forged-echo', provide: ['a', 'a'], inject: [] } }), /duplicates/i],
    [
      input({
        manifest: {
          name: 'forged-echo',
          provide: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
          inject: [],
        },
      }),
      /at most 8/i,
    ],
    [input({ intendedEffects: [] }), /at least one effect/i],
    [input({ intendedEffects: ['x'.repeat(201)] }), /200/],
    [input({ source: '' }), /source/i],
    [input({ source: 'export {}\r\n' }), /LF line endings/i],
    [input({ source: `export {}${'/'.repeat(SOURCE_MAX_BYTES)}` }), /at most/i],
    [input({ config: [1, 2] }), /JSON object/i],
  ]
  for (const [value, expected] of cases) {
    assert.throws(() => validateForgedPluginInput(value), expected)
  }
})

test('digest and content-addressed filename are deterministic and validated', () => {
  const digest = pluginDigest(ECHO_SOURCE)
  assert.match(digest, /^[0-9a-f]{64}$/)
  assert.equal(pluginDigest(ECHO_SOURCE), digest)
  assert.equal(contentAddressedFilename(digest), `source.${digest.slice(0, 12)}.mjs`)
  assert.throws(() => contentAddressedFilename('nope'), /sha256/i)
})

test('checkModuleSyntax accepts valid ESM and rejects syntax errors without executing', async () => {
  await checkModuleSyntax(ECHO_SOURCE)
  await checkModuleSyntax('export const name = 1\nthrow new Error("never runs at check time")\n')
  await assert.rejects(checkModuleSyntax('export function apply( {\n'), /not valid ESM/i)
})

test('scanPluginSource accepts whitelisted imports and reports structure', async () => {
  const report = await scanPluginSource(TOOLSMITH_SOURCE)
  assert.deepEqual(report, {
    imports: ['@deepseek-ai/dsh-tools'],
    exportsApply: true,
    exportsName: true,
  })
  const bare = await scanPluginSource(ECHO_SOURCE)
  assert.deepEqual(bare.imports, [])
})

test('scanPluginSource rejects every escape hatch class', async () => {
  const cases = [
    [
      "import fs from 'node:fs'\nexport const name = 'x'\nexport function apply() {}\n",
      /whitelist/i,
    ],
    [
      "import x from './sibling.js'\nexport const name = 'x'\nexport function apply() {}\n",
      /whitelist/i,
    ],
    [
      "import x from 'https://example.com/x.js'\nexport const name = 'x'\nexport function apply() {}\n",
      /whitelist/i,
    ],
    [
      "export const name = 'x'\nexport async function apply() { await import('node:fs') }\n",
      /dynamic import/i,
    ],
    [
      "export const name = 'x'\nexport async function apply(m) { await import(m) }\n",
      /dynamic import/i,
    ],
    ["export const name = 'x'\nexport function apply() {} // uses require somewhere\n", /require/i],
    ['export function apply() {}\n', /export a top-level `name`/i],
    ["export const name = 'x'\n", /apply/i],
  ]
  for (const [source, expected] of cases) {
    await assert.rejects(scanPluginSource(source), expected, source)
  }
  const viaDefault = await scanPluginSource(
    "export const name = 'x'\nexport default function apply() {}\n",
  )
  assert.equal(viaDefault.exportsApply, true)
})

// --- store ---

async function freshRoots() {
  return {
    dshHome: await mkdtemp(join(tmpdir(), 'omd-forge-home-')),
    workspace: await mkdtemp(join(tmpdir(), 'omd-forge-ws-')),
  }
}

test('resolveForgedPluginTarget maps scopes and rejects unsafe slugs', async () => {
  const roots = await freshRoots()
  const user = resolveForgedPluginTarget('user', 'forged-echo', roots)
  assert.equal(user.root, join(roots.dshHome, 'forged-plugins'))
  assert.equal(user.metaPath, join(user.root, 'forged-echo', 'plugin.json'))
  const project = resolveForgedPluginTarget('project', 'forged-echo', roots)
  assert.equal(project.root, join(roots.workspace, '.dsh', 'forged-plugins'))
  assert.throws(
    () => resolveForgedPluginTarget('project', 'x', { dshHome: roots.dshHome }),
    /workspace/i,
  )
  assert.throws(() => resolveForgedPluginTarget('user', '../up', roots), /safe directory/i)
})

test('commitForgedPluginWrite creates atomically and readForgedPlugin round-trips', async () => {
  const roots = await freshRoots()
  const target = resolveForgedPluginTarget('user', 'forged-echo', roots)
  const document = validateForgedPluginInput(input())
  const plan = planForgedPluginWrite(document, 'user')
  assert.equal(plan.action, 'create')
  assert.equal(plan.meta.revision, 1)
  await commitForgedPluginWrite(target, plan)

  const state = await readForgedPlugin(target)
  assert.equal(state.meta.slug, 'forged-echo')
  assert.equal(state.meta.digest, pluginDigest(ECHO_SOURCE))
  assert.equal(state.digestMatches, true)
  assert.equal(state.source, ECHO_SOURCE)
  assert.equal(state.metaDigest, metaDigestOf(await readFile(target.metaPath, 'utf8')))
  const sourceStat = await stat(join(target.directory, state.meta.sourceFile))
  assert.equal(sourceStat.mode & 0o777, 0o644)
})

test('identical re-forge is rejected and revisions replace the old source file', async () => {
  const roots = await freshRoots()
  const target = resolveForgedPluginTarget('user', 'forged-echo', roots)
  const document = validateForgedPluginInput(input())
  await commitForgedPluginWrite(target, planForgedPluginWrite(document, 'user'))
  const existing = await readForgedPlugin(target)

  assert.throws(() => planForgedPluginWrite(document, 'user', existing), /identical source/i)

  const revised = validateForgedPluginInput(input({ source: `${ECHO_SOURCE}// rev 2\n` }))
  const plan = planForgedPluginWrite(revised, 'user', existing)
  assert.equal(plan.action, 'update')
  assert.equal(plan.meta.revision, 2)
  assert.equal(plan.meta.createdAt, existing.meta.createdAt)
  await commitForgedPluginWrite(target, plan, existing.metaDigest)

  const state = await readForgedPlugin(target)
  assert.equal(state.meta.revision, 2)
  assert.equal(state.digestMatches, true)
  const files = await readdir(target.directory)
  assert.deepEqual(files.sort(), ['plugin.json', 'revisions.jsonl', plan.sourceFile].sort())
})

test('the stale-metadata guard rejects appeared, disappeared, and changed states', async () => {
  const roots = await freshRoots()
  const target = resolveForgedPluginTarget('user', 'forged-echo', roots)
  const document = validateForgedPluginInput(input())
  const createPlan = planForgedPluginWrite(document, 'user')

  await commitForgedPluginWrite(target, createPlan)
  // Same create plan again: the file appeared after prepare.
  await assert.rejects(commitForgedPluginWrite(target, createPlan), /appeared after/i)

  const existing = await readForgedPlugin(target)
  const revised = validateForgedPluginInput(input({ source: `${ECHO_SOURCE}// rev 2\n` }))
  const plan = planForgedPluginWrite(revised, 'user', existing)
  await assert.rejects(commitForgedPluginWrite(target, plan, 'f'.repeat(64)), /changed after/i)
})

test('symlinked forge directories are refused', async () => {
  const roots = await freshRoots()
  const real = await mkdtemp(join(tmpdir(), 'omd-forge-elsewhere-'))
  const target = resolveForgedPluginTarget('user', 'forged-echo', roots)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(target.root, { recursive: true })
  await symlink(real, target.directory)
  const plan = planForgedPluginWrite(validateForgedPluginInput(input()), 'user')
  await assert.rejects(commitForgedPluginWrite(target, plan), /symlink/i)
})

test('a failed metadata rename leaves no partial first write', async () => {
  const roots = await freshRoots()
  const target = resolveForgedPluginTarget('user', 'forged-echo', roots)
  const plan = planForgedPluginWrite(validateForgedPluginInput(input()), 'user')
  await assert.rejects(
    commitForgedPluginWrite(target, plan, undefined, {
      renameFile: async () => {
        throw new Error('injected rename failure')
      },
    }),
    /injected rename failure/,
  )
  assert.equal(await readForgedPlugin(target), undefined)
  const files = await readdir(target.directory).catch(() => [])
  assert.deepEqual(files, [])
})

test('tampered sources and malformed metadata are reported honestly', async () => {
  const roots = await freshRoots()
  const target = resolveForgedPluginTarget('user', 'forged-echo', roots)
  await commitForgedPluginWrite(
    target,
    planForgedPluginWrite(validateForgedPluginInput(input()), 'user'),
  )
  const state = await readForgedPlugin(target)
  await writeFile(join(target.directory, state.meta.sourceFile), `${ECHO_SOURCE}// tampered\n`)

  const tampered = await readForgedPlugin(target)
  assert.equal(tampered.digestMatches, false)

  const badTarget = resolveForgedPluginTarget('user', 'broken-meta', roots)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(badTarget.directory, { recursive: true })
  await writeFile(badTarget.metaPath, '{ not json')

  const summaries = await listForgedPlugins(roots)
  assert.equal(summaries.length, 2)
  const broken = summaries.find((summary) => summary.slug === 'broken-meta')
  assert.equal(broken.status, 'invalid')
  assert.match(broken.reason, /JSON/i)
  const ok = summaries.find((summary) => summary.slug === 'forged-echo')
  assert.equal(ok.status, 'ok')
  assert.equal(ok.digestMatches, false)
})

test('verifyForgedState blocks tampering and digest drift before import', async () => {
  const roots = await freshRoots()
  const target = resolveForgedPluginTarget('user', 'forged-echo', roots)
  const plan = planForgedPluginWrite(validateForgedPluginInput(input()), 'user')
  await commitForgedPluginWrite(target, plan)

  const { entry } = await verifyForgedState(target, plan.digest)
  assert.equal(entry.id, 'forged-echo')
  assert.equal(entry.version, '0.0.1')
  assert.match(entry.module, /^file:\/\//)

  await assert.rejects(verifyForgedState(target, 'a'.repeat(64)), /changed after|reviewed/i)
  const state = await readForgedPlugin(target)
  await writeFile(join(target.directory, state.meta.sourceFile), `${ECHO_SOURCE}// tampered\n`)
  await assert.rejects(verifyForgedState(target, plan.digest), /does not hash/i)
})

// --- runtime ---

function forgeHarness() {
  const ctx = new Context()
  const registeredTools = new Map()
  const registeredCommands = new Map()
  const promptSections = []
  const proposals = new ProposalStore()
  ctx.provide('tools', {
    register(definition) {
      registeredTools.set(definition.name, definition)
      return () => registeredTools.delete(definition.name)
    },
    schemas() {
      return [...registeredTools.values()].map((definition) => ({
        name: definition.name,
        description: definition.description ?? '',
      }))
    },
  })
  ctx.provide('commands', {
    register(definition) {
      registeredCommands.set(definition.name, definition)
      return () => registeredCommands.delete(definition.name)
    },
  })
  ctx.provide('systemPrompt', {
    section(section) {
      promptSections.push(section)
      return () => {}
    },
  })
  ctx.provide('proposals', {
    create: (owner, input) => proposals.create(owner, input),
    list: (owner) => proposals.list(owner),
    show: (owner, id) => proposals.show(owner, id),
    discard: (owner, id) => proposals.discard(owner, id),
    apply: (owner, id, exec) => proposals.apply(owner, id, exec),
  })
  return { ctx, registeredTools, registeredCommands, promptSections, proposals }
}

async function runtimeFixture() {
  const harness = forgeHarness()
  const roots = await freshRoots()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = roots.dshHome
  const restore = () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  const fiber = harness.ctx.plugin(PluginForgeRuntime)
  await fiber
  const agent = {
    id: 'agent-forge',
    ctx: harness.ctx,
    session: { header: { cwd: roots.workspace } },
  }
  const tool = harness.registeredTools.get('plugin_forge')
  const exec = { agent, signal: new AbortController().signal }
  return { harness, roots, agent, tool, exec, restore, fiber }
}

test('runtime registers tool, command, and prompt section', async () => {
  const { harness, tool, restore } = await runtimeFixture()
  try {
    assert.ok(tool)
    assert.ok(harness.registeredCommands.get('omd-forged'))
    assert.equal(harness.promptSections[0].name, 'omd:plugin-forge')
    assert.match(harness.promptSections[0].text, /approved proposal_control apply/)
  } finally {
    restore()
  }
})

test('forge end to end: proposal, mount, unload, remount', async () => {
  const { harness, agent, tool, exec, restore } = await runtimeFixture()
  try {
    const prepared = JSON.parse(
      await tool.execute(
        {
          action: 'prepare_forge',
          scope: 'user',
          name: 'forged-echo',
          summary: 'Provide a tiny echo service for tests.',
          manifest: { name: 'forged-echo', provide: ['forgedEcho'], inject: [] },
          intended_effects: ['provide the forgedEcho service'],
          source: ECHO_SOURCE,
          config: { value: 'from-config' },
        },
        exec,
      ),
    )
    assert.equal(prepared.proposal.kind, 'plugin-forge')
    const effect = prepared.proposal.effects[0]
    assert.equal(effect.details.source, ECHO_SOURCE)
    assert.match(effect.summary, /full privileges/i)
    assert.equal(harness.ctx.get('forgedEcho'), undefined)

    const result = await harness.proposals.apply(agent, prepared.proposal.id, exec)
    assert.match(result.summary, /ACTIVE/)
    assert.equal(harness.ctx.get('forgedEcho').value, 'from-config')
    assert.deepEqual(result.details.declaredIntendedEffects, ['provide the forgedEcho service'])
    assert.ok(result.details.observedEffectLabels.includes('ctx.provide("forgedEcho")'))

    const listed = JSON.parse(await tool.execute({ action: 'list' }, exec))
    assert.equal(listed.plugins[0].slug, 'forged-echo')
    assert.equal(listed.plugins[0].active, true)

    const unload = JSON.parse(
      await tool.execute({ action: 'prepare_unload', name: 'forged-echo' }, exec),
    )
    assert.equal(unload.proposal.kind, 'plugin-unload')
    await harness.proposals.apply(agent, unload.proposal.id, exec)
    assert.equal(harness.ctx.get('forgedEcho'), undefined)

    const reload = JSON.parse(
      await tool.execute({ action: 'prepare_load', scope: 'user', name: 'forged-echo' }, exec),
    )
    assert.equal(reload.proposal.kind, 'plugin-load')
    assert.equal(reload.proposal.effects[0].details.source, ECHO_SOURCE)
    const reloaded = await harness.proposals.apply(agent, reload.proposal.id, exec)
    assert.match(reloaded.summary, /ACTIVE/)
    assert.equal(harness.ctx.get('forgedEcho').value, 'from-config')
  } finally {
    restore()
  }
})

test('a forged tool that imports the whitelist is invocable after mount', async () => {
  const { harness, agent, tool, exec, restore } = await runtimeFixture()
  try {
    const prepared = JSON.parse(
      await tool.execute(
        {
          action: 'prepare_forge',
          scope: 'user',
          name: 'forged-toolsmith',
          summary: 'Register an echo tool from forged source.',
          manifest: { name: 'forged-toolsmith', provide: [], inject: ['tools'] },
          intended_effects: ['register the forged_echo tool'],
          source: TOOLSMITH_SOURCE,
        },
        exec,
      ),
    )
    assert.deepEqual(prepared.imports, ['@deepseek-ai/dsh-tools'])
    await harness.proposals.apply(agent, prepared.proposal.id, exec)
    const forgedTool = harness.registeredTools.get('forged_echo')
    assert.ok(forgedTool, 'forged tool should be registered through the mocked tools service')
    assert.equal(await forgedTool.execute({ message: 'hello' }, exec), 'hello')

    const unload = JSON.parse(
      await tool.execute({ action: 'prepare_unload', name: 'forged-toolsmith' }, exec),
    )
    await harness.proposals.apply(agent, unload.proposal.id, exec)
    // The mocked tools service does not emulate the real dsh-tools
    // caller-tracked cleanup, so assert the fiber state instead.
    const listed = JSON.parse(await tool.execute({ action: 'list' }, exec))
    assert.equal(listed.active.length, 0)
    assert.equal(listed.plugins.find((p) => p.slug === 'forged-toolsmith').active, false)
  } finally {
    restore()
  }
})

test('a failed mount keeps the source on disk and a revision recovers', async () => {
  const { harness, agent, tool, exec, roots, restore } = await runtimeFixture()
  try {
    const prepared = JSON.parse(
      await tool.execute(
        {
          action: 'prepare_forge',
          scope: 'user',
          name: 'forged-echo',
          summary: 'Provide a tiny echo service for tests.',
          manifest: { name: 'forged-echo', provide: ['forgedEcho'], inject: [] },
          intended_effects: ['provide the forgedEcho service'],
          source: BROKEN_SOURCE,
        },
        exec,
      ),
    )
    await assert.rejects(
      harness.proposals.apply(agent, prepared.proposal.id, exec),
      /startup failure|did not become active/i,
    )
    assert.equal(harness.proposals.show(agent, prepared.proposal.id).status, 'failed')
    assert.equal(harness.ctx.get('forgedEcho'), undefined)

    const target = resolveForgedPluginTarget('user', 'forged-echo', {
      dshHome: roots.dshHome,
      workspace: roots.workspace,
    })
    const kept = await readForgedPlugin(target)
    assert.equal(kept.meta.revision, 1)
    assert.equal(kept.digestMatches, true)

    const revised = JSON.parse(
      await tool.execute(
        {
          action: 'prepare_forge',
          scope: 'user',
          name: 'forged-echo',
          summary: 'Provide a tiny echo service for tests.',
          manifest: { name: 'forged-echo', provide: ['forgedEcho'], inject: [] },
          intended_effects: ['provide the forgedEcho service'],
          source: ECHO_SOURCE,
        },
        exec,
      ),
    )
    assert.equal(revised.proposal.effects[0].details.revision, 2)
    const result = await harness.proposals.apply(agent, revised.proposal.id, exec)
    assert.match(result.summary, /revision 2/)
    assert.equal(harness.ctx.get('forgedEcho').value, 'active')
  } finally {
    restore()
  }
})

test('tampering between prepare and apply is rejected by the digest guards', async () => {
  const { harness, agent, tool, exec, roots, restore } = await runtimeFixture()
  try {
    const target = resolveForgedPluginTarget('user', 'forged-echo', {
      dshHome: roots.dshHome,
      workspace: roots.workspace,
    })
    await commitForgedPluginWrite(
      target,
      planForgedPluginWrite(validateForgedPluginInput(input()), 'user'),
    )
    const reload = JSON.parse(
      await tool.execute({ action: 'prepare_load', scope: 'user', name: 'forged-echo' }, exec),
    )
    const state = await readForgedPlugin(target)
    await writeFile(join(target.directory, state.meta.sourceFile), `${ECHO_SOURCE}// tampered\n`)
    await assert.rejects(harness.proposals.apply(agent, reload.proposal.id, exec), /does not hash/i)
    assert.equal(harness.ctx.get('forgedEcho'), undefined)
  } finally {
    restore()
  }
})

test('adversarial source is rejected at prepare and never becomes a proposal', async () => {
  const { harness, agent, tool, exec, restore } = await runtimeFixture()
  try {
    await assert.rejects(
      tool.execute(
        {
          action: 'prepare_forge',
          scope: 'user',
          name: 'forged-echo',
          summary: 'Looks harmless.',
          manifest: { name: 'forged-echo', provide: [], inject: [] },
          intended_effects: ['nothing visible'],
          source:
            "import fs from 'node:fs'\nexport const name = 'forged-echo'\nexport function apply() {}\n",
        },
        exec,
      ),
      /whitelist/i,
    )
    assert.deepEqual(harness.proposals.list(agent), [])
  } finally {
    restore()
  }
})

test('ensureImportResolution links exactly the reviewed whitelist packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omd-forge-links-'))
  await ensureImportResolution(root)
  await ensureImportResolution(root) // idempotent
  for (const packageName of IMPORT_WHITELIST) {
    const metadata = JSON.parse(
      await readFile(join(root, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8'),
    )
    assert.equal(metadata.name, packageName)
  }
})

test('/omd-forged reports forged plugins with session state', async () => {
  const { harness, agent, tool, exec, restore } = await runtimeFixture()
  try {
    const command = harness.registeredCommands.get('omd-forged')
    assert.equal((await command.handler({ agent })).text, 'No forged plugins.')

    const prepared = JSON.parse(
      await tool.execute(
        {
          action: 'prepare_forge',
          scope: 'user',
          name: 'forged-echo',
          summary: 'Provide a tiny echo service for tests.',
          manifest: { name: 'forged-echo', provide: ['forgedEcho'], inject: [] },
          intended_effects: ['provide the forgedEcho service'],
          source: ECHO_SOURCE,
        },
        exec,
      ),
    )
    await harness.proposals.apply(agent, prepared.proposal.id, exec)
    const text = (await command.handler({ agent })).text
    assert.match(text, /● forged-echo \[user\] rev 1/)
  } finally {
    restore()
  }
})

test('agent end disposes mounted forged plugins through the owner cleanup', async () => {
  const { harness, agent, tool, exec, restore, fiber } = await runtimeFixture()
  try {
    const prepared = JSON.parse(
      await tool.execute(
        {
          action: 'prepare_forge',
          scope: 'user',
          name: 'forged-echo',
          summary: 'Provide a tiny echo service for tests.',
          manifest: { name: 'forged-echo', provide: ['forgedEcho'], inject: [] },
          intended_effects: ['provide the forgedEcho service'],
          source: ECHO_SOURCE,
        },
        exec,
      ),
    )
    await harness.proposals.apply(agent, prepared.proposal.id, exec)
    assert.equal(harness.ctx.get('forgedEcho').value, 'active')
    await fiber.dispose()
    assert.equal(harness.ctx.get('forgedEcho'), undefined)
  } finally {
    restore()
  }
})

test('effect labels and mount-time tool names attribute invocations', () => {
  assert.deepEqual(toolsFromEffectLabels(['ctx.provide("forgedEcho")']), [])
  assert.deepEqual(toolsFromEffectLabels(['ctx.tools.register("forged_echo")']), ['forged_echo'])
  assert.deepEqual(toolsFromSource(TOOLSMITH_SOURCE), ['forged_echo'])
  assert.deepEqual(toolsFromSource(ECHO_SOURCE), [])
  assert.deepEqual(mergeAttributedTools(['ctx.provide("x")'], ['forged_echo', 'forged_echo']), [
    'forged_echo',
  ])
})

test('capability-search misses are authoritative only when the catalog was complete', () => {
  assert.equal(shouldRecordSearchMiss({ hitCount: 1, skillsComplete: true }), false)
  assert.equal(shouldRecordSearchMiss({ hitCount: 0, skillsComplete: false }), false)
  assert.equal(shouldRecordSearchMiss({ hitCount: 0, skillsComplete: true }), true)
  assert.equal(
    shouldRecordSearchMiss({ hitCount: 0, skillsComplete: false, kinds: ['plugin'] }),
    true,
  )
  const redacted = planCapabilityGap({
    query: 'sk-abcdefghijklmnopqrstuvwxyz012345',
    hitCount: 0,
    skillsComplete: true,
  })
  assert.equal(redacted.redacted, true)
  assert.match(redacted.query, /redacted sha256=/)
})

test('successful forge writes a revision log', async () => {
  const roots = await freshRoots()
  const target = resolveForgedPluginTarget('user', 'forged-echo', roots)
  await commitForgedPluginWrite(
    target,
    planForgedPluginWrite(validateForgedPluginInput(input()), 'user'),
  )
  const log = await readRevisionLog(target)
  assert.equal(log.length, 1)
  assert.equal(log[0].revision, 1)
  assert.equal(log[0].action, 'create')
})

test('attributed tool invocations increment durable usage', async () => {
  const { harness, agent, tool, exec, restore } = await runtimeFixture()
  try {
    const prepared = JSON.parse(
      await tool.execute(
        {
          action: 'prepare_forge',
          scope: 'user',
          name: 'forged-toolsmith',
          summary: 'Register an echo tool from forged source.',
          manifest: { name: 'forged-toolsmith', provide: [], inject: ['tools'] },
          intended_effects: ['register the forged_echo tool'],
          source: TOOLSMITH_SOURCE,
        },
        exec,
      ),
    )
    const mounted = await harness.proposals.apply(agent, prepared.proposal.id, exec)
    assert.ok(mounted.details.attributedTools.includes('forged_echo'))

    await harness.ctx.pluginForge.recordInvocation(agent, 'forged_echo')
    await harness.ctx.pluginForge.recordInvocation(agent, 'forged_echo')
    const usage = JSON.parse(
      await tool.execute({ action: 'usage', scope: 'user', name: 'forged-toolsmith' }, exec),
    )
    assert.equal(usage.usage.totalInvocations, 2)
    assert.equal(usage.usage.byTool.forged_echo, 2)
  } finally {
    restore()
  }
})

test('prepare_promote writes an audit packet and never the curated catalog', async () => {
  const { harness, agent, tool, exec, roots, restore } = await runtimeFixture()
  const catalogBefore = await readFile(new URL('../presets/plugins.json', import.meta.url), 'utf8')
  try {
    const prepared = JSON.parse(
      await tool.execute(
        {
          action: 'prepare_forge',
          scope: 'user',
          name: 'forged-echo',
          summary: 'Provide a tiny echo service for tests.',
          manifest: { name: 'forged-echo', provide: ['forgedEcho'], inject: [] },
          intended_effects: ['provide the forgedEcho service'],
          source: ECHO_SOURCE,
        },
        exec,
      ),
    )
    await harness.proposals.apply(agent, prepared.proposal.id, exec)

    const promote = JSON.parse(
      await tool.execute({ action: 'prepare_promote', scope: 'user', name: 'forged-echo' }, exec),
    )
    assert.equal(promote.proposal.kind, 'plugin-promote')
    assert.equal(promote.proposal.effects[0].details.writesCatalog, false)
    assert.match(promote.proposal.effects[0].details.catalogDraft.module, /REPLACE_WITH/)
    assert.equal(promote.proposal.effects[0].details.source, undefined)
    assert.equal(promote.proposal.effects[0].details.current.source, ECHO_SOURCE)

    const result = await harness.proposals.apply(agent, promote.proposal.id, exec)
    assert.match(result.summary, /Catalog was not modified/)
    const audit = await readFile(join(result.details.written.auditPath), 'utf8')
    assert.match(audit, /Promotion audit: forged-echo/)
    assert.match(audit, /never writes presets\/plugins\.json/)
    const draft = JSON.parse(await readFile(result.details.written.catalogDraftPath, 'utf8'))
    assert.equal(draft.module, CATALOG_PLACEHOLDERS.module)
    assert.throws(() => parseOrganIndex(JSON.stringify([draft])), /integrity|semver|HTTPS|package/i)

    const catalogAfter = await readFile(new URL('../presets/plugins.json', import.meta.url), 'utf8')
    assert.equal(catalogAfter, catalogBefore)
    assert.equal(
      await readFile(join(roots.dshHome, 'omd', 'capability-gaps.jsonl')).catch(() => ''),
      '',
    )
  } finally {
    restore()
  }
})

test('prepare_promote requires a non-regressing diff and a faithful ablate when harnessEval is mounted', async () => {
  const { harness, agent, tool, exec, roots, restore } = await runtimeFixture()
  const catalogBefore = await readFile(new URL('../presets/plugins.json', import.meta.url), 'utf8')
  try {
    await harness.ctx.plugin(HarnessEvalRuntime)
    const prepared = JSON.parse(
      await tool.execute(
        {
          action: 'prepare_forge',
          scope: 'user',
          name: 'forged-echo',
          summary: 'Provide a tiny echo service for tests.',
          manifest: { name: 'forged-echo', provide: ['forgedEcho'], inject: [] },
          intended_effects: ['provide the forgedEcho service'],
          source: ECHO_SOURCE,
        },
        exec,
      ),
    )
    await harness.proposals.apply(agent, prepared.proposal.id, exec)
    await assert.rejects(
      tool.execute({ action: 'prepare_promote', scope: 'user', name: 'forged-echo' }, exec),
      /eval_control compare/,
    )

    const evalRoots = { ...roots, bundledTasks: bundledTasksDir() }
    const pluginRef = capabilityRef('plugin', 'forged/user/forged-echo')
    const digestA = 'a'.repeat(64)
    const digestB = 'b'.repeat(64)
    const first = await writeSnapshot(
      evalRoots,
      { skills: [], plugins: [{ ref: pluginRef, digest: digestA, revision: 1 }], patch_digest: '' },
      { files: [{ ref: pluginRef, bytes: Buffer.from(ECHO_SOURCE) }] },
    )
    const second = await writeSnapshot(
      evalRoots,
      { skills: [], plugins: [{ ref: pluginRef, digest: digestB, revision: 2 }], patch_digest: '' },
      { files: [{ ref: pluginRef, bytes: Buffer.from(ECHO_SOURCE + '\n// rev2\n') }] },
    )
    const suite = await bundledSuiteDigest(evalRoots)
    const scoreOf = (run_id, snapshot_digest) => ({
      task_id: 'snapshot-stable',
      snapshot_digest,
      condition_digest: conditionDigest(snapshot_digest, null),
      suite_digest: suite,
      intervention: null,
      pass: true,
      assertions: [{ id: 'digest-stable', pass: true }],
      tokens: { input: 0, output: 0 },
      duration_ms: 1,
    })
    const baseline = await writeRun(evalRoots, {
      task_id: 'snapshot-stable',
      snapshot_digest: first.digest,
      suite_digest: suite,
      intervention: null,
      score: scoreOf('run-base', first.digest),
      tree: {
        task_id: 'snapshot-stable',
        suite_digest: suite,
        plan: { skills: ['assert-snapshot-stable'], skip: [] },
        nodes: [],
      },
      traces: [],
      meta: {},
    })
    const candidate = await writeRun(evalRoots, {
      task_id: 'snapshot-stable',
      snapshot_digest: second.digest,
      suite_digest: suite,
      intervention: null,
      score: scoreOf('run-cand', second.digest),
      tree: {
        task_id: 'snapshot-stable',
        suite_digest: suite,
        plan: { skills: ['assert-snapshot-stable'], skip: [] },
        nodes: [],
      },
      traces: [],
      meta: {},
    })
    const result = compareScores({
      mode: 'diff',
      baseline: { ...scoreOf(baseline.run_id, first.digest), run_id: baseline.run_id },
      candidate: { ...scoreOf(candidate.run_id, second.digest), run_id: candidate.run_id },
    })
    await writeCompare(evalRoots, evalSha256Hex(evalCanonical(result)), result)
    await assert.rejects(
      tool.execute({ action: 'prepare_promote', scope: 'user', name: 'forged-echo' }, exec),
      /mode=ablate/,
    )

    const intervention = { op: 'ablate', target: pluginRef }
    const intact = await writeRun(evalRoots, {
      task_id: 'snapshot-stable',
      snapshot_digest: first.digest,
      suite_digest: suite,
      intervention: null,
      score: scoreOf('run-intact', first.digest),
      tree: {
        task_id: 'snapshot-stable',
        suite_digest: suite,
        plan: { skills: ['assert-snapshot-stable'], skip: [] },
        nodes: [],
      },
      traces: [],
      meta: {},
    })
    const ablated = await writeRun(evalRoots, {
      task_id: 'snapshot-stable',
      snapshot_digest: first.digest,
      suite_digest: suite,
      intervention,
      score: {
        ...scoreOf('run-ablate', first.digest),
        condition_digest: conditionDigest(first.digest, intervention),
        intervention,
        pass: false,
        assertions: [{ id: 'digest-stable', pass: false }],
      },
      tree: {
        task_id: 'snapshot-stable',
        suite_digest: suite,
        plan: { skills: ['assert-snapshot-stable'], skip: [] },
        nodes: [],
      },
      traces: [],
      meta: {},
    })
    const ablate = compareScores({
      mode: 'ablate',
      baseline: {
        ...scoreOf(intact.run_id, first.digest),
        run_id: intact.run_id,
      },
      candidate: {
        ...scoreOf(ablated.run_id, first.digest),
        run_id: ablated.run_id,
        condition_digest: conditionDigest(first.digest, intervention),
        intervention,
        pass: false,
        assertions: [{ id: 'digest-stable', pass: false }],
      },
      target: pluginRef,
    })
    await writeCompare(evalRoots, evalSha256Hex(evalCanonical(ablate)), ablate)

    const promote = JSON.parse(
      await tool.execute({ action: 'prepare_promote', scope: 'user', name: 'forged-echo' }, exec),
    )
    assert.equal(promote.proposal.kind, 'plugin-promote')
    const catalogAfter = await readFile(new URL('../presets/plugins.json', import.meta.url), 'utf8')
    assert.equal(catalogAfter, catalogBefore)
  } finally {
    restore()
  }
})

test('recordSearchMiss appends an authoritative gap journal', async () => {
  const { harness, restore } = await runtimeFixture()
  try {
    await harness.ctx.pluginForge.recordSearchMiss({
      query: 'pdf ocr table extraction',
      kinds: ['tool'],
      hitCount: 0,
      skillsComplete: true,
    })
    const recorded = await readCapabilityGaps(process.env.DSH_HOME)
    assert.equal(recorded.at(-1).query, 'pdf ocr table extraction')
    assert.equal(recorded.at(-1).authoritative, true)
  } finally {
    restore()
  }
})
