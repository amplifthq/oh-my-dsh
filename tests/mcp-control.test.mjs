import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  McpActivationController,
  McpCatalogStore,
  fingerprintServer,
  materializeMcpConfig,
  mcpServerNamespace,
  readMcpCache,
  redactedServerView,
  searchCatalog,
  settleLoadedMcpFiber,
  updateMcpCache,
  validCachedTools,
  writeMcpCache,
} from '../dist/packages/mcp-control/src/index.js'

const stdio = {
  name: 'docs',
  source: 'user',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  env: { TOKEN: '${env:OMD_MCP_TEST_TOKEN}' },
  cwd: '/workspace',
  configPath: '/home/user/.cursor/mcp.json',
}

test('MCP environment placeholders remain inert until materialization', () => {
  const previous = process.env.OMD_MCP_TEST_TOKEN
  process.env.OMD_MCP_TEST_TOKEN = 'resolved-secret'
  try {
    assert.equal(stdio.env.TOKEN, '${env:OMD_MCP_TEST_TOKEN}')
    const config = materializeMcpConfig(stdio, 'session-docs')
    assert.equal(config.transport, 'stdio')
    assert.equal(config.env.TOKEN, 'resolved-secret')
    assert.equal(stdio.env.TOKEN, '${env:OMD_MCP_TEST_TOKEN}')
  } finally {
    if (previous === undefined) delete process.env.OMD_MCP_TEST_TOKEN
    else process.env.OMD_MCP_TEST_TOKEN = previous
  }
})

test('server views expose executable targets while redacting credential values', () => {
  const view = redactedServerView({
    name: 'remote',
    source: 'project',
    transport: 'streamable-http',
    url: 'https://user:pass@example.com/signed/secret-path?token=secret',
    headers: { Authorization: 'Bearer secret' },
  })

  assert.equal(view.endpoint, 'https://example.com/signed/secret-path')
  assert.deepEqual(view.headerNames, ['Authorization'])
  assert.doesNotMatch(JSON.stringify(view), /user:pass|Bearer|token=secret|fingerprint/)
  const stdioView = redactedServerView({
    ...stdio,
    args: [
      'server.js',
      '--token',
      'argv-secret',
      '-H',
      'Authorization: Bearer header-secret',
      'API_KEY=assignment-secret',
      '--env',
      'SESSION_TOKEN=environment-secret',
      '-HAuthorization: Bearer combined-secret',
      '--header=Cookie: combined-cookie',
    ],
  })
  assert.equal(stdioView.endpoint, 'node')
  assert.equal(stdioView.argumentCount, 10)
  assert.deepEqual(stdioView.argumentPreview, [
    'server.js',
    '--token',
    '[redacted]',
    '-H',
    '[redacted]',
    'API_KEY=[redacted]',
    '--env',
    'SESSION_TOKEN=[redacted]',
    '-H[redacted]',
    '--header=[redacted]',
  ])
  assert.equal(stdioView.configPath, '/home/user/.cursor/mcp.json')
  assert.deepEqual(stdioView.environmentNames, ['TOKEN'])
  assert.doesNotMatch(
    JSON.stringify(stdioView),
    /argv-secret|header-secret|assignment-secret|environment-secret|combined-secret|combined-cookie|fingerprint/,
  )
})

test('fingerprints are stable but change with inert configuration', () => {
  const first = fingerprintServer(stdio)
  const reordered = fingerprintServer({
    ...stdio,
    env: { TOKEN: '${env:OMD_MCP_TEST_TOKEN}' },
  })
  const changed = fingerprintServer({ ...stdio, args: ['other.js'] })

  assert.equal(first, reordered)
  assert.notEqual(first, changed)
})

test('MCP namespaces remain distinct when punctuation normalizes identically', () => {
  const dotted = mcpServerNamespace('agent', 'docs.prod')
  const slashed = mcpServerNamespace('agent', 'docs/prod')
  const spaced = mcpServerNamespace('agent', 'docs prod')
  assert.equal(new Set([dotted, slashed, spaced]).size, 3)
})

