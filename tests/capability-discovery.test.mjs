import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'

import {
  buildCommandCapability,
  buildMcpCapability,
  buildPluginCapability,
  buildSkillCapability,
  buildToolCapability,
  capabilityRef,
  parseCapabilityRef,
  scoreCapability,
  searchCapabilities,
  showCapability,
} from '../dist/packages/capability-discovery/src/catalog.js'
import {
  default as CapabilityDiscoveryRuntime,
  aggregateCapabilities,
  formatCapabilityHits,
} from '../dist/packages/capability-discovery/src/index.js'

function fixtureCatalog() {
  return [
    buildToolCapability({
      name: 'hash_edit',
      description: 'Stale-safe multi-line file replacement using hashline anchors.',
    }),
    buildToolCapability({
      name: 'bash',
      description: 'Run a shell command in the workspace.',
    }),
    buildSkillCapability({
      name: 'systematic-debugging',
      description: 'Investigate failures with evidence before changing code.',
      whenToUse: 'when a bug or test failure appears',
      modelInvocable: true,
      userInvocable: true,
      provider: 'bundled',
      source: 'omd',
    }),
    buildCommandCapability({
      name: 'omd-mcp',
      description: 'List inert and active MCP servers.',
      inputHint: 'optional search query',
    }),
    buildMcpCapability({
      name: 'omd-playwright',
      status: 'inactive',
      source: 'preset',
      transport: 'stdio',
      endpoint: 'npx',
      cachedTools: [
        {
          name: 'browser_navigate',
          description: 'Open a URL in a real Chromium browser tab.',
        },
        {
          name: 'browser_click',
          description: 'Click an element in the browser page.',
        },
      ],
    }),
    buildMcpCapability({
      name: 'omd-memory',
      status: 'active',
      source: 'preset',
      transport: 'stdio',
      endpoint: 'npx',
      cachedTools: [{ name: 'create_entities', description: 'Create knowledge-graph entities.' }],
    }),
    buildPluginCapability({
      id: 'dsh-skill-badge',
      module: '@deepseek-ai/dsh-skill-badge',
      version: '0.1.0-rc.6',
      summary: 'Expose the upstream dsh-badge skill for attribution.',
      risk: 'Adds model-visible instructions that may insert DeepSeek attribution.',
      source: 'upstream',
      active: false,
      availability: 'available',
    }),
  ]
}

test('capabilityRef and parseCapabilityRef round-trip stable ids', () => {
  assert.equal(capabilityRef('tool', 'hash_edit'), 'tool:hash_edit')
  assert.equal(capabilityRef('mcp', 'omd-playwright'), 'mcp:omd-playwright')
  assert.equal(capabilityRef('plugin', 'dsh-skill-badge'), 'plugin:dsh-skill-badge')
  assert.deepEqual(parseCapabilityRef('skill:systematic-debugging'), {
    kind: 'skill',
    id: 'systematic-debugging',
  })
  assert.equal(capabilityRef('mcp', ' browser '), 'mcp:%20browser%20')
  assert.deepEqual(parseCapabilityRef('mcp:%20browser%20'), {
    kind: 'mcp',
    id: ' browser ',
  })
  assert.throws(() => capabilityRef('tool', ''), /id/i)
  assert.throws(() => parseCapabilityRef('not-a-ref'), /invalid/i)
  assert.throws(() => parseCapabilityRef('unknown:thing'), /invalid/i)
  assert.throws(() => parseCapabilityRef('constructor:thing'), /invalid/i)
})

