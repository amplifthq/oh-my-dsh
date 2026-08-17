import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { normalizePlatform } from '../bin/distribution-manifest.js'

const installSh = resolve('install.sh')
const repoRoot = resolve('.')

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function runInstall(env, options = {}) {
  return spawnSync('sh', [installSh], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: repoRoot,
    ...options,
  })
}

function createMinimalPortableArchive(root, version) {
  const platform = normalizePlatform()
  const versionDirName = `oh-my-dsh-v${version}`
  const stagingRoot = join(root, 'archive-staging')
  const versionDir = join(stagingRoot, versionDirName)
  mkdirSync(join(versionDir, 'app', 'bin'), { recursive: true })
  mkdirSync(join(versionDir, 'runtime', 'bin'), { recursive: true })
  mkdirSync(join(versionDir, 'bin'), { recursive: true })
  writeFileSync(
    join(versionDir, 'runtime', 'bin', 'node'),
    `#!/bin/sh
set -eu
exec "${process.execPath}" "$@"
`,
  )
  writeFileSync(
    join(versionDir, 'app', 'bin', 'omd'),
    `if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log('${version}')
  process.exit(0)
}
process.exit(1)
`,
  )
  chmodSync(join(versionDir, 'runtime', 'bin', 'node'), 0o755)
  chmodSync(join(versionDir, 'app', 'bin', 'omd'), 0o755)
  writeFileSync(
    join(versionDir, 'bin', 'omd'),
    `#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
exec "$SCRIPT_DIR/runtime/bin/node" "$SCRIPT_DIR/app/bin/omd" "$@"
`,
  )
  chmodSync(join(versionDir, 'bin', 'omd'), 0o755)
  writeFileSync(
    join(versionDir, 'distribution.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      omdVersion: version,
      platform,
      nodeVersion: '22.19.0',
      dshVersion: '0.1.0-rc.6',
    })}\n`,
  )

  const archiveName = `${versionDirName}-${platform}.tar.gz`
  const archivePath = join(root, archiveName)
  const tar = spawnSync('tar', ['-czf', archivePath, '-C', stagingRoot, versionDirName], {
    encoding: 'utf8',
  })
  assert.equal(tar.status, 0, tar.stderr || tar.stdout)

  return {
    archivePath,
    archiveName,
    sha256: sha256File(archivePath),
    platform,
    version,
  }
}

function writeManifest(root, archive) {
  const manifestPath = join(root, 'release-manifest.json')
  const manifest = {
    schemaVersion: 1,
    omdVersion: archive.version,
    releasedAt: '2026-08-17T00:00:00Z',
    tag: `v${archive.version}`,
    channel: 'stable',
    artifacts: {
      [archive.platform]: {
        filename: archive.archiveName,
        sha256: archive.sha256,
        size: readFileSync(archive.archivePath).length,
        platform: archive.platform,
        nodeVersion: '22.19.0',
        dshVersion: '0.1.0-rc.6',
        url: `file://${archive.archivePath}`,
      },
    },
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifestPath
}

test('install.sh rejects unsupported platforms and installs successfully on supported platform', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-installer-test-'))
  try {
    const installRoot = join(root, 'share', 'oh-my-dsh')
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })

    const fakeBin = join(root, 'fakebin')
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(
      join(fakeBin, 'uname'),
      `#!/bin/sh
case "$1" in
  -s) echo Darwin ;;
  -m) echo x86_64 ;;
esac
`,
    )
    chmodSync(join(fakeBin, 'uname'), 0o755)

    const rejected = runInstall({
      PATH: `${fakeBin}:${process.env.PATH}`,
      OMD_INSTALL_ROOT: installRoot,
      OMD_BIN_DIR: binDir,
    })
    assert.notEqual(rejected.status, 0, rejected.stdout)
    assert.match(rejected.stderr || rejected.stdout, /unsupported platform/i)

    const archive = createMinimalPortableArchive(root, '0.2.0-test')
    const manifestPath = writeManifest(root, archive)

    const installed = runInstall({
      OMD_INSTALL_ROOT: installRoot,
      OMD_BIN_DIR: binDir,
      OMD_MANIFEST_URL: `file://${manifestPath}`,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    })
    assert.equal(installed.status, 0, installed.stderr || installed.stdout)

    assert.ok(existsSync(join(installRoot, 'current')))
    assert.equal(readlinkSync(join(installRoot, 'current')), 'versions/0.2.0-test')
    assert.ok(existsSync(join(installRoot, 'versions', '0.2.0-test', 'distribution.json')))
    assert.ok(existsSync(join(installRoot, 'install-state.json')))

    const state = JSON.parse(readFileSync(join(installRoot, 'install-state.json'), 'utf8'))
    assert.equal(state.currentVersion, '0.2.0-test')
    assert.equal(state.schemaVersion, 1)

    assert.ok(existsSync(join(binDir, 'omd')))
    assert.ok(lstatSync(join(binDir, 'omd')).isSymbolicLink())
    assert.ok(readlinkSync(join(binDir, 'omd')).endsWith('share/oh-my-dsh/current/bin/omd'))

    const version = spawnSync(
      join(installRoot, 'versions', '0.2.0-test', 'runtime', 'bin', 'node'),
      [join(installRoot, 'versions', '0.2.0-test', 'app', 'bin', 'omd'), '--version'],
      { encoding: 'utf8', env: { PATH: '', HOME: join(root, 'home-check') } },
    )
    assert.equal(version.status, 0, version.stderr)
    assert.equal(version.stdout.trim(), '0.2.0-test')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
