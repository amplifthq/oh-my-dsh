import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  applyWithRollback,
  planJournalRecovery,
  readRefactorJournal,
  writeRefactorJournal,
} from '../dist/packages/refactor/src/journal.js'
import {
  answerLspServerRequest,
  raceWithAbort,
  executeOneShotDiagnostics,
  executeOneShotRename,
} from '../dist/packages/refactor/src/lsp-client.js'
import {
  applyTextEdits,
  convertPositionEncoding,
  normalizeWorkspaceEdit,
} from '../dist/packages/refactor/src/workspace-edit.js'
import { RefactorServerRegistry } from '../dist/packages/refactor/src/index.js'
import {
  buildRefactorFilePlans,
  decodeRefactorText,
  RefactorReadBudget,
} from '../dist/packages/refactor/src/planner.js'

const renameEdit = {
  changes: {
    'file:///workspace/a.ts': [
      {
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 9 },
        },
        newText: 'newName',
      },
    ],
    'file:///workspace/b.ts': [
      {
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 3 },
        },
        newText: 'newName',
      },
    ],
  },
}

test('normalizes multi-file WorkspaceEdit changes in URI order', () => {
  const normalized = normalizeWorkspaceEdit(renameEdit)

  assert.deepEqual(
    normalized.map((document) => document.uri),
    ['file:///workspace/a.ts', 'file:///workspace/b.ts'],
  )
  assert.equal(normalized[0].edits[0].newText, 'newName')
})

test('normalizes text document edits but rejects resource operations', () => {
  const normalized = normalizeWorkspaceEdit({
    documentChanges: [
      {
        textDocument: { uri: 'file:///workspace/a.ts', version: 3 },
        edits: renameEdit.changes['file:///workspace/a.ts'],
      },
    ],
  })
  assert.equal(normalized[0].version, 3)

  assert.throws(
    () =>
      normalizeWorkspaceEdit({
        documentChanges: [
          {
            kind: 'rename',
            oldUri: 'file:///workspace/a.ts',
            newUri: 'file:///workspace/b.ts',
          },
        ],
      }),
    /resource operations are not supported/,
  )
})

test('applies UTF-16, UTF-8, and UTF-32 positions correctly', () => {
  const content = 'const 😀x = 1;\n'
  const edit = (character) => [
    {
      range: {
        start: { line: 0, character },
        end: { line: 0, character: character + 1 },
      },
      newText: 'y',
    },
  ]

  assert.equal(applyTextEdits(content, edit(8), 'utf-16'), 'const 😀y = 1;\n')
  assert.equal(applyTextEdits(content, edit(10), 'utf-8'), 'const 😀y = 1;\n')
  assert.equal(applyTextEdits(content, edit(7), 'utf-32'), 'const 😀y = 1;\n')
})

test('converts user UTF-16 coordinates to the server-selected encoding', () => {
  const content = '😀 old\n'
  assert.deepEqual(convertPositionEncoding(content, { line: 0, character: 3 }, 'utf-16', 'utf-8'), {
    line: 0,
    character: 5,
  })
  assert.deepEqual(
    convertPositionEncoding(content, { line: 0, character: 3 }, 'utf-16', 'utf-32'),
    { line: 0, character: 2 },
  )
})

test('rejects overlapping text edits', () => {
  assert.throws(
    () =>
      applyTextEdits(
        'abcdef',
        [
          {
            range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
            newText: 'x',
          },
          {
            range: { start: { line: 0, character: 3 }, end: { line: 0, character: 5 } },
            newText: 'y',
          },
        ],
        'utf-16',
      ),
    /overlapping/,
  )
})

test('rejects malformed WorkspaceEdit ranges and non-file URIs', () => {
  assert.throws(
    () =>
      normalizeWorkspaceEdit({
        changes: {
          'https://example.com/a.ts': [],
        },
      }),
    /file URI/,
  )
  assert.throws(
    () =>
      normalizeWorkspaceEdit({
        changes: {
          'file:///workspace/a.ts': [
            {
              range: {
                start: { line: -1, character: 0 },
                end: { line: 0, character: 0 },
              },
              newText: 'x',
            },
          ],
        },
      }),
    /non-negative/,
  )
})