test('builders attach exact next-action instructions for each kind', () => {
  const tool = buildToolCapability({ name: 'bash', description: 'Shell.' })
  assert.equal(tool.nextAction.kind, 'use')
  assert.match(tool.nextAction.instruction, /bash/i)

  const skill = buildSkillCapability({
    name: 'review-changes',
    description: 'Review the diff.',
    modelInvocable: true,
    userInvocable: true,
    provider: 'bundled',
    source: 'omd',
  })
  assert.equal(skill.nextAction.tool, 'skill')
  assert.deepEqual(skill.nextAction.args, { name: 'review-changes' })

  const command = buildCommandCapability({
    name: 'omd-plugins',
    description: 'List organs.',
  })
  assert.match(command.nextAction.instruction, /\/omd-plugins/)

  const inactiveMcp = buildMcpCapability({
    name: 'omd-playwright',
    status: 'inactive',
    source: 'preset',
    transport: 'stdio',
    endpoint: 'npx',
  })
  assert.equal(inactiveMcp.nextAction.kind, 'activate')
  assert.deepEqual(inactiveMcp.nextAction.args, {
    action: 'prepare_activate',
    server_name: 'omd-playwright',
  })

  const activeMcp = buildMcpCapability({
    name: 'omd-memory',
    status: 'active',
    source: 'preset',
    transport: 'stdio',
    endpoint: 'npx',
  })
  assert.equal(activeMcp.nextAction.kind, 'deactivate')
  assert.deepEqual(activeMcp.nextAction.args, {
    action: 'prepare_deactivate',
    server_name: 'omd-memory',
  })

  const plugin = buildPluginCapability({
    id: 'dsh-skill-badge',
    module: '@deepseek-ai/dsh-skill-badge',
    version: '0.1.0-rc.6',
    summary: 'Badge.',
    risk: 'Attribution text.',
    source: 'upstream',
    active: false,
    availability: 'available',
  })
  assert.equal(plugin.nextAction.kind, 'load')
  assert.deepEqual(plugin.nextAction.args, {
    action: 'prepare_load',
    plugin_id: 'dsh-skill-badge',
  })

  const activePlugin = buildPluginCapability({
    id: 'dsh-skill-badge',
    module: '@deepseek-ai/dsh-skill-badge',
    version: '0.1.0-rc.6',
    summary: 'Badge.',
    risk: 'Attribution text.',
    source: 'upstream',
    active: true,
    availability: 'available',
  })
  assert.equal(activePlugin.nextAction.kind, 'unload')
  assert.deepEqual(activePlugin.nextAction.args, {
    action: 'prepare_unload',
    plugin_id: 'dsh-skill-badge',
  })
})

test('search ranks exact id matches above summary-only hits', () => {
  const catalog = fixtureCatalog()
  const hits = searchCapabilities(catalog, 'bash')
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].ref, 'tool:bash')
  assert.ok(hits[0].score > scoreCapability(catalog[0], 'bash'))
})

test('search retrieves inactive MCP from cached browser tool metadata', () => {
  const hits = searchCapabilities(fixtureCatalog(), 'browser navigate chromium')
  assert.ok(hits.some((hit) => hit.ref === 'mcp:omd-playwright'))
  const playwright = hits.find((hit) => hit.ref === 'mcp:omd-playwright')
  assert.equal(playwright?.status, 'inactive')
  assert.equal(playwright?.nextAction.tool, 'mcp_control')
  assert.deepEqual(playwright?.nextAction.args, {
    action: 'prepare_activate',
    server_name: 'omd-playwright',
  })
})

test('search filters by kind and respects the result limit', () => {
  const catalog = fixtureCatalog()
  const toolsOnly = searchCapabilities(catalog, 'edit', { kinds: ['tool'] })
  assert.ok(toolsOnly.every((hit) => hit.kind === 'tool'))

  const limited = searchCapabilities(catalog, 'a', { limit: 2 })
  assert.equal(limited.length, 2)
})

test('search ties break deterministically by kind then id', () => {
  const twins = [
    buildToolCapability({ name: 'alpha', description: 'shared token zebra' }),
    buildToolCapability({ name: 'beta', description: 'shared token zebra' }),
    buildSkillCapability({
      name: 'alpha',
      description: 'shared token zebra',
      modelInvocable: true,
      userInvocable: true,
      provider: 'test',
      source: 'test',
    }),
  ]
  const hits = searchCapabilities(twins, 'zebra')
  assert.deepEqual(
    hits.map((hit) => hit.ref),
    ['skill:alpha', 'tool:alpha', 'tool:beta'],
  )
})

test('showCapability resolves a stable ref and rejects unknown refs', () => {
  const catalog = fixtureCatalog()
  const shown = showCapability(catalog, 'plugin:dsh-skill-badge')
  assert.equal(shown?.id, 'dsh-skill-badge')
  assert.match(shown?.risk ?? '', /attribution/i)
  assert.equal(showCapability(catalog, 'plugin:missing'), undefined)
})

test('incomplete skills surface an incomplete status', () => {
  const skill = buildSkillCapability({
    name: 'pending-skill',
    description: 'Still scanning.',
    modelInvocable: true,
    userInvocable: true,
    provider: 'local',
    source: 'project',
    complete: false,
  })
  assert.equal(skill.status, 'incomplete')
  assert.equal(skill.details?.complete, false)
})

