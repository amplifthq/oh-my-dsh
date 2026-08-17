#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { generateFileManifest } from '../bin/distribution-files.js'
import { normalizePlatform } from '../bin/distribution-manifest.js'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8'))
const repositoryUrl =
  typeof packageJson.repository?.url === 'string'
    ? packageJson.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
    : 'https://github.com/amplifthq/oh-my-dsh'

function parseArgs(argv) {
  const options = {
    outDir: 'dist-release',
    dryRunNode: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--platform') {
      options.platform = argv[++index]
      continue
    }
    if (arg === '--out-dir') {
      options.outDir = argv[++index]
      continue
    }
    if (arg === '--node-version') {
      options.nodeVersion = argv[++index]
      continue
    }
    if (arg === '--dry-run-node') {
      options.dryRunNode = true
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    env: {
      ...process.env,
      HUSKY: '0',
      ...(options.env || {}),
    },
  })
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || `${command} exited ${result.status}`
    throw new Error(detail.trim())
  }
  return result
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function sha256File(filePath) {
  return sha256Buffer(readFileSync(filePath))
}

function defaultNodeVersion() {
  if (process.env.OMD_NODE_VERSION) return process.env.OMD_NODE_VERSION.replace(/^v/, '')
  return process.version.replace(/^v/, '')
}

function nodeArchiveName(platform, nodeVersion) {
  const version = nodeVersion.startsWith('v') ? nodeVersion : `v${nodeVersion}`
  return `node-${version}-${platform}.tar.gz`
}

function readGitCommit() {
  try {
    return runCommand('git', ['rev-parse', 'HEAD']).stdout.trim()
  } catch {
    return 'unknown'
  }
}

function readGitTag(version) {
  try {
    return runCommand('git', ['describe', '--tags', '--exact-match']).stdout.trim()
  } catch {
    return `v${version}`
  }
}

function lockfileDigest() {
  const lockPath = join(workspaceRoot, 'pnpm-lock.yaml')
  if (!existsSync(lockPath)) {
    throw new Error('pnpm-lock.yaml is missing; cannot compute lockfile digest')
  }
  return `sha256-${sha256File(lockPath)}`
}

function dshVersion() {
  const dep = packageJson.dependencies?.['@deepseek-ai/dsh']
  if (typeof dep !== 'string' || !dep.trim()) {
    throw new Error('cannot determine @deepseek-ai/dsh version from package.json')
  }
  return dep.replace(/^[\^~>=<]+/, '')
}

async function downloadToFile(url, destination) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`failed to download ${url} (${response.status} ${response.statusText})`)
  }
  if (!response.body) throw new Error(`download response has no body: ${url}`)
  mkdirSync(dirname(destination), { recursive: true })
  await pipeline(response.body, createWriteStream(destination))
}

async function verifyNodeArchiveChecksum(archivePath, nodeVersion) {
  const version = nodeVersion.startsWith('v') ? nodeVersion : `v${nodeVersion}`
  const sumsUrl = `https://nodejs.org/dist/${version}/SHASUMS256.txt`
  const response = await fetch(sumsUrl)
  if (!response.ok) {
    throw new Error(`failed to fetch Node.js checksums (${response.status} ${response.statusText})`)
  }
  const sumsText = await response.text()
  const archiveName = basename(archivePath)
  const expected = sumsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const match = line.match(/^([a-f0-9]{64})\s+(.+)$/)
      return match ? { hash: match[1], file: match[2] } : null
    })
    .find((entry) => entry && entry.file === archiveName)
  if (!expected) {
    throw new Error(`Node.js checksum entry not found for ${archiveName}`)
  }
  const actual = sha256File(archivePath)
  if (actual !== expected.hash) {
    throw new Error(`Node.js archive checksum mismatch (expected ${expected.hash}, got ${actual})`)
  }
}

function extractTarArchive(archivePath, destination) {
  mkdirSync(destination, { recursive: true })
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', destination], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'tar extraction failed')
  }
}

async function materializeNodeRuntime(versionDir, platform, nodeVersion, dryRunNode) {
  const runtimeBinDir = join(versionDir, 'runtime', 'bin')
  mkdirSync(runtimeBinDir, { recursive: true })
  const nodeTarget = join(runtimeBinDir, 'node')

  if (dryRunNode) {
    copyFileSync(process.execPath, nodeTarget)
    chmodSync(nodeTarget, 0o755)
    const licensePath = join(versionDir, 'runtime', 'LICENSE')
    writeFileSync(
      licensePath,
      'Node.js runtime copied from local process for packaging dry-run.\n',
      'utf8',
    )
    return
  }

  const version = nodeVersion.startsWith('v') ? nodeVersion : `v${nodeVersion}`
  const archiveName = nodeArchiveName(platform, version)
  const downloadDir = mkdtempSync(join(tmpdir(), 'omd-node-dl-'))
  const archivePath = join(downloadDir, archiveName)
  try {
    await downloadToFile(`https://nodejs.org/dist/${version}/${archiveName}`, archivePath)
    await verifyNodeArchiveChecksum(archivePath, version)
    const extractDir = join(downloadDir, 'extract')
    extractTarArchive(archivePath, extractDir)
    const extractedRoot = join(extractDir, basename(archiveName, '.tar.gz'))
    copyFileSync(join(extractedRoot, 'bin', 'node'), nodeTarget)
    chmodSync(nodeTarget, 0o755)
    copyFileSync(join(extractedRoot, 'LICENSE'), join(versionDir, 'runtime', 'LICENSE'))
  } finally {
    rmSync(downloadDir, { recursive: true, force: true })
  }
}