test('catalog search ranks cached tool metadata without activating a server', () => {
  const entries = [
    {
      ...redactedServerView(stdio),
      cachedTools: [{ name: 'resolve-library-id', description: 'Resolve documentation libraries.' }],
    },
    {
      ...redactedServerView({ ...stdio, name: 'browser' }),
      cachedTools: [{ name: 'click', description: 'Click a browser element.' }],
    },
  ]

  assert.equal(searchCatalog(entries, 'documentation library')[0].name, 'docs')
  assert.equal(searchCatalog(entries, 'browser click')[0].name, 'browser')
})

test('cached metadata is ignored after a server fingerprint changes', () => {
  const fingerprint = fingerprintServer(stdio)
  const tools = [{ name: 'lookup', description: 'Look up documentation.' }]

  assert.deepEqual(validCachedTools({ fingerprint, tools }, fingerprint), tools)
  assert.deepEqual(validCachedTools({ fingerprint, tools }, 'different'), [])
  assert.deepEqual(validCachedTools(undefined, fingerprint), [])
})

test('catalog state is isolated by agent and tracks active fibers', () => {
  const store = new McpCatalogStore()
  const firstAgent = {}
  const secondAgent = {}
  const fiber = { dispose() {} }

  store.configure(firstAgent, [stdio])
  store.configure(secondAgent, [{ ...stdio, name: 'other' }])
  assert.equal(store.list(firstAgent)[0].status, 'inactive')
  assert.equal(store.list(secondAgent)[0].name, 'other')

  store.activate(firstAgent, 'docs', fiber, [{ name: 'lookup', description: 'Look up docs.' }])
  assert.equal(store.list(firstAgent)[0].status, 'active')
  assert.equal(store.active(firstAgent, 'docs')?.fiber, fiber)

  assert.equal(store.deactivate(firstAgent, 'docs')?.fiber, fiber)
  assert.equal(store.list(firstAgent)[0].status, 'inactive')
})

