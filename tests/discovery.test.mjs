import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  discoverInstructions,
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
    assert.deepEqual(sources.map((source) => source.body), ['global rule', 'project rule'])
    const rendered = renderInstructions(sources, project, 10_000, home)
    assert.match(rendered, /global rule/)
    assert.match(rendered, /project rule/)
    assert.doesNotMatch(rendered, /scoped rule/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('imports project MCP definitions and expands environment placeholders', () => {
  const { root, home, project } = fixture()
  const previous = process.env.OMD_TEST_TOKEN
  process.env.OMD_TEST_TOKEN = 'secret-value'
  try {
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: {
        docs: {
          command: 'node',
          args: ['server.js'],
          env: { TOKEN: '${env:OMD_TEST_TOKEN}' },
        },
      },
    }))
    const servers = discoverMcpServers(project, home)
    assert.equal(servers.docs.command, 'node')
    assert.deepEqual(servers.docs.args, ['server.js'])
    assert.equal(servers.docs.env.TOKEN, 'secret-value')
  } finally {
    if (previous === undefined) delete process.env.OMD_TEST_TOKEN
    else process.env.OMD_TEST_TOKEN = previous
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
