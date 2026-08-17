import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  detectDistributionMode,
  formatDistributionIdentity,
  parseDistributionInfo,
} from '../bin/distribution-identity.js'

test('parseDistributionInfo validates required fields and types', () => {
  const valid = {
    schemaVersion: 1,
    omdVersion: '0.2.0',
    gitCommit: 'abcdef0123456789',
    gitTag: 'v0.2.0',
    platform: 'darwin-arm64',
    nodeVersion: '22.19.0',
    dshVersion: '0.1.0-rc.6',
    lockfileDigest: 'sha256-1234567890abcdef',
    buildTime: '2026-08-17T00:00:00.000Z',
    sbomPath: 'sbom.spdx.json',
  }

  const parsed = parseDistributionInfo(valid)
  assert.equal(parsed.omdVersion, '0.2.0')
  assert.equal(parsed.platform, 'darwin-arm64')
  assert.equal(
    formatDistributionIdentity(parsed),
    'oh-my-dsh 0.2.0 (darwin-arm64, dsh 0.1.0-rc.6, node 22.19.0)',
  )

  assert.throws(
    () => parseDistributionInfo({ ...valid, schemaVersion: 2 }),
    /unsupported distribution schema version/,
  )
  assert.throws(
    () => parseDistributionInfo({ ...valid, omdVersion: '' }),
    /invalid distribution omdVersion/,
  )
  assert.throws(
    () => parseDistributionInfo({ ...valid, platform: 'windows-x64' }),
    /unsupported distribution platform/,
  )
})

test('detectDistributionMode detects source checkout, portable bundle, and npm install', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-identity-'))
  try {
    // 1. Source checkout with .git
    mkdirSync(join(root, 'source', '.git'), { recursive: true })
    writeFileSync(
      join(root, 'source', 'package.json'),
      JSON.stringify({ name: 'oh-my-dsh', version: '0.2.0' }),
    )
    const sourceMode = detectDistributionMode(join(root, 'source'))
    assert.equal(sourceMode.mode, 'source')

    // 2. Portable bundle layout: app directory with distribution.json in root
    const portableRoot = join(root, 'portable')
    const appDir = join(portableRoot, 'app')
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: 'oh-my-dsh', version: '0.2.0' }),
    )
    writeFileSync(
      join(portableRoot, 'distribution.json'),
      JSON.stringify({
        schemaVersion: 1,
        omdVersion: '0.2.0',
        gitCommit: 'abc123',
        platform: 'linux-x64',
        nodeVersion: '22.19.0',
        dshVersion: '0.1.0-rc.6',
        lockfileDigest: 'sha256-abc',
        buildTime: '2026-08-17T00:00:00Z',
        sbomPath: 'sbom.spdx.json',
      }),
    )
    const portableMode = detectDistributionMode(appDir)
    assert.equal(portableMode.mode, 'portable')
    assert.equal(portableMode.distributionInfo.platform, 'linux-x64')

    // 3. Plain npm installation
    const npmDir = join(root, 'npm')
    mkdirSync(npmDir, { recursive: true })
    writeFileSync(
      join(npmDir, 'package.json'),
      JSON.stringify({ name: 'oh-my-dsh', version: '0.2.0' }),
    )
    const npmMode = detectDistributionMode(npmDir)
    assert.equal(npmMode.mode, 'npm')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
