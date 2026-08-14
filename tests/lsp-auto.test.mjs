import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverServers } from '../dist/packages/lsp-auto/src/index.js'

test('bundled language servers are discovered with non-overlapping routes', () => {
  const servers = discoverServers()
  assert.ok(servers.typescript)
  assert.ok(servers.python)
  assert.ok(servers.json)
  assert.ok(servers.yaml)
  assert.equal(servers.typescript.extensionToLanguage['.ts'], 'typescript')
  assert.equal(servers.python.extensionToLanguage['.py'], 'python')
})