function materializeApp(appDir) {
  rmSync(appDir, { recursive: true, force: true })
  mkdirSync(appDir, { recursive: true })
  runCommand(
    'pnpm',
    ['--config.node-linker=hoisted', 'deploy', '--prod', '--legacy', '--filter=.', appDir],
    { inherit: true },
  )

  for (const extra of ['install.sh', 'README.md', 'README.zh.md']) {
    const extraPath = join(appDir, extra)
    if (existsSync(extraPath)) rmSync(extraPath, { force: true })
  }
}

function createAppSelfLink(appDir) {
  const selfLinkPath = join(appDir, 'node_modules', 'oh-my-dsh')
  if (existsSync(selfLinkPath)) {
    rmSync(selfLinkPath, { recursive: true, force: true })
  }
  symlinkSync('..', selfLinkPath)
}

function writeLauncher(launcherPath) {
  const script = `#!/bin/sh
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$SCRIPT_DIR/runtime/bin/node" "$SCRIPT_DIR/app/bin/omd" "$@"
`
  writeFileSync(launcherPath, script, { mode: 0o755 })
}

function collectPackageEntries(nodeModulesDir, entries = new Map()) {
  if (!existsSync(nodeModulesDir)) return entries
  for (const entry of readdirSync(nodeModulesDir)) {
    if (entry.startsWith('.')) continue
    const entryPath = join(nodeModulesDir, entry)
    const stat = statSync(entryPath)
    if (!stat.isDirectory()) continue
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(entryPath)) {
        addPackageEntry(join(entryPath, scoped), entries)
      }
      continue
    }
    addPackageEntry(entryPath, entries)
  }
  return entries
}

function addPackageEntry(packageDir, entries) {
  const packageJsonPath = join(packageDir, 'package.json')
  if (!existsSync(packageJsonPath)) return
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    const name = typeof pkg.name === 'string' ? pkg.name : basename(packageDir)
    const version = typeof pkg.version === 'string' ? pkg.version : 'UNKNOWN'
    const license = formatLicense(pkg.license)
    entries.set(`${name}@${version}`, { name, version, license, directory: packageDir })
  } catch {
    // ignore malformed package metadata
  }
  const nested = join(packageDir, 'node_modules')
  if (existsSync(nested)) collectPackageEntries(nested, entries)
}

function formatLicense(license) {
  if (typeof license === 'string') return license
  if (license && typeof license === 'object' && typeof license.type === 'string') {
    return license.type
  }
  return 'UNKNOWN'
}

function generateThirdPartyNotices(versionDir, packages) {
  const lines = [
    'THIRD PARTY NOTICES',
    '',
    'oh-my-dsh portable distribution includes the following third-party software:',
    '',
  ]
  for (const pkg of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`${pkg.name}@${pkg.version}`)
    lines.push(`  License: ${pkg.license}`)
    lines.push('')
  }
  writeFileSync(join(versionDir, 'THIRD_PARTY_NOTICES'), `${lines.join('\n')}\n`, 'utf8')
}

function generateSbom(versionDir, packages, omdVersion) {
  const documentNamespace = `https://amplifthq.github.io/oh-my-dsh/spdx/${omdVersion}/${Date.now()}`
  const spdxPackages = [...packages.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((pkg, index) => ({
      name: pkg.name,
      SPDXID: `SPDXRef-Package-${index + 1}`,
      versionInfo: pkg.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: pkg.license,
      licenseDeclared: pkg.license,
      copyrightText: 'NOASSERTION',
    }))

  const sbom = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `oh-my-dsh-${omdVersion}`,
    documentNamespace,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ['Tool: oh-my-dsh build-portable-distribution'],
    },
    packages: [
      {
        name: 'oh-my-dsh',
        SPDXID: 'SPDXRef-Package-Root',
        versionInfo: omdVersion,
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        licenseConcluded: 'MIT',
        licenseDeclared: 'MIT',
        copyrightText: 'NOASSERTION',
      },
      ...spdxPackages,
    ],
  }
  writeFileSync(join(versionDir, 'sbom.spdx.json'), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8')
}

