import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findArtifactForPlatform,
  normalizePlatform,
  parseReleaseManifest,
} from '../bin/distribution-manifest.js'

function validManifest() {
  return {
    schemaVersion: 1,
    omdVersion: '0.2.0',
    releasedAt: '2026-08-17T00:00:00Z',
    tag: 'v0.2.0',
    channel: 'stable',
    artifacts: {
      'darwin-arm64': {
        filename: 'oh-my-dsh-v0.2.0-darwin-arm64.tar.gz',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        size: 12345678,
        platform: 'darwin-arm64',
        nodeVersion: '22.19.0',
        dshVersion: '0.1.0-rc.6',
        url: 'https://github.com/amplifthq/oh-my-dsh/releases/download/v0.2.0/oh-my-dsh-v0.2.0-darwin-arm64.tar.gz',
      },
      'linux-x64': {
        filename: 'oh-my-dsh-v0.2.0-linux-x64.tar.gz',
        sha256: 'ca978112ca1bbdcafac231b39a23dc4da786081496140970e4e041935639f76a',
        size: 23456789,
        platform: 'linux-x64',
        nodeVersion: '22.19.0',
        dshVersion: '0.1.0-rc.6',
        url: 'https://github.com/amplifthq/oh-my-dsh/releases/download/v0.2.0/oh-my-dsh-v0.2.0-linux-x64.tar.gz',
      },
    },
  }
}

test('normalizePlatform maps supported os/arch to platform tuples', () => {
  assert.equal(normalizePlatform('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(normalizePlatform('linux', 'x64'), 'linux-x64')
  assert.throws(() => normalizePlatform('darwin', 'x64'), /unsupported platform: darwin-x64/)
  assert.throws(() => normalizePlatform('win32', 'x64'), /unsupported platform: win32-x64/)
  assert.throws(() => normalizePlatform('linux', 'arm64'), /unsupported platform: linux-arm64/)
})

test('parseReleaseManifest and findArtifactForPlatform validate external manifest structure', () => {
  const manifest = parseReleaseManifest(validManifest())
  assert.equal(manifest.omdVersion, '0.2.0')
  assert.equal(manifest.channel, 'stable')

  const artifact = findArtifactForPlatform(manifest, 'darwin-arm64')
  assert.equal(artifact.filename, 'oh-my-dsh-v0.2.0-darwin-arm64.tar.gz')
  assert.equal(artifact.sha256.length, 64)

  assert.throws(
    () => findArtifactForPlatform(manifest, 'linux-arm64'),
    /no artifact available for platform linux-arm64/,
  )
})

test('parseReleaseManifest rejects unsafe versions, filenames, and digests', () => {
  for (const omdVersion of ['../0.2.0', '0.2', '0.2.0+build']) {
    assert.throws(
      () => parseReleaseManifest({ ...validManifest(), omdVersion }),
      /invalid release manifest omdVersion/,
    )
  }

  for (const filename of [
    '../oh-my-dsh.tar.gz',
    'nested/oh-my-dsh.tar.gz',
    String.raw`nested\oh-my-dsh.tar.gz`,
    'oh-my-dsh..tar.gz',
    'oh-my-dsh.zip',
  ]) {
    const manifest = validManifest()
    manifest.artifacts['darwin-arm64'].filename = filename
    assert.throws(() => parseReleaseManifest(manifest), /invalid artifact filename/)
  }

  for (const sha256 of ['0'.repeat(63), 'g'.repeat(64), `${'0'.repeat(63)}/`]) {
    const manifest = validManifest()
    manifest.artifacts['darwin-arm64'].sha256 = sha256
    assert.throws(() => parseReleaseManifest(manifest), /invalid artifact sha256/)
  }
})
