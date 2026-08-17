import assert from 'node:assert/strict'
import {
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
import { spawnSync } from 'node:child_process'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'
import { generateFileManifest } from '../bin/distribution-files.js'
import { normalizePlatform } from '../bin/distribution-manifest.js'
import {
  beginInstallTransaction,
  commitInstallTransaction,
  writeInstallState,
} from '../bin/distribution-state.js'
import { profilePackageSpec } from '../bin/package-spec.js'

const cli = resolve('bin/omd')

function run(args, home, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, ...extraEnv },
  })
}

function runPortable(omdPath, args, env) {
  return spawnSync(process.execPath, [omdPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function distributionInfo(version) {
  return {
    schemaVersion: 1,
    omdVersion: version,
    gitCommit: 'testcommit',
    platform: normalizePlatform(),
    nodeVersion: '22.19.0',
    dshVersion: '0.1.0-rc.6',
    lockfileDigest: 'sha256-test',
    buildTime: '2026-08-17T00:00:00Z',
    sbomPath: 'sbom.spdx.json',
  }
}

function seedPortableVersion(installRoot, version) {
  const versionDir = join(installRoot, 'versions', version)
  const appDir = join(versionDir, 'app')
  mkdirSync(join(appDir, 'bin'), { recursive: true })
  cpSync(resolve('bin'), join(appDir, 'bin'), { recursive: true })
  mkdirSync(join(appDir, 'node_modules', 'oh-my-dsh'), { recursive: true })
  writeFileSync(
    join(appDir, 'node_modules', 'oh-my-dsh', 'package.json'),
    JSON.stringify({ name: 'oh-my-dsh', version }),
  )
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ name: 'oh-my-dsh', version, dependencies: {} }),
  )
  writeFileSync(join(versionDir, 'distribution.json'), JSON.stringify(distributionInfo(version)))
  return { versionDir, appDir, omd: join(appDir, 'bin', 'omd') }
}

function createPortableInstall(root, options = {}) {
  const installRoot = join(root, 'install')
  const dshHome = join(root, '.dsh')
  const version = options.version || '0.2.0'
  const { versionDir, appDir, omd } = seedPortableVersion(installRoot, version)
  symlinkSync(`versions/${version}`, join(installRoot, 'current'))
  if (options.previousVersion) {
    seedPortableVersion(installRoot, options.previousVersion)
    symlinkSync(`versions/${options.previousVersion}`, join(installRoot, 'previous'))
    writeInstallState(installRoot, {
      schemaVersion: 1,
      currentVersion: version,
      previousVersion: options.previousVersion,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      openTransaction: null,
      verifiedArtifacts: {},
    })
  } else if (options.withState) {
    beginInstallTransaction(installRoot, {
      op: 'install',
      candidateVersion: version,
      oldCurrent: null,
      oldPrevious: null,
    })
    commitInstallTransaction(installRoot, version)
  }
  return { installRoot, dshHome, versionDir, appDir, omd }
}

test('profile dependency uses a valid registry version outside a source checkout', () => {
  assert.equal(
    profilePackageSpec({
      sourceCheckout: false,
      packageRoot: '/tmp/unused',
      version: '0.1.1',
    }),
    '0.1.1',
  )
  assert.equal(
    profilePackageSpec({
      sourceCheckout: true,
      packageRoot: '/workspace/oh-my-dsh',
      version: '0.1.1',
    }),
    'file:/workspace/oh-my-dsh',
  )
})

