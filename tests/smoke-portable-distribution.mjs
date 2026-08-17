// tests/smoke-portable-distribution.mjs
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('portable distribution builds, packages, and extracts with valid structure', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'omd-pack-test-'))
  try {
    const build = spawnSync(
      process.execPath,
      ['scripts/build-portable-distribution.mjs', '--out-dir', outDir, '--dry-run-node'],
      { encoding: 'utf8', env: process.env },
    )
    assert.equal(build.status, 0, build.stderr)

    assert.ok(existsSync(join(outDir, 'release-manifest.json')))
    assert.ok(existsSync(join(outDir, 'SHA256SUMS')))

    const archives = readdirSync(outDir).filter((entry) => entry.endsWith('.tar.gz'))
    assert.equal(archives.length, 1, 'expected exactly one portable archive')
    const archivePath = join(outDir, archives[0])

    const extractDir = mkdtempSync(join(tmpdir(), 'omd-pack-extract-'))
    try {
      const extract = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], {
        encoding: 'utf8',
      })
      assert.equal(extract.status, 0, extract.stderr)

      const versionDirs = readdirSync(extractDir).filter((entry) => !entry.startsWith('.'))
      assert.equal(versionDirs.length, 1, 'expected one version directory in archive')
      const versionDir = join(extractDir, versionDirs[0])

      assert.ok(existsSync(join(versionDir, 'bin', 'omd')))
      assert.ok(existsSync(join(versionDir, 'runtime', 'bin', 'node')))
      assert.ok(existsSync(join(versionDir, 'distribution.json')))

      const installRoot = join(extractDir, 'install-root')
      const userBin = join(extractDir, 'home', '.local', 'bin')
      mkdirSync(installRoot, { recursive: true })
      mkdirSync(userBin, { recursive: true })
      symlinkSync(versionDir, join(installRoot, 'current'))
      const launcher = join(userBin, 'omd')
      symlinkSync(join(installRoot, 'current', 'bin', 'omd'), launcher)

      const launched = spawnSync(launcher, ['--version'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: '/usr/bin:/bin' },
      })
      const releaseManifest = JSON.parse(
        readFileSync(join(outDir, 'release-manifest.json'), 'utf8'),
      )
      assert.equal(launched.status, 0, launched.stderr || launched.stdout)
      assert.equal(launched.stdout.trim(), releaseManifest.omdVersion)
    } finally {
      rmSync(extractDir, { recursive: true, force: true })
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