const journal = {
  version: 1,
  id: 'refactor-1',
  cwd: '/workspace',
  status: 'applying',
  files: [
    {
      path: '/workspace/a.ts',
      before: 'old',
      after: 'new',
    },
  ],
}

test('recovery journals round trip with private permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-refactor-journal-'))
  const path = join(root, 'journal.json')
  try {
    writeRefactorJournal(path, journal)
    assert.deepEqual(readRefactorJournal(path), journal)
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('recovery restores only files still matching the applied content', () => {
  assert.deepEqual(
    planJournalRecovery(journal, {
      '/workspace/a.ts': 'new',
    }),
    [{ path: '/workspace/a.ts', content: 'old' }],
  )
  assert.deepEqual(
    planJournalRecovery(journal, {
      '/workspace/a.ts': 'old',
    }),
    [],
  )
  assert.throws(
    () =>
      planJournalRecovery(journal, {
        '/workspace/a.ts': 'unrelated',
      }),
    /changed after the refactor/,
  )
})

test('recoverable apply clears its journal after success', async () => {
  const contents = new Map([
    ['a.ts', 'old-a'],
    ['b.ts', 'old-b'],
  ])
  let saved = 0
  let cleared = 0
  await applyWithRollback(
    [
      { path: 'a.ts', before: 'old-a', after: 'new-a', version: 'a1' },
      { path: 'b.ts', before: 'old-b', after: 'new-b', version: 'b1' },
    ],
    {
      saveJournal: async () => {
        saved += 1
      },
      clearJournal: async () => {
        cleared += 1
      },
      write: async (file, content) => {
        contents.set(file.path, content)
        return `${file.path}-next`
      },
    },
  )

  assert.deepEqual(Object.fromEntries(contents), { 'a.ts': 'new-a', 'b.ts': 'new-b' })
  assert.equal(saved, 1)
  assert.equal(cleared, 1)
})

test('recoverable apply rolls back earlier writes after a later failure', async () => {
  const contents = new Map([
    ['a.ts', 'old-a'],
    ['b.ts', 'old-b'],
  ])
  let calls = 0
  let cleared = 0
  const phases = []
  await assert.rejects(
    applyWithRollback(
      [
        { path: 'a.ts', before: 'old-a', after: 'new-a', version: 'a1' },
        { path: 'b.ts', before: 'old-b', after: 'new-b', version: 'b1' },
      ],
      {
        saveJournal: async () => {},
        clearJournal: async () => {
          cleared += 1
        },
        write: async (file, content, _version, phase) => {
          calls += 1
          phases.push(phase)
          if (file.path === 'b.ts' && content === 'new-b') throw new Error('stale b')
          contents.set(file.path, content)
          return `${file.path}-${calls}`
        },
      },
    ),
    /stale b/,
  )

  assert.deepEqual(Object.fromEntries(contents), { 'a.ts': 'old-a', 'b.ts': 'old-b' })
  assert.equal(cleared, 1)
  assert.deepEqual(phases, ['apply', 'apply', 'rollback'])
})

test('recoverable apply tracks a published write before post-write observers run', async () => {
  const contents = new Map([['a.ts', 'old-a']])
  let cleared = 0
  await assert.rejects(
    applyWithRollback([{ path: 'a.ts', before: 'old-a', after: 'new-a', version: 'a1' }], {
      saveJournal: async () => {},
      clearJournal: async () => {
        cleared += 1
      },
      write: async (file, content) => {
        contents.set(file.path, content)
        return `${file.path}-${content}`
      },
      afterWrite: async (_file, _version, phase) => {
        if (phase === 'apply') throw new Error('observer failed')
      },
    }),
    /observer failed/,
  )

  assert.equal(contents.get('a.ts'), 'old-a')
  assert.equal(cleared, 1)
})

test('journal cleanup failure does not report a committed refactor as failed', async () => {
  const contents = new Map([['a.ts', 'old-a']])
  const result = await applyWithRollback(
    [{ path: 'a.ts', before: 'old-a', after: 'new-a', version: 'a1' }],
    {
      saveJournal: async () => {},
      clearJournal: async () => {
        throw new Error('journal is busy')
      },
      write: async (file, content) => {
        contents.set(file.path, content)
        return `${file.path}-next`
      },
    },
  )

  assert.equal(contents.get('a.ts'), 'new-a')
  assert.deepEqual(result, {
    journalCleared: false,
    warning: 'journal is busy',
  })
})

test('one-shot rename performs a bounded transient document lifecycle', async () => {
  const calls = []
  const connection = {
    async request(method, params) {
      calls.push(['request', method, params])
      if (method === 'initialize') {
        return { capabilities: { positionEncoding: 'utf-8', renameProvider: true } }
      }
      if (method === 'textDocument/rename') return renameEdit
      if (method === 'shutdown') return null
      throw new Error(`unexpected request ${method}`)
    },
    async notify(method, params) {
      calls.push(['notify', method, params])
    },
  }

  const result = await executeOneShotRename(connection, {
    processId: 123,
    workspaceUri: 'file:///workspace',
    documentUri: 'file:///workspace/a.ts',
    languageId: 'typescript',
    content: 'const old = 1\n',
    additionalDocuments: [
      {
        documentUri: 'file:///workspace/b.ts',
        languageId: 'typescript',
        content: 'export { old } from "./a"\n',
      },
    ],
    position: { line: 0, character: 6 },
    newName: 'newName',
    initializationOptions: { preferences: { includeInlayParameterNameHints: 'none' } },
  })

  assert.equal(result.encoding, 'utf-8')
  assert.deepEqual(calls[0][2].initializationOptions, {
    preferences: { includeInlayParameterNameHints: 'none' },
  })
  assert.deepEqual(
    calls.map((call) => `${call[0]}:${call[1]}`),
    [
      'request:initialize',
      'notify:initialized',
      'notify:textDocument/didOpen',
      'notify:textDocument/didOpen',
      'request:textDocument/rename',
      'notify:textDocument/didClose',
      'notify:textDocument/didClose',
      'request:shutdown',
      'notify:exit',
    ],
  )
  const opened = calls.filter((call) => call[1] === 'textDocument/didOpen')
  assert.equal(opened[1][2].textDocument.text, 'export { old } from "./a"\n')
})

test('LSP compatibility host rejects server-driven edits and commands', async () => {
  await assert.rejects(
    answerLspServerRequest(
      'workspace/applyEdit',
      {},
      {
        configuration: null,
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
      },
    ),
    /server-driven workspace edits are disabled/,
  )
  await assert.rejects(
    answerLspServerRequest(
      'workspace/executeCommand',
      {},
      {
        configuration: null,
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
      },
    ),
    /server request is not supported/,
  )
  assert.deepEqual(
    await answerLspServerRequest(
      'workspace/configuration',
      { items: [{}, {}] },
      {
        configuration: { lint: true },
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
      },
    ),
    [{ lint: true }, { lint: true }],
  )
  assert.deepEqual(
    await answerLspServerRequest(
      'workspace/workspaceFolders',
      {},
      {
        configuration: null,
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
      },
    ),
    [{ uri: 'file:///workspace', name: 'workspace' }],
  )
})

test('post-refactor diagnostics report pull results when supported', async () => {
  const connection = {
    async request(method) {
      if (method === 'initialize') {
        return { capabilities: { diagnosticProvider: { interFileDependencies: true } } }
      }
      if (method === 'textDocument/diagnostic') {
        return { kind: 'full', items: [{ message: 'Example warning', severity: 2 }] }
      }
      if (method === 'shutdown') return null
      throw new Error(`unexpected request ${method}`)
    },
    async notify() {},
  }

  const result = await executeOneShotDiagnostics(connection, {
    processId: 123,
    workspaceUri: 'file:///workspace',
    documentUri: 'file:///workspace/a.ts',
    languageId: 'typescript',
    content: 'const value = 1\n',
  })

  assert.equal(result.supported, true)
  assert.equal(result.items.length, 1)
})

test('LSP operations stop waiting when their lifecycle is aborted', async () => {
  const controller = new AbortController()
  const waiting = raceWithAbort(new Promise(() => {}), controller.signal, 'rename')
  controller.abort(new Error('plugin unloaded'))
  await assert.rejects(waiting, /plugin unloaded/)
})

test('refactor server routes are deterministic and dispose cleanly', () => {
  const registry = new RefactorServerRegistry()
  const dispose = registry.register('typescript', {
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact' },
  })

  assert.equal(registry.resolve('/workspace/example.ts')?.id, 'typescript')
  assert.equal(registry.resolve('/workspace/example.tsx')?.languageId, 'typescriptreact')
  assert.throws(
    () =>
      registry.register('other', {
        command: 'other',
        extensionToLanguage: { '.ts': 'typescript' },
      }),
    /already registered/,
  )
  dispose()
  assert.equal(registry.resolve('/workspace/example.ts'), undefined)
})

test('builds exact before and after plans for every LSP-edited file', async () => {
  const contents = {
    'file:///workspace/a.ts': {
      path: '/workspace/a.ts',
      content: 'const old = 1;\n',
      version: 'a1',
    },
    'file:///workspace/b.ts': {
      path: '/workspace/b.ts',
      content: 'import x\nold();\n',
      version: 'b1',
    },
  }
  const plans = await buildRefactorFilePlans(
    normalizeWorkspaceEdit(renameEdit),
    'utf-16',
    async (uri) => contents[uri],
  )

  assert.deepEqual(
    plans.map(({ path, before, after, version }) => ({
      path,
      before,
      after,
      version,
    })),
    [
      {
        path: '/workspace/a.ts',
        before: 'const old = 1;\n',
        after: 'const newName = 1;\n',
        version: 'a1',
      },
      {
        path: '/workspace/b.ts',
        before: 'import x\nold();\n',
        after: 'import x\nnewName();\n',
        version: 'b1',
      },
    ],
  )
})

test('refactor read budget caps file count, individual size, and aggregate size', () => {
  const budget = new RefactorReadBudget({
    maxFiles: 2,
    maxFileBytes: 4,
    maxTotalBytes: 6,
  })
  budget.accept('/workspace/a.ts', 3)
  budget.accept('/workspace/a.ts', 3)
  budget.accept('/workspace/b.ts', 3)
  assert.throws(() => budget.accept('/workspace/c.ts', 1), /more than 2 files/)

  const oversized = new RefactorReadBudget({
    maxFiles: 2,
    maxFileBytes: 4,
    maxTotalBytes: 8,
  })
  assert.throws(() => oversized.accept('/workspace/large.ts', 5), /exceeds 4 bytes/)

  const aggregate = new RefactorReadBudget({
    maxFiles: 3,
    maxFileBytes: 4,
    maxTotalBytes: 5,
  })
  aggregate.accept('/workspace/a.ts', 3)
  assert.throws(() => aggregate.accept('/workspace/b.ts', 3), /exceeds 5 bytes/)

  const correctedStat = new RefactorReadBudget({
    maxFiles: 1,
    maxFileBytes: 8,
    maxTotalBytes: 5,
  })
  correctedStat.accept('/workspace/a.ts', 1)
  assert.throws(() => correctedStat.accept('/workspace/a.ts', 6), /exceeds 5 bytes/)
})

test('bounded UTF-8 decoding preserves an existing byte-order mark', () => {
  const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x61])
  assert.equal(decodeRefactorText(bytes, '/workspace/a.ts'), '\ufeffa')
  assert.throws(
    () => decodeRefactorText(Uint8Array.from([0xff]), '/workspace/a.ts'),
    /not valid UTF-8 text/,
  )
})