function createDistributionInfo({ version, platform, nodeVersion, gitCommit, gitTag }) {
  return {
    schemaVersion: 1,
    omdVersion: version,
    gitCommit,
    gitTag,
    platform,
    nodeVersion: nodeVersion.replace(/^v/, ''),
    dshVersion: dshVersion(),
    lockfileDigest: lockfileDigest(),
    buildTime: new Date().toISOString(),
    sbomPath: 'sbom.spdx.json',
  }
}

function createTarArchive(sourceDir, archivePath, topLevelName) {
  mkdirSync(dirname(archivePath), { recursive: true })
  if (existsSync(archivePath)) unlinkSync(archivePath)
  const result = spawnSync(
    'tar',
    ['-czf', archivePath, '-C', dirname(sourceDir), basename(sourceDir)],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'tar archive creation failed')
  }
}

function writeSha256Sums(outDir, entries) {
  const lines = entries
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map(({ filename, sha256 }) => `${sha256}  ${filename}\n`)
  writeFileSync(join(outDir, 'SHA256SUMS'), lines.join(''), 'utf8')
}

function readReleaseManifest(outDir) {
  const manifestPath = join(outDir, 'release-manifest.json')
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

function writeReleaseManifest(outDir, manifest) {
  writeFileSync(join(outDir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const platform = normalizePlatform(...resolvePlatformArgs(options.platform))
  const outDir = resolve(workspaceRoot, options.outDir)
  const nodeVersion = (options.nodeVersion || defaultNodeVersion()).replace(/^v/, '')
  const version = packageJson.version
  const versionDirName = `oh-my-dsh-v${version}`
  const archiveName = `${versionDirName}-${platform}.tar.gz`
  const gitCommit = readGitCommit()
  const gitTag = readGitTag(version)

  console.log(`building portable distribution ${version} for ${platform}`)
  runCommand('pnpm', ['run', 'build'], { inherit: true })

  const stagingRoot = mkdtempSync(join(tmpdir(), 'omd-portable-staging-'))
  const versionDir = join(stagingRoot, versionDirName)
  const appDir = join(versionDir, 'app')

  try {
    materializeApp(appDir)
    await materializeNodeRuntime(versionDir, platform, nodeVersion, options.dryRunNode)

    mkdirSync(join(versionDir, 'bin'), { recursive: true })
    writeLauncher(join(versionDir, 'bin', 'omd'))
    copyFileSync(join(workspaceRoot, 'LICENSE'), join(versionDir, 'LICENSE'))

    const packages = collectPackageEntries(join(appDir, 'node_modules'))
    generateThirdPartyNotices(versionDir, packages)
    generateSbom(versionDir, packages, version)

    const distributionInfo = createDistributionInfo({
      version,
      platform,
      nodeVersion,
      gitCommit,
      gitTag,
    })
    writeFileSync(
      join(versionDir, 'distribution.json'),
      `${JSON.stringify(distributionInfo, null, 2)}\n`,
      'utf8',
    )

    const fileManifest = await generateFileManifest(versionDir)
    createAppSelfLink(appDir)
    fileManifest.files['app/node_modules/oh-my-dsh'] = sha256Buffer('..')
    writeFileSync(
      join(versionDir, 'distribution-files.json'),
      `${JSON.stringify(fileManifest, null, 2)}\n`,
      'utf8',
    )

    mkdirSync(outDir, { recursive: true })
    const archivePath = join(outDir, archiveName)
    createTarArchive(versionDir, archivePath, versionDirName)

    const archiveSha256 = sha256File(archivePath)
    writeSha256Sums(outDir, [{ filename: archiveName, sha256: archiveSha256 }])
    copyFileSync(
      join(versionDir, 'distribution-files.json'),
      join(outDir, 'distribution-files.json'),
    )

    const artifactUrl = `${repositoryUrl}/releases/download/${gitTag}/${archiveName}`
    const existingManifest = readReleaseManifest(outDir) || {
      schemaVersion: 1,
      omdVersion: version,
      releasedAt: new Date().toISOString(),
      tag: gitTag,
      channel: 'stable',
      artifacts: {},
    }
    existingManifest.omdVersion = version
    existingManifest.releasedAt = new Date().toISOString()
    existingManifest.tag = gitTag
    existingManifest.channel = 'stable'
    existingManifest.artifacts[platform] = {
      filename: archiveName,
      sha256: archiveSha256,
      size: statSync(archivePath).size,
      platform,
      nodeVersion: nodeVersion.replace(/^v/, ''),
      dshVersion: dshVersion(),
      url: artifactUrl,
    }
    writeReleaseManifest(outDir, existingManifest)

    console.log(`wrote ${archivePath}`)
    console.log(`wrote ${join(outDir, 'release-manifest.json')}`)
    console.log(`wrote ${join(outDir, 'SHA256SUMS')}`)
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}

function resolvePlatformArgs(platformArg) {
  if (!platformArg) return []
  const [os, arch] = platformArg.split('-')
  if (!os || !arch) throw new Error(`invalid platform tuple: ${platformArg}`)
  return [os, arch]
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
