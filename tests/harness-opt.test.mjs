import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'

import { capabilityRef } from '../dist/packages/capability-discovery/src/catalog.js'
import { CapabilityDiscoveryRuntime } from '../dist/packages/capability-discovery/src/index.js'
import {
  compareScores,
  conditionDigest,
  evalCanonical,
  evalSha256Hex,
} from '../dist/packages/harness-eval/src/contract.js'
import { bundledTasksDir } from '../dist/packages/harness-eval/src/index.js'
import {
  bundledSuiteDigest,
  writeCompare,
  writeRun,
  writeSnapshot,
} from '../dist/packages/harness-eval/src/store.js'
import { appendCapabilityGap } from '../dist/packages/plugin-forge/src/journal.js'
import { validateForgedPluginInput } from '../dist/packages/plugin-forge/src/document.js'
import {
  commitForgedPluginWrite,
  planForgedPluginWrite,
  resolveForgedPluginTarget,
} from '../dist/packages/plugin-forge/src/store.js'
import {
  OPT_CONTROL_ACTIONS,
  parseOptControlRequest,
} from '../dist/packages/harness-opt/src/contract.js'
import { HarnessOptRuntime } from '../dist/packages/harness-opt/src/index.js'
import { gapCoveredBySlug } from '../dist/packages/harness-opt/src/observe.js'

const ECHO_SOURCE = `export const name = 'forged-echo'
export const provide = ['forgedEcho']
export const inject = []

export function apply(ctx, config) {
  ctx.provide('forgedEcho', { value: (config && config.value) || 'active' })
}
`

const CATALOG = new URL('../presets/plugins.json', import.meta.url)

function optHarness() {
  const ctx = new Context()
  const registeredTools = new Map()
  const registeredCommands = new Map()
  const promptSections = []
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
    list() {
      return [...registeredCommands.values()]
    },
  })
  ctx.provide('systemPrompt', {
    section(section) {
      promptSections.push(section)
      return () => {}
    },
  })
  return { ctx, registeredTools, registeredCommands, promptSections }
}

async function freshRoots() {
  return {
    dshHome: await mkdtemp(join(tmpdir(), 'omd-opt-home-')),
    workspace: await mkdtemp(join(tmpdir(), 'omd-opt-ws-')),
  }
}

async function optFixture(options = {}) {
  const harness = optHarness()
  const roots = await freshRoots()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = roots.dshHome
  const restore = () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  if (options.pluginForge) harness.ctx.provide('pluginForge', options.pluginForge)
  const fiber = harness.ctx.plugin(HarnessOptRuntime)
  await fiber
  const agent = {
    id: 'agent-opt',
    ctx: harness.ctx,
    session: { header: { cwd: roots.workspace } },
  }
  const tool = harness.registeredTools.get('opt_control')
  const exec = { agent, signal: new AbortController().signal }
  return { harness, roots, agent, tool, exec, restore, fiber }
}

function pluginRef() {
  return capabilityRef('plugin', 'forged/user/forged-echo')
}

async function plantForgedPlugin(roots, slug = 'forged-echo') {
  const document = validateForgedPluginInput({
    slug,
    summary: 'Provide a tiny echo service for tests.',
    manifest: { name: slug, provide: ['forgedEcho'], inject: [] },
    intendedEffects: ['provide the forgedEcho service'],
    source: ECHO_SOURCE.replaceAll('forged-echo', slug),
  })
  const plan = planForgedPluginWrite(document, 'user')
  await commitForgedPluginWrite(resolveForgedPluginTarget('user', slug, roots), plan)
}

async function plantGap(dshHome, query = 'pdf ocr table extraction') {
  await appendCapabilityGap(dshHome, {
    query,
    kinds: ['tool'],
    hitCount: 0,
    skillsComplete: true,
  })
}

