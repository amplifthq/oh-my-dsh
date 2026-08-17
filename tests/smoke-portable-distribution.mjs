// tests/smoke-portable-distribution.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('portable distribution builds, packages, and extracts with valid structure', async () => {
  // Run packaging for current platform
  const outDir = mkdtempSync(join(tmpdir(), 'omd-pack-test-'))
  try {
    const build = spawnSync(
      process.execPath,
      ['scripts/build-portable-distribution.mjs', '--out-dir', outDir, '--dry-run-node'],
      { encoding: 'utf8', env: process.env },
    )
    assert.equal(build.status, 0, build.stderr)
    // Verify files created
    assert.ok(existsSync(join(outDir, 'release-manifest.json')))
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