test('metadata cache round trips atomically with private permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-mcp-cache-'))
  const path = join(root, 'cache.json')
  const cache = {
    docs: {
      fingerprint: fingerprintServer(stdio),
      tools: [{ name: 'lookup', description: 'Look up docs.' }],
    },
  }
  try {
    writeMcpCache(path, cache)
    assert.deepEqual(readMcpCache(path), cache)
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('locked metadata updates merge latest entries and recover stale locks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-mcp-cache-update-'))
  const path = join(root, 'cache.json')
  try {
    await updateMcpCache(path, {
      docs: { fingerprint: 'docs-fingerprint', tools: [] },
    })
    await updateMcpCache(path, {
      browser: { fingerprint: 'browser-fingerprint', tools: [] },
    })
    assert.deepEqual(Object.keys(readMcpCache(path)).sort(), ['browser', 'docs'])

    writeFileSync(`${path}.lock`, 'held', { mode: 0o600 })
    const stale = new Date(Date.now() - 60_000)
    utimesSync(`${path}.lock`, stale, stale)
    await updateMcpCache(path, {
      other: { fingerprint: 'other-fingerprint', tools: [] },
    }, { staleMs: 1_000 })
    assert.deepEqual(Object.keys(readMcpCache(path)).sort(), ['browser', 'docs', 'other'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MCP loader is called only by explicit activation and deactivation disposes it', async () => {
  const store = new McpCatalogStore()
  const agent = {}
  let loads = 0
  let disposals = 0
  const controller = new McpActivationController(store, async (owner, definition, namespace) => {
    loads += 1
    assert.equal(owner, agent)
    assert.equal(definition.name, 'docs')
    assert.match(namespace, /^[A-Za-z0-9_-]{1,32}$/)
    return {
      fiber: { dispose: async () => { disposals += 1 } },
      tools: [{ name: 'lookup', description: 'Look up documentation.' }],
    }
  })

  await controller.configure(agent, [stdio])
  assert.equal(loads, 0)
  await controller.activate(agent, 'agent-one', 'docs', fingerprintServer(stdio))
  assert.equal(loads, 1)
  assert.equal(store.list(agent)[0].status, 'active')
  await controller.deactivate(agent, 'docs')
  assert.equal(disposals, 1)
  assert.equal(store.list(agent)[0].status, 'inactive')
})

test('reconfiguration and controller disposal cannot orphan active MCP fibers', async () => {
  const store = new McpCatalogStore()
  const firstAgent = {}
  const secondAgent = {}
  let disposals = 0
  const controller = new McpActivationController(store, async () => ({
    fiber: { dispose: async () => { disposals += 1 } },
    tools: [],
  }))

  await controller.configure(firstAgent, [stdio])
  await controller.configure(secondAgent, [{ ...stdio, name: 'other' }])
  await controller.activate(firstAgent, 'first', 'docs', fingerprintServer(stdio))
  await controller.activate(
    secondAgent,
    'second',
    'other',
    fingerprintServer({ ...stdio, name: 'other' }),
  )

  await controller.configure(firstAgent, [])
  assert.equal(disposals, 1)
  assert.deepEqual(store.list(firstAgent), [])

  await controller.disposeOwner(secondAgent)
  assert.equal(disposals, 2)
  assert.equal(store.list(secondAgent)[0].status, 'inactive')
  await controller.disposeAll()
})

test('activation rejects changed definitions and disposes a loaded race loser', async () => {
  const store = new McpCatalogStore()
  const agent = {}
  let finishLoad
  let disposals = 0
  const controller = new McpActivationController(store, () => new Promise((resolve) => {
    finishLoad = () => resolve({
      fiber: { dispose: async () => { disposals += 1 } },
      tools: [],
    })
  }))
  await controller.configure(agent, [stdio])
  const expectedFingerprint = fingerprintServer(stdio)
  const activating = controller.activate(agent, 'agent', 'docs', expectedFingerprint)
  await Promise.resolve()
  await controller.configure(agent, [{ ...stdio, args: ['changed.js'] }])
  finishLoad()

  await assert.rejects(activating, /changed since approval/)
  assert.equal(disposals, 1)
  assert.equal(store.list(agent)[0].status, 'inactive')
})

test('activation drains its loader after abort and disposes a late server', async () => {
  const store = new McpCatalogStore()
  const agent = {}
  const lifecycle = new AbortController()
  let finishLoad
  let disposals = 0
  const controller = new McpActivationController(store, () => new Promise((resolve) => {
    finishLoad = () => resolve({
      fiber: { dispose: async () => { disposals += 1 } },
      tools: [],
    })
  }))
  await controller.configure(agent, [stdio])
  const activating = controller.activate(
    agent,
    'agent',
    'docs',
    fingerprintServer(stdio),
    lifecycle.signal,
  )
  let settled = false
  let observedError
  const observed = activating.then(
    () => {
      settled = true
    },
    (error) => {
      settled = true
      observedError = error
    },
  )
  lifecycle.abort(new Error('cancel activation'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  finishLoad()
  await observed
  assert.match(observedError?.message ?? '', /cancel activation/)
  assert.equal(disposals, 1)
  assert.equal(store.list(agent)[0].status, 'inactive')
})

test('schema discovery failure disposes an already-started MCP fiber', async () => {
  let disposals = 0
  const fiber = {
    then(resolve) {
      return Promise.resolve(resolve(undefined))
    },
    async dispose() {
      disposals += 1
    },
  }

  await assert.rejects(
    settleLoadedMcpFiber(fiber, () => {
      throw new Error('schema registry failed')
    }),
    /schema registry failed/,
  )
  assert.equal(disposals, 1)
})

test('late loader rejection after abort is reported to cleanup diagnostics', async () => {
  const store = new McpCatalogStore()
  const agent = {}
  const lifecycle = new AbortController()
  const cleanupErrors = []
  let failLoad
  const controller = new McpActivationController(
    store,
    () => new Promise((_, reject) => {
      failLoad = reject
    }),
    (error) => cleanupErrors.push(error),
  )
  await controller.configure(agent, [stdio])
  const activating = controller.activate(
    agent,
    'agent',
    'docs',
    fingerprintServer(stdio),
    lifecycle.signal,
  )
  lifecycle.abort(new Error('cancel activation'))
  failLoad(new Error('fiber disposal failed'))
  await assert.rejects(activating, /cancel activation/)

  assert.equal(cleanupErrors.length, 1)
  assert.match(String(cleanupErrors[0]), /fiber disposal failed/)
})