function scoreOf(suite, snapshot_digest, intervention, overrides = {}) {
  const assertions = overrides.assertions ?? [{ id: 'digest-stable', pass: true }]
  const pass = overrides.pass ?? assertions.every((item) => item.pass)
  return {
    task_id: 'snapshot-stable',
    snapshot_digest,
    condition_digest: conditionDigest(snapshot_digest, intervention),
    suite_digest: suite,
    intervention,
    pass,
    assertions,
    tokens: { input: 0, output: 0 },
    duration_ms: 1,
  }
}

async function writeScoreRun(evalRoots, suite, snapshot_digest, intervention, overrides = {}) {
  return writeRun(evalRoots, {
    task_id: 'snapshot-stable',
    snapshot_digest,
    suite_digest: suite,
    intervention,
    score: scoreOf(suite, snapshot_digest, intervention, overrides),
    tree: {
      task_id: 'snapshot-stable',
      suite_digest: suite,
      plan: { skills: ['assert-snapshot-stable'], skip: [] },
      nodes: [],
    },
    traces: [],
    meta: {},
  })
}

async function plantSnapshots(evalRoots, ref) {
  const first = await writeSnapshot(
    evalRoots,
    { skills: [], plugins: [{ ref, digest: 'a'.repeat(64), revision: 1 }], patch_digest: '' },
    { files: [{ ref, bytes: Buffer.from(ECHO_SOURCE) }] },
  )
  const second = await writeSnapshot(
    evalRoots,
    { skills: [], plugins: [{ ref, digest: 'b'.repeat(64), revision: 2 }], patch_digest: '' },
    { files: [{ ref, bytes: Buffer.from(`${ECHO_SOURCE}\n// rev2\n`) }] },
  )
  return { first, second }
}

async function plantPromotionGates(evalRoots, ref) {
  const suite = await bundledSuiteDigest(evalRoots)
  const { first, second } = await plantSnapshots(evalRoots, ref)
  const baseline = await writeScoreRun(evalRoots, suite, first.digest, null)
  const candidate = await writeScoreRun(evalRoots, suite, second.digest, null)
  const diff = compareScores({
    mode: 'diff',
    baseline: { ...scoreOf(suite, first.digest, null), run_id: baseline.run_id },
    candidate: { ...scoreOf(suite, second.digest, null), run_id: candidate.run_id },
  })
  await writeCompare(evalRoots, evalSha256Hex(evalCanonical(diff)), diff)

  const intervention = { op: 'ablate', target: ref }
  const intact = await writeScoreRun(evalRoots, suite, first.digest, null)
  const ablated = await writeScoreRun(evalRoots, suite, first.digest, intervention, {
    pass: false,
    assertions: [{ id: 'digest-stable', pass: false }],
  })
  const ablate = compareScores({
    mode: 'ablate',
    baseline: { ...scoreOf(suite, first.digest, null), run_id: intact.run_id },
    candidate: {
      ...scoreOf(suite, first.digest, intervention, {
        pass: false,
        assertions: [{ id: 'digest-stable', pass: false }],
      }),
      run_id: ablated.run_id,
    },
    target: ref,
  })
  await writeCompare(evalRoots, evalSha256Hex(evalCanonical(ablate)), ablate)
  return { suite, first, second }
}

async function plantIgnoredAblate(evalRoots, ref) {
  const suite = await bundledSuiteDigest(evalRoots)
  const { first } = await plantSnapshots(evalRoots, ref)
  const intervention = { op: 'ablate', target: ref }
  const intact = await writeScoreRun(evalRoots, suite, first.digest, null)
  const ablated = await writeScoreRun(evalRoots, suite, first.digest, intervention)
  const ablate = compareScores({
    mode: 'ablate',
    baseline: { ...scoreOf(suite, first.digest, null), run_id: intact.run_id },
    candidate: { ...scoreOf(suite, first.digest, intervention), run_id: ablated.run_id },
    target: ref,
  })
  await writeCompare(evalRoots, evalSha256Hex(evalCanonical(ablate)), ablate)
  return { suite, first }
}

