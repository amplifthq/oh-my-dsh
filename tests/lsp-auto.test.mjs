import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverServers, registerRefactorServers } from '../dist/packages/lsp-auto/src/index.js'

test('bundled language servers are discovered with non-overlapping routes', () => {
  const servers = discoverServers()
  assert.ok(servers.typescript)
  assert.ok(servers.python)
  assert.ok(servers.json)
  assert.ok(servers.yaml)
  assert.equal(servers.typescript.extensionToLanguage['.ts'], 'typescript')
  assert.equal(servers.python.extensionToLanguage['.py'], 'python')
})

test('discovered servers register with and dispose from the refactor seam', () => {
  const registrations = []
  const disposals = []
  const servers = {
    typescript: {
      command: 'tsserver',
      args: ['--stdio'],
      extensionToLanguage: { '.ts': 'typescript' },
    },
    python: {
      command: 'pyright',
      args: ['--stdio'],
      extensionToLanguage: { '.py': 'python' },
    },
  }
  const dispose = registerRefactorServers(
    {
      registerServer(id, config) {
        registrations.push([id, config])
        return () => disposals.push(id)
      },
    },
    servers,
  )

  assert.deepEqual(
    registrations.map(([id]) => id),
    ['typescript', 'python'],
  )
  dispose()
  assert.deepEqual(disposals, ['python', 'typescript'])
})

test('partial refactor server registration rolls back when a later server fails', () => {
  const disposals = []
  let calls = 0
  assert.throws(
    () =>
      registerRefactorServers(
        {
          registerServer(id) {
            calls += 1
            if (calls === 2) throw new Error('duplicate route')
            return () => disposals.push(id)
          },
        },
        {
          first: { command: 'first', extensionToLanguage: { '.a': 'a' } },
          second: { command: 'second', extensionToLanguage: { '.b': 'b' } },
        },
      ),
    /duplicate route/,
  )
  assert.deepEqual(disposals, ['first'])
})
