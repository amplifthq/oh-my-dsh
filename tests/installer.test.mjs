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
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
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

function spawnInstall(env) {
  const child = spawn('sh', [installSh], {
    env: { ...process.env, ...env },
    cwd: repoRoot,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const completion = new Promise((resolveCompletion) => {
    child.on('close', (status, signal) => {
      resolveCompletion({ status, signal, stdout, stderr })
    })
  })
  return { child, completion }
}

async function waitForPath(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

function createMinimalPortableArchive(root, version, options = {}) {
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
      nodeVersion: options.nodeVersion || '22.19.0',
      dshVersion: options.dshVersion || '0.1.0-rc.6',
    })}\n`,
  )
  if (options.escapingSymlink) {
    symlinkSync('../../../../outside', join(versionDir, 'app', 'escape'))
  }

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

function writeManifest(root, archive, overrides = {}) {
  const manifestPath = join(root, 'release-manifest.json')
  const manifest = {
    schemaVersion: 1,
    omdVersion: overrides.omdVersion || archive.version,
    releasedAt: '2026-08-17T00:00:00Z',
    tag: `v${archive.version}`,
    channel: 'stable',
    artifacts: {
      [archive.platform]: {
        filename: overrides.filename || archive.archiveName,
        sha256: overrides.sha256 || archive.sha256,
        size: readFileSync(archive.archivePath).length,
        platform: archive.platform,
        nodeVersion: overrides.nodeVersion || '22.19.0',
        dshVersion: overrides.dshVersion || '0.1.0-rc.6',
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

test('install.sh rejects unsafe manifest versions, filenames, and digests before installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-installer-sanitize-'))
  try {
    const archive = createMinimalPortableArchive(root, '0.2.0-test')
    const cases = [
      { overrides: { omdVersion: '../escape' }, message: /invalid.*omdVersion/i },
      { overrides: { filename: '../escape.tar.gz' }, message: /invalid.*filename/i },
      { overrides: { sha256: 'g'.repeat(64) }, message: /invalid.*sha256/i },
    ]

    for (const [index, { overrides, message }] of cases.entries()) {
      const manifestPath = writeManifest(root, archive, overrides)
      const installRoot = join(root, `install-${index}`)
      const result = runInstall({
        OMD_INSTALL_ROOT: installRoot,
        OMD_BIN_DIR: join(root, `bin-${index}`),
        OMD_MANIFEST_URL: `file://${manifestPath}`,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr || result.stdout, message)
      assert.equal(existsSync(join(installRoot, 'versions')), false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('install.sh serializes concurrent stale-lock contenders without deleting the winner lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-installer-lock-race-'))
  let contenderA
  let contenderB
  try {
    const archive = createMinimalPortableArchive(root, '0.2.0-test')
    const manifestPath = writeManifest(root, archive)
    const installRoot = join(root, 'install')
    const lockDir = join(installRoot, 'update.lock')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'pid'), '999999999\n')

    const fakeBin = join(root, 'fake-bin')
    const curlStarted = join(root, 'curl-started')
    const curlRelease = join(root, 'curl-release')
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(
      join(fakeBin, 'curl'),
      `#!/bin/sh
set -eu
url=''
destination=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    file://*) url="$1" ;;
    -o) shift; destination="$1" ;;
  esac
  shift
done
: > "$OMD_TEST_CURL_STARTED"
while [ ! -f "$OMD_TEST_CURL_RELEASE" ]; do sleep 1; done
cp "\${url#file://}" "$destination"
`,
    )
    chmodSync(join(fakeBin, 'curl'), 0o755)

    const env = {
      OMD_INSTALL_ROOT: installRoot,
      OMD_BIN_DIR: join(root, 'bin'),
      OMD_MANIFEST_URL: `file://${manifestPath}`,
      OMD_TEST_CURL_STARTED: curlStarted,
      OMD_TEST_CURL_RELEASE: curlRelease,
      PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    }
    contenderA = spawnInstall(env)
    contenderB = spawnInstall(env)

    await waitForPath(curlStarted)
    const first = await Promise.race([
      contenderA.completion.then((result) => ({ id: 'a', result })),
      contenderB.completion.then((result) => ({ id: 'b', result })),
    ])
    assert.notEqual(first.result.status, 0, first.result.stderr || first.result.stdout)
    assert.match(
      first.result.stderr || first.result.stdout,
      /install lock is held|could not acquire/,
    )
    assert.ok(lstatSync(lockDir).isDirectory())

    const winner = first.id === 'a' ? contenderB : contenderA
    assert.equal(Number(readFileSync(join(lockDir, 'pid'), 'utf8').trim()), winner.child.pid)
    writeFileSync(curlRelease, '')
    const winnerResult = await winner.completion
    assert.equal(winnerResult.status, 0, winnerResult.stderr || winnerResult.stdout)
    assert.equal(readlinkSync(join(installRoot, 'current')), 'versions/0.2.0-test')
    assert.equal(existsSync(lockDir), false)
  } finally {
    writeFileSync(join(root, 'curl-release'), '')
    for (const contender of [contenderA, contenderB]) {
      if (contender?.child.exitCode === null) contender.child.kill()
    }
    await Promise.allSettled(
      [contenderA, contenderB].filter(Boolean).map((contender) => contender.completion),
    )
    rmSync(root, { recursive: true, force: true })
  }
})

test('install.sh recovers a stale directory lock whose owner is dead', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-installer-stale-lock-'))
  try {
    const archive = createMinimalPortableArchive(root, '0.2.0-test')
    const manifestPath = writeManifest(root, archive)
    const installRoot = join(root, 'install')
    const lockDir = join(installRoot, 'update.lock')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'pid'), '999999999\n')

    const result = runInstall({
      OMD_INSTALL_ROOT: installRoot,
      OMD_BIN_DIR: join(root, 'bin'),
      OMD_MANIFEST_URL: `file://${manifestPath}`,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(readlinkSync(join(installRoot, 'current')), 'versions/0.2.0-test')
    assert.equal(existsSync(lockDir), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('install.sh rejects archive symlinks that escape the extracted tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-installer-symlink-'))
  try {
    const archive = createMinimalPortableArchive(root, '0.2.0-test', {
      escapingSymlink: true,
    })
    const manifestPath = writeManifest(root, archive)
    const result = runInstall({
      OMD_INSTALL_ROOT: join(root, 'install'),
      OMD_BIN_DIR: join(root, 'bin'),
      OMD_MANIFEST_URL: `file://${manifestPath}`,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr || result.stdout, /unsafe archive symlink/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('install.sh binds extracted distribution identity to the manifest artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-installer-identity-'))
  try {
    const archive = createMinimalPortableArchive(root, '0.2.0-test', {
      nodeVersion: '24.0.0',
    })
    const manifestPath = writeManifest(root, archive)
    const installRoot = join(root, 'install')
    const result = runInstall({
      OMD_INSTALL_ROOT: installRoot,
      OMD_BIN_DIR: join(root, 'bin'),
      OMD_MANIFEST_URL: `file://${manifestPath}`,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr || result.stdout, /distribution identity.*nodeVersion/i)
    assert.equal(existsSync(join(installRoot, 'current')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