async function plantRegress(evalRoots, suite, first, second) {
  const baseline = await writeScoreRun(evalRoots, suite, first.digest, null)
  const candidate = await writeScoreRun(evalRoots, suite, second.digest, null, {
    pass: false,
    assertions: [{ id: 'digest-stable', pass: false }],
  })
  const diff = compareScores({
    mode: 'diff',
    baseline: { ...scoreOf(suite, first.digest, null), run_id: baseline.run_id },
    candidate: {
      ...scoreOf(suite, second.digest, null, {
        pass: false,
        assertions: [{ id: 'digest-stable', pass: false }],
      }),
      run_id: candidate.run_id,
    },
  })
  await writeCompare(evalRoots, evalSha256Hex(evalCanonical(diff)), diff)
  return diff
}

test('opt_control action enum is suggest and show', () => {
  assert.deepEqual([...OPT_CONTROL_ACTIONS], ['suggest', 'show'])
  assert.deepEqual(parseOptControlRequest({ action: 'suggest' }), { action: 'suggest' })
  assert.deepEqual(parseOptControlRequest({ action: 'show' }), { action: 'show' })
  for (const action of ['apply', 'train', 'optimize', 'judge', 'promote']) {
    assert.throws(() => parseOptControlRequest({ action }), new RegExp(action))
  }
})

test('gapCoveredBySlug uses token overlap', () => {
  assert.equal(gapCoveredBySlug('pdf ocr table extraction', 'pdf-ocr'), true)
  assert.equal(gapCoveredBySlug('pdf ocr table extraction', 'forged-echo'), false)
})

test('empty store suggests noop', async () => {
  const { tool, exec, restore, fiber, roots } = await optFixture()
  try {
    const suggested = JSON.parse(await tool.execute({ action: 'suggest' }, exec))
    assert.equal(suggested.action, 'suggest')
    assert.equal(suggested.data.arm, 'noop')
    assert.equal(Object.hasOwn(suggested.data, 'summary'), false)
    assert.ok(suggested.next.some((item) => item.tool === 'opt_control'))
  } finally {
    restore()
    await fiber.dispose()
    await rm(roots.dshHome, { recursive: true, force: true })
    await rm(roots.workspace, { recursive: true, force: true })
  }
})

test('authoritative gap only suggests prepare_forge', async () => {
  const { tool, exec, restore, fiber, roots } = await optFixture()
  try {
    await plantGap(roots.dshHome)
    const suggested = JSON.parse(await tool.execute({ action: 'suggest' }, exec))
    assert.equal(suggested.data.arm, 'prepare_forge')
    assert.equal(suggested.data.query, 'pdf ocr table extraction')
    assert.ok(suggested.next.some((item) => item.tool === 'plugin_forge'))
    assert.match(suggested.next[0].instruction, /prepare_forge/)
    assert.match(suggested.next[0].instruction, /does not write source/)
  } finally {
    restore()
    await fiber.dispose()
    await rm(roots.dshHome, { recursive: true, force: true })
    await rm(roots.workspace, { recursive: true, force: true })
  }
})

test('plugin with both eval gates suggests prepare_promote over a gap', async () => {
  const { tool, exec, restore, fiber, roots } = await optFixture()
  try {
    await plantForgedPlugin(roots)
    await plantGap(roots.dshHome)
    await plantPromotionGates({ ...roots, bundledTasks: bundledTasksDir() }, pluginRef())
    const suggested = JSON.parse(await tool.execute({ action: 'suggest' }, exec))
    assert.equal(suggested.data.arm, 'prepare_promote')
    assert.equal(suggested.data.target, pluginRef())
    assert.equal(suggested.next[0].tool, 'plugin_forge')
    assert.equal(suggested.next[0].action, 'prepare_promote')
  } finally {
    restore()
    await fiber.dispose()
    await rm(roots.dshHome, { recursive: true, force: true })
    await rm(roots.workspace, { recursive: true, force: true })
  }
})