test('MCP and plugin builders never embed credential-like endpoint details beyond redacted views', () => {
  const mcp = buildMcpCapability({
    name: 'remote',
    status: 'inactive',
    source: 'user',
    transport: 'sse',
    endpoint: 'https://example.com/mcp',
  })
  assert.equal(mcp.summary.includes('token='), false)
  assert.equal(JSON.stringify(mcp).includes('SECRET'), false)

  const plugin = buildPluginCapability({
    id: 'safe',
    module: '@example/safe',
    version: '1.0.0',
    summary: 'Safe.',
    risk: 'In-process privileges.',
    source: 'oh-my-dsh',
    active: false,
    availability: 'not-installed',
  })
  assert.equal(plugin.status, 'not-installed')
  assert.equal(plugin.nextAction.kind, 'unavailable')
  assert.equal(plugin.nextAction.tool, undefined)
  assert.equal(plugin.nextAction.args, undefined)
  assert.match(plugin.nextAction.instruction, /exact reviewed version/i)
})

test('Unicode queries match Unicode content instead of every capability', () => {
  const catalog = [
    buildToolCapability({
      name: 'browser',
      description: '浏览器自动化与页面交互。',
    }),
    buildToolCapability({
      name: 'bash',
      description: 'Run shell commands.',
    }),
  ]
  assert.deepEqual(
    searchCapabilities(catalog, '浏览器').map((hit) => hit.ref),
    ['tool:browser'],
  )
  assert.deepEqual(searchCapabilities(catalog, '不存在的能力'), [])
})

test('BM25-style ranking favors rare discriminators and ignores repeated query terms', () => {
  const catalog = [
    buildToolCapability({ name: 'alpha', description: 'common rare-browser-capability' }),
    buildToolCapability({ name: 'common-tool', description: 'common generic utility' }),
    buildToolCapability({ name: 'gamma', description: 'common generic helper' }),
    buildToolCapability({ name: 'delta', description: 'common generic command' }),
  ]
  const ranked = searchCapabilities(catalog, 'common rare-browser-capability')
  assert.equal(ranked[0].ref, 'tool:alpha')

  const once = searchCapabilities(catalog, 'rare-browser-capability')[0]
  const repeated = searchCapabilities(
    catalog,
    'rare-browser-capability rare-browser-capability rare-browser-capability',
  )[0]
  assert.equal(repeated.ref, once.ref)
  assert.equal(repeated.score, once.score)
})

test('stable refs round-trip whitespace and reserved characters', () => {
  const entry = buildMcpCapability({
    name: ' browser:remote ',
    status: 'inactive',
    source: 'user',
    transport: 'stdio',
    endpoint: 'npx',
  })
  assert.equal(entry.ref, 'mcp:%20browser%3Aremote%20')
  assert.equal(showCapability([entry], entry.ref)?.id, ' browser:remote ')
})

test('search hits and MCP details stay bounded independently of result count', () => {
  const cachedTools = Array.from({ length: 500 }, (_, index) => ({
    name: `browser_tool_${index}_${'n'.repeat(300)}`,
    description: `browser automation ${index} ${'d'.repeat(2_000)}`,
  }))
  const entry = buildMcpCapability({
    name: 'huge-browser',
    status: 'inactive',
    source: 'user',
    transport: 'stdio',
    endpoint: 'npx',
    cachedTools,
  })

  assert.equal(entry.details.cachedToolCount, 500)
  assert.equal(entry.details.cachedToolsTruncated, true)
  assert.ok(entry.details.cachedTools.length <= 64)

  const [hit] = searchCapabilities([entry], 'browser', { limit: 1 })
  assert.equal(hit.details, undefined)
  assert.equal(hit.keywords, undefined)
  assert.ok(JSON.stringify(hit).length < 10_000)

  assert.throws(() => searchCapabilities([entry], 'browser', { limit: Number.NaN }), /limit/i)
})

