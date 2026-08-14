import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'
import { profilePackageSpec } from '../bin/package-spec.js'

const cli = resolve('bin/omd')

function run(args, home) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
  })
}

test('profile dependency uses a valid registry version outside a source checkout', () => {
  assert.equal(profilePackageSpec({
    sourceCheckout: false,
    packageRoot: '/tmp/unused',
    version: '0.1.1',
  }), '0.1.1')
  assert.equal(profilePackageSpec({
    sourceCheckout: true,
    packageRoot: '/workspace/oh-my-dsh',
    version: '0.1.1',
  }), 'file:/workspace/oh-my-dsh')
})

test('CLI help and curated preset configuration work without booting dsh', () => {
  const home = mkdtempSync(join(tmpdir(), 'omd-cli-'))
  try {
    const help = run(['--help'], home)
    assert.equal(help.status, 0)
    assert.match(help.stdout, /omd preset/)

    const enabled = run(['preset', 'enable', 'memory'], home)
    assert.equal(enabled.status, 0, enabled.stderr)
    const config = JSON.parse(readFileSync(join(home, 'omd.json'), 'utf8'))
    assert.deepEqual(config.presets, ['memory'])

    const list = run(['preset', 'list'], home)
    assert.equal(list.status, 0)
    assert.match(list.stdout, /✓ memory/)

    const workspace = join(home, 'workspace')
    const nested = join(workspace, 'packages', 'app')
    mkdirSync(join(workspace, '.git'), { recursive: true })
    mkdirSync(nested, { recursive: true })
    const trusted = run(['trust', 'add', nested], home)
    assert.equal(trusted.status, 0, trusted.stderr)
    const trustedConfig = JSON.parse(readFileSync(join(home, 'omd.json'), 'utf8'))
    assert.deepEqual(trustedConfig.trustedWorkspaces, [workspace])

    const sessionDir = join(home, 'sessions', 'project', 'session')
    mkdirSync(sessionDir, { recursive: true })
    const transcript = [
      JSON.stringify({
        type: 'session',
        version: 0,
        id: 'test-session',
        cwd: workspace,
        createdAt: Date.now(),
        delegationDepth: 0,
      }),
      JSON.stringify({
        seq: 0,
        time: Date.now(),
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'message-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            source: { kind: 'model', provider: 'test', model: 'test' },
          },
          usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 7 },
        },
        surfaceOp: 'append',
      }),
      '',
    ].join('\n')
    const headerEnd = transcript.indexOf('\n') + 1
    writeFileSync(
      join(sessionDir, 'session.jsonl.zstd'),
      Buffer.concat([
        zstdCompressSync(Buffer.from(transcript.slice(0, headerEnd))),
        zstdCompressSync(Buffer.from(transcript.slice(headerEnd))),
      ]),
    )
    const usage = run(['usage'], home)
    assert.equal(usage.status, 0, usage.stderr)
    assert.match(usage.stdout, /Model calls: 1/)
    assert.match(usage.stdout, /Input tokens: 12/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