test('active plugin with ignored ablate suggests prepare_unload', async () => {
  const { tool, exec, restore, fiber, roots } = await optFixture({
    pluginForge: { list: () => [{ id: 'forged-echo' }] },
  })
  try {
    await plantForgedPlugin(roots)
    await plantIgnoredAblate({ ...roots, bundledTasks: bundledTasksDir() }, pluginRef())
    const suggested = JSON.parse(await tool.execute({ action: 'suggest' }, exec))
    assert.equal(suggested.data.arm, 'prepare_unload')
    assert.equal(suggested.data.target, pluginRef())
    assert.equal(suggested.next[0].action, 'prepare_unload')
  } finally {
    restore()
    await fiber.dispose()
    await rm(roots.dshHome, { recursive: true, force: true })
    await rm(roots.workspace, { recursive: true, force: true })
  }
})

test('a matching regress compare credits a promote loss and prefers forge', async () => {
  const { tool, exec, restore, fiber, roots } = await optFixture()
  try {
    await plantForgedPlugin(roots)
    await plantGap(roots.dshHome)
    const evalRoots = { ...roots, bundledTasks: bundledTasksDir() }
    const planted = await plantPromotionGates(evalRoots, pluginRef())
    const first = JSON.parse(await tool.execute({ action: 'suggest' }, exec))
    assert.equal(first.data.arm, 'prepare_promote')
    await plantRegress(evalRoots, planted.suite, planted.first, planted.second)
    const second = JSON.parse(await tool.execute({ action: 'suggest' }, exec))
    assert.equal(second.data.arm, 'prepare_forge')
    assert.ok(second.data.arms.prepare_promote.losses >= 1)
    assert.ok(second.data.credited >= 1)
  } finally {
    restore()
    await fiber.dispose()
    await rm(roots.dshHome, { recursive: true, force: true })
    await rm(roots.workspace, { recursive: true, force: true })
  }
})

test('show returns the policy file and no narrative summary', async () => {
  const { tool, exec, restore, fiber, roots, harness } = await optFixture()
  try {
    await tool.execute({ action: 'suggest' }, exec)
    const shown = JSON.parse(await tool.execute({ action: 'show' }, exec))
    assert.equal(shown.action, 'show')
    assert.equal(shown.data.policy.version, 1)
    assert.equal(shown.data.policy.last.arm, 'noop')
    assert.equal(Object.hasOwn(shown.data, 'summary'), false)
    assert.ok(shown.files.some((file) => file.kind === 'policy'))
    assert.ok(harness.registeredCommands.get('omd-opt'))
  } finally {
    restore()
    await fiber.dispose()
    await rm(roots.dshHome, { recursive: true, force: true })
    await rm(roots.workspace, { recursive: true, force: true })
  }
})

test('capability_search finds tool:opt_control after mount', async () => {
  const harness = optHarness()
  harness.ctx.provide('skills', {
    snapshot: async () => ({ complete: true, skills: [] }),
  })
  harness.ctx.provide('mcpControl', { list: () => [] })
  harness.ctx.provide('pluginControl', { list: () => [] })
  await harness.ctx.plugin(HarnessOptRuntime)
  await harness.ctx.plugin(CapabilityDiscoveryRuntime)
  const search = harness.registeredTools.get('capability_search')
  const agent = {
    id: 'agent-opt',
    ctx: harness.ctx,
    session: { header: { cwd: '/workspace' } },
  }
  const output = JSON.parse(
    await search.execute(
      { action: 'search', query: 'opt_control durable policy', kinds: 'tool', limit: 12 },
      { agent, signal: new AbortController().signal },
    ),
  )
  assert.ok(output.hits.some((hit) => hit.ref === 'tool:opt_control'))
  await harness.ctx.root.fiber.dispose()
})

test('opt_control never writes the curated catalog', async () => {
  const { tool, exec, restore, fiber, roots } = await optFixture()
  const catalogBefore = await readFile(CATALOG)
  try {
    await plantGap(roots.dshHome)
    await tool.execute({ action: 'suggest' }, exec)
    await tool.execute({ action: 'show' }, exec)
    const catalogAfter = await readFile(CATALOG)
    assert.deepEqual(catalogAfter, catalogBefore)
  } finally {
    restore()
    await fiber.dispose()
    await rm(roots.dshHome, { recursive: true, force: true })
    await rm(roots.workspace, { recursive: true, force: true })
  }
})