function sampleSources(overrides = {}) {
  return {
    tools: [{ name: 'bash', description: 'Run shell commands.' }],
    skills: [
      {
        name: 'verify-before-done',
        description: 'Verify before claiming done.',
        whenToUse: 'before finishing a task',
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'bundled',
        source: 'omd',
      },
    ],
    skillsComplete: true,
    commands: [{ name: 'omd-mcp', description: 'List MCP servers.', input: { hint: 'query' } }],
    mcpServers: [
      {
        name: 'omd-playwright',
        source: 'preset',
        transport: 'stdio',
        endpoint: 'npx',
        status: 'inactive',
        cachedTools: [
          { name: 'browser_navigate', description: 'Open a URL in Chromium.' },
          { name: 'browser_click', description: 'Click a page element.' },
        ],
      },
    ],
    plugins: [
      {
        id: 'dsh-skill-badge',
        module: '@deepseek-ai/dsh-skill-badge',
        version: '0.1.0-rc.6',
        summary: 'Attribution skill.',
        risk: 'May insert DeepSeek attribution into generated content.',
        manifest: { name: 'skill-badge', provide: [], inject: ['skills'] },
        source: 'upstream',
        availability: {
          status: 'available',
          installedVersion: '0.1.0-rc.6',
          packageJsonPath: '/x',
        },
        active: false,
      },
    ],
    ...overrides,
  }
}

test('aggregateCapabilities indexes all five kinds with exact next actions', () => {
  const snapshot = aggregateCapabilities(sampleSources())
  assert.deepEqual(snapshot.counts, {
    tool: 1,
    skill: 1,
    command: 1,
    mcp: 1,
    plugin: 1,
  })
  assert.equal(snapshot.skillsComplete, true)

  const refs = new Set(snapshot.capabilities.map((entry) => entry.ref))
  assert.ok(refs.has('tool:bash'))
  assert.ok(refs.has('skill:verify-before-done'))
  assert.ok(refs.has('command:omd-mcp'))
  assert.ok(refs.has('mcp:omd-playwright'))
  assert.ok(refs.has('plugin:dsh-skill-badge'))

  const mcp = showCapability(snapshot.capabilities, 'mcp:omd-playwright')
  assert.deepEqual(mcp?.nextAction.args, {
    action: 'prepare_activate',
    server_name: 'omd-playwright',
  })
  const plugin = showCapability(snapshot.capabilities, 'plugin:dsh-skill-badge')
  assert.deepEqual(plugin?.nextAction.args, {
    action: 'prepare_load',
    plugin_id: 'dsh-skill-badge',
  })
})

test('aggregateCapabilities is read-only over the provided snapshots', () => {
  const sources = sampleSources()
  const frozenTools = Object.freeze([...sources.tools])
  const frozenMcp = Object.freeze(sources.mcpServers.map((entry) => Object.freeze({ ...entry })))
  const snapshot = aggregateCapabilities({
    ...sources,
    tools: frozenTools,
    mcpServers: frozenMcp,
  })
  assert.equal(snapshot.capabilities.length, 5)
  assert.equal(sources.mcpServers[0].status, 'inactive')
  assert.equal(sources.plugins[0].active, false)
})

test('fresh aggregation reflects MCP and plugin lifecycle status changes', () => {
  const inactive = aggregateCapabilities(sampleSources())
  assert.equal(showCapability(inactive.capabilities, 'mcp:omd-playwright')?.status, 'inactive')
  assert.equal(showCapability(inactive.capabilities, 'plugin:dsh-skill-badge')?.status, 'inactive')

  const active = aggregateCapabilities(
    sampleSources({
      mcpServers: [
        {
          ...sampleSources().mcpServers[0],
          status: 'active',
        },
      ],
      plugins: [
        {
          ...sampleSources().plugins[0],
          active: true,
        },
      ],
    }),
  )
  const mcp = showCapability(active.capabilities, 'mcp:omd-playwright')
  const plugin = showCapability(active.capabilities, 'plugin:dsh-skill-badge')
  assert.equal(mcp?.status, 'active')
  assert.equal(mcp?.nextAction.kind, 'deactivate')
  assert.equal(plugin?.status, 'active')
  assert.equal(plugin?.nextAction.kind, 'unload')
})

test('incomplete skill snapshots are reported honestly', () => {
  const snapshot = aggregateCapabilities(sampleSources({ skillsComplete: false }))
  assert.equal(snapshot.skillsComplete, false)
  assert.equal(
    showCapability(snapshot.capabilities, 'skill:verify-before-done')?.status,
    'incomplete',
  )
  const hits = searchCapabilities(snapshot.capabilities, 'verify')
  const text = formatCapabilityHits(hits, { skillsComplete: false })
  assert.match(text, /incomplete/i)
  assert.match(formatCapabilityHits([], { skillsComplete: false }), /incomplete/i)
})

