import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as Discovery from '../dist/packages/discovery/src/index.js'
import {
  discoverInstructions,
  discoverMcpCatalog,
  discoverMcpServers,
  normalizeMcpServerName,
  renderInstructions,
} from '../dist/packages/discovery/src/index.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omd-discovery-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(join(project, '.cursor', 'rules'), { recursive: true })
  return { root, home, project }
}

test('discovers global and always-on Cursor instructions but skips scoped rules', () => {
  const { root, home, project } = fixture()
  try {
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'global rule')
    writeFileSync(
      join(project, '.cursor', 'rules', 'always.mdc'),
      '---\nalwaysApply: true\n---\nproject rule',
    )
    writeFileSync(
      join(project, '.cursor', 'rules', 'scoped.mdc'),
      '---\nglobs: "*.ts"\nalwaysApply: false\n---\nscoped rule',
    )
    const sources = discoverInstructions(project, home)
    assert.deepEqual(
      sources.map((source) => source.body),
      ['global rule', 'project rule'],
    )
    const rendered = renderInstructions(sources, project, 10_000, home)
    assert.match(rendered, /global rule/)
    assert.match(rendered, /project rule/)
    assert.doesNotMatch(rendered, /scoped rule/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('imports project MCP definitions without expanding environment placeholders', () => {
  const { root, home, project } = fixture()
  const previous = process.env.OMD_TEST_TOKEN
  process.env.OMD_TEST_TOKEN = 'secret-value'
  try {
    writeFileSync(
      join(project, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          docs: {
            command: 'node',
            args: ['server.js'],
            env: { TOKEN: '${env:OMD_TEST_TOKEN}' },
          },
        },
      }),
    )
    const servers = discoverMcpServers(project, home)
    assert.equal(servers.docs.command, 'node')
    assert.deepEqual(servers.docs.args, ['server.js'])
    assert.equal(servers.docs.env.TOKEN, '${env:OMD_TEST_TOKEN}')
    assert.equal(servers.docs.configPath, join(project, '.mcp.json'))
  } finally {
    if (previous === undefined) delete process.env.OMD_TEST_TOKEN
    else process.env.OMD_TEST_TOKEN = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('lazy MCP catalog excludes untrusted project servers and labels trusted sources', () => {
  const { root, home, project } = fixture()
  try {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          userDocs: { command: 'node', args: ['user.js'] },
        },
      }),
    )
    writeFileSync(
      join(project, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          projectDocs: { command: 'node', args: ['project.js'] },
        },
      }),
    )

    const untrusted = discoverMcpCatalog(project, home, false)
    assert.deepEqual(
      untrusted.map((server) => server.name),
      ['userDocs'],
    )
    assert.equal(untrusted[0].source, 'user')
    assert.equal(untrusted[0].configPath, join(home, '.claude.json'))

    const trusted = discoverMcpCatalog(project, home, true)
    assert.deepEqual(
      trusted.map((server) => server.name),
      ['projectDocs', 'userDocs'],
    )
    const projectServer = trusted.find((server) => server.name === 'projectDocs')
    assert.equal(projectServer.source, 'project')
    assert.equal(projectServer.configPath, join(project, '.mcp.json'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MCP namespaces remain distinct after sanitizing foreign server names', () => {
  const dotted = normalizeMcpServerName('project-12345678-foo.bar')
  const slashed = normalizeMcpServerName('project-12345678-foo/bar')
  assert.notEqual(dotted, slashed)
  assert.match(dotted, /^[A-Za-z0-9_-]{1,32}$/)
  assert.match(slashed, /^[A-Za-z0-9_-]{1,32}$/)
})

test('resume setup reads mcpControl from the host plugin, not the agent scope', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'omd-discovery-resume-'))
  const configured = []

  class SiblingMcpControl extends Service {
    constructor(ctx) {
      super(ctx, 'mcpControl')
    }
    async configure(agent, definitions) {
      configured.push({ id: agent.id, definitions })
    }
  }

  const host = new Context()
  function harness(ctx) {
    ctx.provide('skills', {})
    ctx.provide('tools', {})
    ctx.provide('commands', { register() {} })
    ctx.provide('shell', {})
    const start = async (options) => {
      const agent = {
        id: 'session-resume',
        inject() {},
        session: { header: { cwd: workspace }, events: [] },
      }
      const scope = createScope(ctx, agent)
      agent.ctx = scope.ctx
      await options.setup?.(scope.ctx)
      return { id: agent.id }
    }
    const agents = {
      create: start,
      resume: start,
    }
    ctx.provide('agents', agents)
  }

  try {
    await host.plugin(harness)
    await host.plugin(SiblingMcpControl)
    await host.plugin(Discovery, {
      skills: false,
      hooks: false,
      commands: false,
      instructions: false,
      mcp: false,
    })

    const agents = host.reflect.get('agents')
    await agents.resume({})
    assert.equal(configured.length, 1)
    assert.equal(configured[0].id, 'session-resume')
    assert.deepEqual(configured[0].definitions, [])
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})