test('danger-full-access still asks before committing reviewed proposals', () => {
  const bundle = readFileSync(resolve('bundles/omd.cordis.yml'), 'utf8')
  assert.match(
    bundle,
    /danger-full-access:\s*\n\s+sandbox: danger-full-access\s*\n\s+approval: ask/,
  )
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

test('portable omd setup links profile node_modules to distribution app/node_modules without npm', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-portable-cli-'))
  try {
    const { installRoot, dshHome, omd } = createPortableInstall(root)
    const setup = runPortable(omd, ['setup'], {
      DSH_HOME: dshHome,
      OMD_INSTALL_ROOT: installRoot,
      OMD_NPM: '/usr/bin/false',
    })
    assert.equal(setup.status, 0, setup.stderr || setup.stdout)

    for (const profile of ['omd', 'omd-headless']) {
      const profileDir = join(dshHome, 'profiles', profile)
      const nodeModulesPath = join(profileDir, 'node_modules')
      assert.ok(existsSync(nodeModulesPath))
      assert.ok(lstatSync(nodeModulesPath).isSymbolicLink())
      assert.equal(
        resolve(readlinkSync(nodeModulesPath)),
        resolve(installRoot, 'current', 'app', 'node_modules'),
      )
      assert.ok(existsSync(join(profileDir, 'package.json')))
      assert.ok(existsSync(join(profileDir, 'cordis.patch.yml')))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('portable omd doctor reports distribution identity and optional file manifest verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-portable-doctor-'))
  try {
    const { dshHome, omd, versionDir } = createPortableInstall(root, { version: '0.2.0' })
    const manifest = await generateFileManifest(versionDir)
    writeFileSync(join(versionDir, 'distribution-files.json'), JSON.stringify(manifest))

    const doctor = runPortable(omd, ['doctor'], {
      DSH_HOME: dshHome,
      OMD_INSTALL_ROOT: join(root, 'install'),
    })
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout)
    assert.match(doctor.stdout, /oh-my-dsh 0\.2\.0/)
    assert.match(doctor.stdout, /mode: portable/)

    const verified = runPortable(omd, ['doctor', '--verify'], {
      DSH_HOME: dshHome,
      OMD_INSTALL_ROOT: join(root, 'install'),
    })
    assert.equal(verified.status, 0, verified.stderr || verified.stdout)
    assert.match(verified.stdout, /file manifest: ok/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('source omd doctor reports mode and skips portable file manifest verification', () => {
  const home = mkdtempSync(join(tmpdir(), 'omd-source-doctor-'))
  try {
    const doctor = run(['doctor'], home)
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout)
    assert.match(doctor.stdout, /mode: source/)
    const verified = run(['doctor', '--verify'], home)
    assert.equal(verified.status, 0, verified.stderr || verified.stdout)
    assert.match(verified.stdout, /file manifest: skipped/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('omd rollback explains npm management outside portable mode', () => {
  const home = mkdtempSync(join(tmpdir(), 'omd-rollback-npm-'))
  try {
    const rollback = run(['rollback'], home)
    assert.equal(rollback.status, 0, rollback.stderr || rollback.stdout)
    assert.match(rollback.stdout, /managed through npm/)
    assert.match(rollback.stdout, /npm install -g oh-my-dsh@/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('portable omd rollback switches current back to the retained previous version', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-portable-rollback-'))
  try {
    const { installRoot, dshHome, omd } = createPortableInstall(root, {
      version: '0.2.0',
      previousVersion: '0.1.7',
    })

    const rollback = runPortable(omd, ['rollback'], {
      DSH_HOME: dshHome,
      OMD_INSTALL_ROOT: installRoot,
    })
    assert.equal(rollback.status, 0, rollback.stderr || rollback.stdout)
    assert.match(rollback.stdout, /rolled back from 0\.2\.0 to 0\.1\.7/)
    assert.equal(readlinkSync(join(installRoot, 'current')), 'versions/0.1.7')
    assert.equal(readlinkSync(join(installRoot, 'previous')), 'versions/0.2.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('omd update explains npm management outside portable mode', () => {
  const home = mkdtempSync(join(tmpdir(), 'omd-update-npm-'))
  try {
    const update = run(['update'], home)
    assert.equal(update.status, 0, update.stderr || update.stdout)
    assert.match(update.stdout, /managed through npm/)
    assert.match(update.stdout, /npm install -g oh-my-dsh@latest/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('portable omd update reports already current without downloading', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-portable-update-current-'))
  try {
    const { installRoot, dshHome, omd } = createPortableInstall(root, {
      version: '0.2.0',
      withState: true,
    })
    const manifestPath = join(root, 'release-manifest.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        omdVersion: '0.2.0',
        tag: 'v0.2.0',
        channel: 'stable',
        releasedAt: '2026-08-17T00:00:00Z',
        artifacts: {
          [normalizePlatform()]: {
            filename: 'oh-my-dsh-v0.2.0.tar.gz',
            sha256: '0'.repeat(64),
            size: 1,
            url: 'https://github.com/amplifthq/oh-my-dsh/releases/download/v0.2.0/oh-my-dsh-v0.2.0.tar.gz',
            nodeVersion: '22.19.0',
            dshVersion: '0.1.0-rc.6',
          },
        },
      }),
    )

    const update = runPortable(omd, ['update'], {
      DSH_HOME: dshHome,
      OMD_INSTALL_ROOT: installRoot,
      OMD_RELEASE_MANIFEST_PATH: manifestPath,
    })
    assert.equal(update.status, 0, update.stderr || update.stdout)
    assert.match(update.stdout, /already up to date/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