test('browser intent retrieves the inert Playwright MCP through aggregation', () => {
  const snapshot = aggregateCapabilities(sampleSources())
  const hits = searchCapabilities(snapshot.capabilities, 'browser chromium navigate')
  assert.ok(hits.some((hit) => hit.ref === 'mcp:omd-playwright'))
  const hit = hits.find((hit) => hit.ref === 'mcp:omd-playwright')
  assert.equal(hit.nextAction.tool, 'mcp_control')
  assert.doesNotMatch(JSON.stringify(hit), /SECRET|password|token=/i)
})

function runtimeHarness({ skillsSnapshot, onMcpList, onPluginList } = {}) {
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
      return [{ name: 'bash', description: 'Run shell commands.' }]
    },
  })
  ctx.provide('skills', {
    snapshot:
      skillsSnapshot ??
      (async () => ({
        complete: true,
        skills: [
          {
            name: 'verify-before-done',
            description: 'Verify before completion.',
            invocation: { modelInvocable: true, userInvocable: true },
            provider: 'test',
            source: 'test',
          },
        ],
      })),
  })
  ctx.provide('commands', {
    register(definition) {
      registeredCommands.set(definition.name, definition)
      return () => registeredCommands.delete(definition.name)
    },
    list() {
      return [{ name: 'omd-mcp', description: 'List MCP servers.' }]
    },
  })
  ctx.provide('systemPrompt', {
    section(section) {
      promptSections.push(section)
      return () => {}
    },
  })
  ctx.provide('mcpControl', {
    list() {
      onMcpList?.()
      return [
        {
          name: 'omd-playwright',
          source: 'preset',
          transport: 'stdio',
          endpoint: 'npx',
          status: 'inactive',
          cachedTools: [{ name: 'browser_navigate', description: 'Open a page in Chromium.' }],
        },
      ]
    },
  })
  ctx.provide('pluginControl', {
    list() {
      onPluginList?.()
      return []
    },
  })

  return { ctx, registeredTools, registeredCommands, promptSections }
}

function fakeAgent(ctx) {
  return {
    id: 'agent-test',
    ctx,
    session: { header: { cwd: '/workspace' } },
  }
}

test('runtime registers the tool, command, and prompt and searches real service snapshots', async () => {
  let mcpLists = 0
  let pluginLists = 0
  const harness = runtimeHarness({
    onMcpList: () => {
      mcpLists += 1
    },
    onPluginList: () => {
      pluginLists += 1
    },
  })
  const fiber = harness.ctx.plugin(CapabilityDiscoveryRuntime)
  await fiber

  const tool = harness.registeredTools.get('capability_search')
  const command = harness.registeredCommands.get('omd-capabilities')
  assert.ok(tool)
  assert.ok(command)
  assert.equal(harness.promptSections[0].name, 'omd:capability-discovery')

  const agent = fakeAgent(harness.ctx)
  const output = JSON.parse(
    await tool.execute(
      { action: 'search', query: 'browser chromium', kinds: 'mcp', limit: 5 },
      { agent, signal: new AbortController().signal },
    ),
  )
  assert.equal(output.hits[0].ref, 'mcp:omd-playwright')
  assert.equal(output.hits[0].nextAction.tool, 'mcp_control')
  assert.equal(mcpLists, 1)
  assert.equal(pluginLists, 1)

  const commandResult = await command.handler({
    agent,
    rawInput: ' browser',
    signal: new AbortController().signal,
  })
  assert.equal(commandResult.kind, 'success')
  assert.match(commandResult.text, /mcp:omd-playwright/)

  await harness.ctx.root.fiber.dispose()
})

test('runtime propagates tool and command cancellation without returning partial results', async () => {
  const skillsSnapshot = ({ signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  const harness = runtimeHarness({ skillsSnapshot })
  const fiber = harness.ctx.plugin(CapabilityDiscoveryRuntime)
  await fiber
  const agent = fakeAgent(harness.ctx)
  const tool = harness.registeredTools.get('capability_search')
  const command = harness.registeredCommands.get('omd-capabilities')

  const toolAbort = new AbortController()
  const toolRun = tool.execute(
    { action: 'search', query: 'browser' },
    { agent, signal: toolAbort.signal },
  )
  toolAbort.abort(new Error('tool cancelled'))
  await assert.rejects(toolRun, /tool cancelled/)

  const commandAbort = new AbortController()
  const commandRun = command.handler({
    agent,
    rawInput: ' browser',
    signal: commandAbort.signal,
  })
  commandAbort.abort(new Error('command cancelled'))
  await assert.rejects(commandRun, /command cancelled/)

  await harness.ctx.root.fiber.dispose()
})
