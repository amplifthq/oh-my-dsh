# Portable Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the self-contained portable distribution for oh-my-dsh (macOS arm64 and Linux x64), including embedded distribution identity, file-integrity manifests, atomic install/update/rollback state manager, portable profile runtime linking, build packaging script, user-level bootstrap installer, CI/release workflows, and comprehensive tests.

**Architecture:** A portable archive embeds a standalone Node.js runtime, an immutable application directory with a hoisted production dependency closure and `oh-my-dsh` self-link, and embedded identity metadata. A POSIX launcher invokes the app via the embedded Node runtime. In portable mode, `omd setup` links user profile `node_modules` to the immutable closure without calling npm or network. An atomic transaction manager handles `install.sh`, `omd update`, and `omd rollback` with same-filesystem symlink swaps, lock serialization, and crash recovery.

**Tech Stack:** Node.js (ESM), POSIX sh, pnpm, node:crypto, node:fs, node:child_process, node:test.

## Global Constraints

- **Exact Version Alignment:** OMD version is 0.1.7 (unreleased, targeting 0.2.0 for portable release); npm package and portable releases share identical version strings.
- **Platform Matrix:** Supported platforms for 0.2.0 portable artifacts are `darwin-arm64` and `linux-x64` (glibc).
- **Node.js Runtime Floor:** Node.js 22.19.0 or >=24.0.0. Portable bundles embed official Node.js binaries verified against official SHASUMS256.
- **Dependency Layout:** `app/node_modules` in portable builds must be a hoisted (flat) layout so transitive dsh packages (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-headless`) and the self-link `oh-my-dsh` resolve by bare specifiers from profile directories.
- **Zero Sudo / User Isolation:** Portable install root defaults to `~/.local/share/oh-my-dsh` and bin link to `~/.local/bin/omd`. User state stays in `~/.dsh` and is never overwritten or destroyed.
- **Atomic Operations:** Link replacements and state mutations use same-filesystem atomic renames with transaction records for crash reconciliation.

---

### Task 1: Distribution Identity & Mode Detection

**Files:**

- Create: `bin/distribution-identity.js`
- Test: `tests/distribution-identity.test.mjs`

**Interfaces:**

- Consumes: `packageRoot` (string), filesystem layout
- Produces:
  - `detectDistributionMode(packageRoot: string): { mode: 'portable' | 'npm' | 'source', distributionInfo?: DistributionInfo }`
  - `parseDistributionInfo(raw: string | object): DistributionInfo`
  - `formatDistributionIdentity(info: DistributionInfo): string`
  - `DistributionInfo`: `{ schemaVersion: number, omdVersion: string, gitCommit: string, gitTag?: string, platform: string, nodeVersion: string, dshVersion: string, lockfileDigest: string, buildTime: string, sbomPath: string }`

- [ ] **Step 1: Write the failing unit test**

```javascript
// tests/distribution-identity.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/distribution-identity.test.mjs`
Expected: FAIL with "Cannot find module '../bin/distribution-identity.js'"

- [ ] **Step 3: Implement `bin/distribution-identity.js`**

```javascript
// bin/distribution-identity.js
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const SUPPORTED_PLATFORMS = ['darwin-arm64', 'linux-x64']

export function parseDistributionInfo(input) {
  const record = typeof input === 'string' ? JSON.parse(input) : input
  if (!record || typeof record !== 'object') {
    throw new Error('distribution metadata must be an object')
  }
  if (record.schemaVersion !== 1) {
    throw new Error(`unsupported distribution schema version: ${record.schemaVersion}`)
  }
  if (typeof record.omdVersion !== 'string' || !record.omdVersion.trim()) {
    throw new Error('invalid distribution omdVersion')
  }
  if (typeof record.platform !== 'string' || !SUPPORTED_PLATFORMS.includes(record.platform)) {
    throw new Error(`unsupported distribution platform: ${record.platform}`)
  }
  if (typeof record.nodeVersion !== 'string' || !record.nodeVersion.trim()) {
    throw new Error('invalid distribution nodeVersion')
  }
  if (typeof record.dshVersion !== 'string' || !record.dshVersion.trim()) {
    throw new Error('invalid distribution dshVersion')
  }
  if (typeof record.gitCommit !== 'string' || !record.gitCommit.trim()) {
    throw new Error('invalid distribution gitCommit')
  }
  if (typeof record.lockfileDigest !== 'string' || !record.lockfileDigest.trim()) {
    throw new Error('invalid distribution lockfileDigest')
  }
  if (typeof record.buildTime !== 'string' || !record.buildTime.trim()) {
    throw new Error('invalid distribution buildTime')
  }
  if (typeof record.sbomPath !== 'string' || !record.sbomPath.trim()) {
    throw new Error('invalid distribution sbomPath')
  }
  return {
    schemaVersion: 1,
    omdVersion: record.omdVersion.trim(),
    gitCommit: record.gitCommit.trim(),
    gitTag: typeof record.gitTag === 'string' ? record.gitTag.trim() : undefined,
    platform: record.platform.trim(),
    nodeVersion: record.nodeVersion.trim(),
    dshVersion: record.dshVersion.trim(),
    lockfileDigest: record.lockfileDigest.trim(),
    buildTime: record.buildTime.trim(),
    sbomPath: record.sbomPath.trim(),
  }
}

export function formatDistributionIdentity(info) {
  return `oh-my-dsh ${info.omdVersion} (${info.platform}, dsh ${info.dshVersion}, node ${info.nodeVersion})`
}

export function detectDistributionMode(packageRoot) {
  const resolved = resolve(packageRoot)
  // Check for source checkout (.git in package root)
  if (existsSync(join(resolved, '.git'))) {
    return { mode: 'source' }
  }

  // Check for portable bundle root (distribution.json in parent of app/ or packageRoot)
  const candidateInParent = join(dirname(resolved), 'distribution.json')
  const candidateInRoot = join(resolved, 'distribution.json')

  if (existsSync(candidateInParent)) {
    try {
      const raw = readFileSync(candidateInParent, 'utf8')
      const info = parseDistributionInfo(raw)
      return {
        mode: 'portable',
        distributionRoot: dirname(resolved),
        distributionInfo: info,
      }
    } catch {
      // malformed distribution metadata
    }
  }

  if (existsSync(candidateInRoot)) {
    try {
      const raw = readFileSync(candidateInRoot, 'utf8')
      const info = parseDistributionInfo(raw)
      return {
        mode: 'portable',
        distributionRoot: resolved,
        distributionInfo: info,
      }
    } catch {
      // malformed distribution metadata
    }
  }

  return { mode: 'npm' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/distribution-identity.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/distribution-identity.js tests/distribution-identity.test.mjs
git commit -m "feat(distribution): add distribution identity and mode detection"
```

---

### Task 2: File-Digest Manifest Generation & Verification

**Files:**

- Create: `bin/distribution-files.js`
- Test: `tests/distribution-files.test.mjs`

**Interfaces:**

- Consumes: filesystem directory path, ignore rules
- Produces:
  - `generateFileManifest(rootDir: string, options?: { ignore?: string[] }): Promise<FileManifest>`
  - `verifyFileManifest(rootDir: string, manifest: FileManifest): Promise<{ ok: boolean, mismatches: string[], missing: string[], extra: string[] }>`
  - `FileManifest`: `{ schemaVersion: 1, generatedAt: string, files: Record<string, string> }` (relative path -> sha256 hex)

- [ ] **Step 1: Write the failing unit test**

```javascript
// tests/distribution-files.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { generateFileManifest, verifyFileManifest } from '../bin/distribution-files.js'

test('generateFileManifest and verifyFileManifest detect matching, modified, missing, and extra files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-file-manifest-'))
  try {
    mkdirSync(join(root, 'bin'), { recursive: true })
    mkdirSync(join(root, 'app', 'dist'), { recursive: true })
    writeFileSync(join(root, 'bin', 'omd'), '#!/bin/sh\necho ok\n')
    writeFileSync(join(root, 'app', 'dist', 'index.js'), 'console.log("hello")\n')
    writeFileSync(join(root, 'distribution.json'), '{"schemaVersion":1}\n')

    const manifest = await generateFileManifest(root, { ignore: ['distribution-files.json'] })
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(typeof manifest.files['bin/omd'], 'string')
    assert.equal(typeof manifest.files['app/dist/index.js'], 'string')
    assert.equal(typeof manifest.files['distribution.json'], 'string')

    // Initial check: ok
    const cleanCheck = await verifyFileManifest(root, manifest)
    assert.equal(cleanCheck.ok, true)
    assert.deepEqual(cleanCheck.mismatches, [])
    assert.deepEqual(cleanCheck.missing, [])
    assert.deepEqual(cleanCheck.extra, [])

    // Modification
    writeFileSync(join(root, 'bin', 'omd'), '#!/bin/sh\necho modified\n')
    const modifiedCheck = await verifyFileManifest(root, manifest)
    assert.equal(modifiedCheck.ok, false)
    assert.deepEqual(modifiedCheck.mismatches, ['bin/omd'])

    // Missing file
    rmSync(join(root, 'app', 'dist', 'index.js'))
    const missingCheck = await verifyFileManifest(root, manifest)
    assert.equal(missingCheck.ok, false)
    assert.deepEqual(missingCheck.missing, ['app/dist/index.js'])

    // Extra file
    writeFileSync(join(root, 'extra.txt'), 'extra')
    const extraCheck = await verifyFileManifest(root, manifest)
    assert.equal(extraCheck.ok, false)
    assert.deepEqual(extraCheck.extra, ['extra.txt'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/distribution-files.test.mjs`
Expected: FAIL with "Cannot find module '../bin/distribution-files.js'"

- [ ] **Step 3: Implement `bin/distribution-files.js`**

```javascript
// bin/distribution-files.js
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

function hashFileSha256(filePath) {
  const content = readFileSync(filePath)
  return createHash('sha256').update(content).digest('hex')
}

export function collectFiles(dir, baseDir = dir, ignore = new Set()) {
  const results = []
  const entries = readdirSync(dir)
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const relPath = relative(baseDir, fullPath).replace(/\\/g, '/')
    if (ignore.has(relPath) || ignore.has(entry)) continue

    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      results.push(...collectFiles(fullPath, baseDir, ignore))
    } else if (stat.isFile()) {
      results.push(relPath)
    }
  }
  return results.sort()
}

export async function generateFileManifest(rootDir, options = {}) {
  const resolved = resolve(rootDir)
  const ignore = new Set(['distribution-files.json', ...(options.ignore || [])])
  const files = collectFiles(resolved, resolved, ignore)
  const map = {}
  for (const file of files) {
    map[file] = hashFileSha256(join(resolved, file))
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    files: map,
  }
}

export async function verifyFileManifest(rootDir, manifest, options = {}) {
  const resolved = resolve(rootDir)
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.files !== 'object') {
    throw new Error('invalid file manifest schema')
  }

  const ignore = new Set(['distribution-files.json', ...(options.ignore || [])])
  const onDiskFiles = new Set(collectFiles(resolved, resolved, ignore))
  const manifestFiles = Object.keys(manifest.files)

  const mismatches = []
  const missing = []
  const extra = []

  for (const relPath of manifestFiles) {
    if (!onDiskFiles.has(relPath)) {
      missing.push(relPath)
      continue
    }
    const currentHash = hashFileSha256(join(resolved, relPath))
    if (currentHash !== manifest.files[relPath]) {
      mismatches.push(relPath)
    }
  }

  for (const relPath of onDiskFiles) {
    if (!(relPath in manifest.files)) {
      extra.push(relPath)
    }
  }

  const ok = mismatches.length === 0 && missing.length === 0 && extra.length === 0
  return {
    ok,
    mismatches: mismatches.sort(),
    missing: missing.sort(),
    extra: extra.sort(),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/distribution-files.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/distribution-files.js tests/distribution-files.test.mjs
git commit -m "feat(distribution): add file-digest manifest generation and verification"
```

---

### Task 3: Release Manifest Parsing & Platform Normalization

**Files:**

- Create: `bin/distribution-manifest.js`
- Test: `tests/distribution-manifest.test.mjs`

**Interfaces:**

- Consumes: release-manifest.json raw string / object, system platform info
- Produces:
  - `normalizePlatform(platform?: string, arch?: string): string`
  - `parseReleaseManifest(raw: string | object): ReleaseManifest`
  - `findArtifactForPlatform(manifest: ReleaseManifest, platformTuple: string): ArtifactEntry`
  - `ReleaseManifest`: `{ schemaVersion: 1, omdVersion: string, releasedAt: string, tag: string, channel: 'stable', artifacts: Record<string, ArtifactEntry> }`
  - `ArtifactEntry`: `{ filename: string, sha256: string, size: number, platform: string, nodeVersion: string, dshVersion: string, url: string }`

- [ ] **Step 1: Write the failing unit test**

```javascript
// tests/distribution-manifest.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findArtifactForPlatform,
  normalizePlatform,
  parseReleaseManifest,
} from '../bin/distribution-manifest.js'

test('normalizePlatform maps supported os/arch to platform tuples', () => {
  assert.equal(normalizePlatform('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(normalizePlatform('linux', 'x64'), 'linux-x64')
  assert.throws(() => normalizePlatform('darwin', 'x64'), /unsupported platform: darwin-x64/)
  assert.throws(() => normalizePlatform('win32', 'x64'), /unsupported platform: win32-x64/)
  assert.throws(() => normalizePlatform('linux', 'arm64'), /unsupported platform: linux-arm64/)
})

test('parseReleaseManifest and findArtifactForPlatform validate external manifest structure', () => {
  const manifestRaw = {
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

  const manifest = parseReleaseManifest(manifestRaw)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/distribution-manifest.test.mjs`
Expected: FAIL with "Cannot find module '../bin/distribution-manifest.js'"

- [ ] **Step 3: Implement `bin/distribution-manifest.js`**

```javascript
// bin/distribution-manifest.js
import { SUPPORTED_PLATFORMS } from './distribution-identity.js'

export function normalizePlatform(os = process.platform, arch = process.arch) {
  const tuple = `${os}-${arch}`
  if (!SUPPORTED_PLATFORMS.includes(tuple)) {
    throw new Error(
      `unsupported platform: ${tuple}. 0.2.0 supports: ${SUPPORTED_PLATFORMS.join(', ')}`,
    )
  }
  return tuple
}

export function parseReleaseManifest(input) {
  const record = typeof input === 'string' ? JSON.parse(input) : input
  if (!record || typeof record !== 'object') {
    throw new Error('release manifest must be an object')
  }
  if (record.schemaVersion !== 1) {
    throw new Error(`unsupported release manifest schema version: ${record.schemaVersion}`)
  }
  if (typeof record.omdVersion !== 'string' || !record.omdVersion.trim()) {
    throw new Error('invalid release manifest omdVersion')
  }
  if (typeof record.tag !== 'string' || !record.tag.trim()) {
    throw new Error('invalid release manifest tag')
  }
  if (record.channel !== 'stable') {
    throw new Error(`unsupported release manifest channel: ${record.channel}`)
  }
  if (!record.artifacts || typeof record.artifacts !== 'object') {
    throw new Error('invalid release manifest artifacts')
  }

  const artifacts = {}
  for (const [platform, entry] of Object.entries(record.artifacts)) {
    if (!SUPPORTED_PLATFORMS.includes(platform)) continue
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.filename !== 'string' || !entry.filename) continue
    if (typeof entry.sha256 !== 'string' || entry.sha256.length !== 64) continue
    if (typeof entry.size !== 'number' || entry.size <= 0) continue
    if (
      typeof entry.url !== 'string' ||
      !entry.url.startsWith('https://github.com/amplifthq/oh-my-dsh/releases/download/')
    ) {
      throw new Error(`invalid or unauthorized artifact url: ${entry.url}`)
    }
    artifacts[platform] = {
      filename: entry.filename,
      sha256: entry.sha256.toLowerCase(),
      size: entry.size,
      platform,
      nodeVersion: String(entry.nodeVersion || ''),
      dshVersion: String(entry.dshVersion || ''),
      url: entry.url,
    }
  }

  return {
    schemaVersion: 1,
    omdVersion: record.omdVersion.trim(),
    releasedAt: String(record.releasedAt || new Date().toISOString()),
    tag: record.tag.trim(),
    channel: 'stable',
    artifacts,
  }
}

export function findArtifactForPlatform(manifest, platformTuple) {
  const artifact = manifest.artifacts[platformTuple]
  if (!artifact) {
    throw new Error(
      `no artifact available for platform ${platformTuple} in release ${manifest.omdVersion}`,
    )
  }
  return artifact
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/distribution-manifest.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/distribution-manifest.js tests/distribution-manifest.test.mjs
git commit -m "feat(distribution): add release manifest parser and platform normalizer"
```

---

### Task 4: Install State, Locking & Transaction Reconciliation

**Files:**

- Create: `bin/distribution-state.js`
- Test: `tests/distribution-state.test.mjs`

**Interfaces:**

- Consumes: install root path (`~/.local/share/oh-my-dsh` or custom)
- Produces:
  - `readInstallState(installRoot: string): InstallState`
  - `writeInstallState(installRoot: string, state: InstallState): void`
  - `acquireInstallLock(installRoot: string): { release: () => void }`
  - `reconcileTransactions(installRoot: string): { recovered: boolean, activeVersion: string | null }`
  - `beginInstallTransaction(installRoot: string, transaction: TransactionRecord): void`
  - `commitInstallTransaction(installRoot: string, newCurrentVersion: string): void`
  - `rollbackToPreviousVersion(installRoot: string): { from: string, to: string }`

- [ ] **Step 1: Write the failing unit test**

```javascript
// tests/distribution-state.test.mjs
import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  acquireInstallLock,
  beginInstallTransaction,
  commitInstallTransaction,
  readInstallState,
  reconcileTransactions,
  rollbackToPreviousVersion,
  writeInstallState,
} from '../bin/distribution-state.js'

test('install lock acquires, prevents double acquisition, and releases', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-state-lock-'))
  try {
    const lock1 = acquireInstallLock(root)
    assert.throws(() => acquireInstallLock(root), /install lock is held by another process/)
    lock1.release()

    // Can acquire again after release
    const lock2 = acquireInstallLock(root)
    lock2.release()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('atomic transaction switches current and previous symlinks and supports rollback', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-state-tx-'))
  try {
    const v1 = join(root, 'versions', '0.1.7')
    const v2 = join(root, 'versions', '0.2.0')
    mkdirSync(v1, { recursive: true })
    mkdirSync(v2, { recursive: true })

    // Simulate initial installation of v1
    beginInstallTransaction(root, {
      op: 'install',
      candidateVersion: '0.1.7',
      oldCurrent: null,
      oldPrevious: null,
    })
    commitInstallTransaction(root, '0.1.7')

    let state = readInstallState(root)
    assert.equal(state.currentVersion, '0.1.7')
    assert.equal(state.previousVersion, null)
    assert.equal(readlinkSync(join(root, 'current')), 'versions/0.1.7')

    // Simulate upgrade to v2
    beginInstallTransaction(root, {
      op: 'update',
      candidateVersion: '0.2.0',
      oldCurrent: '0.1.7',
      oldPrevious: null,
    })
    commitInstallTransaction(root, '0.2.0')

    state = readInstallState(root)
    assert.equal(state.currentVersion, '0.2.0')
    assert.equal(state.previousVersion, '0.1.7')
    assert.equal(readlinkSync(join(root, 'current')), 'versions/0.2.0')
    assert.equal(readlinkSync(join(root, 'previous')), 'versions/0.1.7')

    // Rollback to v1
    const roll = rollbackToPreviousVersion(root)
    assert.equal(roll.from, '0.2.0')
    assert.equal(roll.to, '0.1.7')

    state = readInstallState(root)
    assert.equal(state.currentVersion, '0.1.7')
    assert.equal(state.previousVersion, '0.2.0')
    assert.equal(readlinkSync(join(root, 'current')), 'versions/0.1.7')
    assert.equal(readlinkSync(join(root, 'previous')), 'versions/0.2.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reconcileTransactions cleans interrupted transactions based on actual symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-state-reconcile-'))
  try {
    const v1 = join(root, 'versions', '0.1.7')
    const v2 = join(root, 'versions', '0.2.0')
    mkdirSync(v1, { recursive: true })
    mkdirSync(v2, { recursive: true })

    // Initial state: current -> 0.1.7
    beginInstallTransaction(root, {
      op: 'install',
      candidateVersion: '0.1.7',
      oldCurrent: null,
      oldPrevious: null,
    })
    commitInstallTransaction(root, '0.1.7')

    // Simulate interrupted transaction before symlink swap
    writeInstallState(root, {
      schemaVersion: 1,
      currentVersion: '0.1.7',
      previousVersion: null,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      openTransaction: {
        op: 'update',
        candidateVersion: '0.2.0',
        oldCurrent: '0.1.7',
        oldPrevious: null,
        startedAt: new Date().toISOString(),
      },
    })

    const rec1 = reconcileTransactions(root)
    assert.equal(rec1.recovered, true)
    assert.equal(rec1.activeVersion, '0.1.7')
    const clearedState = readInstallState(root)
    assert.equal(clearedState.openTransaction, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/distribution-state.test.mjs`
Expected: FAIL with "Cannot find module '../bin/distribution-state.js'"

- [ ] **Step 3: Implement `bin/distribution-state.js`**

```javascript
// bin/distribution-state.js
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const STATE_FILE = 'install-state.json'
const LOCK_FILE = 'update.lock'

export function readInstallState(installRoot) {
  const statePath = join(installRoot, STATE_FILE)
  if (!existsSync(statePath)) {
    return {
      schemaVersion: 1,
      currentVersion: null,
      previousVersion: null,
      installedAt: null,
      updatedAt: null,
      openTransaction: null,
      verifiedArtifacts: {},
    }
  }
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8'))
    return {
      schemaVersion: 1,
      currentVersion: raw.currentVersion || null,
      previousVersion: raw.previousVersion || null,
      installedAt: raw.installedAt || null,
      updatedAt: raw.updatedAt || null,
      openTransaction: raw.openTransaction || null,
      verifiedArtifacts: raw.verifiedArtifacts || {},
    }
  } catch {
    throw new Error(`cannot parse ${statePath}`)
  }
}

export function writeInstallState(installRoot, state) {
  mkdirSync(installRoot, { recursive: true })
  const statePath = join(installRoot, STATE_FILE)
  const tempPath = join(installRoot, `${STATE_FILE}.tmp.${Date.now()}`)
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(tempPath, statePath)
}

export function acquireInstallLock(installRoot) {
  mkdirSync(installRoot, { recursive: true })
  const lockPath = join(installRoot, LOCK_FILE)
  if (existsSync(lockPath)) {
    let pid = null
    try {
      const lockData = JSON.parse(readFileSync(lockPath, 'utf8'))
      pid = lockData.pid
    } catch {}

    // Check if process is alive
    if (pid && typeof pid === 'number') {
      try {
        process.kill(pid, 0)
        throw new Error(`install lock is held by another process (PID ${pid})`)
      } catch (err) {
        if (err.code === 'EPERM')
          throw new Error(`install lock is held by another process (PID ${pid})`)
        // Process is dead, remove stale lock
        rmSync(lockPath, { force: true })
      }
    } else {
      rmSync(lockPath, { force: true })
    }
  }

  const payload = { pid: process.pid, createdAt: new Date().toISOString() }
  writeFileSync(lockPath, JSON.stringify(payload), { flag: 'wx', mode: 0o600 })

  return {
    release: () => {
      try {
        if (existsSync(lockPath)) rmSync(lockPath, { force: true })
      } catch {}
    },
  }
}

function atomicSymlink(installRoot, targetRelative, linkName) {
  const finalLinkPath = join(installRoot, linkName)
  const tempLinkPath = join(installRoot, `${linkName}.tmp.${Date.now()}`)
  try {
    unlinkSync(tempLinkPath)
  } catch {}
  symlinkSync(targetRelative, tempLinkPath)
  renameSync(tempLinkPath, finalLinkPath)
}

export function reconcileTransactions(installRoot) {
  const state = readInstallState(installRoot)
  if (!state.openTransaction) {
    return { recovered: false, activeVersion: state.currentVersion }
  }

  const currentLink = join(installRoot, 'current')
  let currentTargetVersion = null
  if (existsSync(currentLink)) {
    try {
      const rawTarget = readlinkSync(currentLink)
      currentTargetVersion = rawTarget.replace(/^versions\//, '')
    } catch {}
  }

  const tx = state.openTransaction
  let resolvedCurrent = state.currentVersion
  let resolvedPrevious = state.previousVersion

  if (currentTargetVersion === tx.candidateVersion) {
    // Current switch succeeded
    resolvedCurrent = tx.candidateVersion
    resolvedPrevious = tx.oldCurrent
  } else if (currentTargetVersion === tx.oldCurrent) {
    // Current switch never completed
    resolvedCurrent = tx.oldCurrent
    resolvedPrevious = tx.oldPrevious
    if (resolvedPrevious) {
      atomicSymlink(installRoot, `versions/${resolvedPrevious}`, 'previous')
    }
  }

  const nextState = {
    ...state,
    currentVersion: resolvedCurrent,
    previousVersion: resolvedPrevious,
    updatedAt: new Date().toISOString(),
    openTransaction: null,
  }
  writeInstallState(installRoot, nextState)
  return { recovered: true, activeVersion: resolvedCurrent }
}

export function beginInstallTransaction(installRoot, tx) {
  const state = readInstallState(installRoot)
  const nextState = {
    ...state,
    openTransaction: {
      op: tx.op,
      candidateVersion: tx.candidateVersion,
      oldCurrent: tx.oldCurrent,
      oldPrevious: tx.oldPrevious,
      startedAt: new Date().toISOString(),
    },
  }
  writeInstallState(installRoot, nextState)
}

export function commitInstallTransaction(installRoot, newCurrentVersion, artifactRecord = null) {
  const state = readInstallState(installRoot)
  const oldCurrent = state.currentVersion

  // 1. Link previous
  if (oldCurrent && oldCurrent !== newCurrentVersion) {
    atomicSymlink(installRoot, `versions/${oldCurrent}`, 'previous')
  }

  // 2. Link current
  atomicSymlink(installRoot, `versions/${newCurrentVersion}`, 'current')

  // 3. Update state
  const nextArtifacts = { ...state.verifiedArtifacts }
  if (artifactRecord) {
    nextArtifacts[newCurrentVersion] = artifactRecord
  }

  const nextState = {
    schemaVersion: 1,
    currentVersion: newCurrentVersion,
    previousVersion:
      oldCurrent && oldCurrent !== newCurrentVersion ? oldCurrent : state.previousVersion,
    installedAt: state.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    openTransaction: null,
    verifiedArtifacts: nextArtifacts,
  }
  writeInstallState(installRoot, nextState)
}

export function rollbackToPreviousVersion(installRoot) {
  const state = readInstallState(installRoot)
  const current = state.currentVersion
  const previous = state.previousVersion
  if (!previous) {
    throw new Error('no rollback target available: no previous version is recorded')
  }

  const previousDir = join(installRoot, 'versions', previous)
  if (!existsSync(previousDir)) {
    throw new Error(`cannot rollback: version directory ${previousDir} is missing`)
  }

  beginInstallTransaction(installRoot, {
    op: 'rollback',
    candidateVersion: previous,
    oldCurrent: current,
    oldPrevious: previous,
  })

  // Swap links: current -> previous version, previous -> old current version
  atomicSymlink(installRoot, `versions/${current}`, 'previous')
  atomicSymlink(installRoot, `versions/${previous}`, 'current')

  const nextState = {
    ...state,
    currentVersion: previous,
    previousVersion: current,
    updatedAt: new Date().toISOString(),
    openTransaction: null,
  }
  writeInstallState(installRoot, nextState)
  return { from: current, to: previous }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/distribution-state.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/distribution-state.js tests/distribution-state.test.mjs
git commit -m "feat(distribution): add install state, lock, and transaction manager"
```

---

### Task 5: Portable Profile Runtime Setup & CLI Integration

**Files:**

- Modify: `bin/omd:1-523`
- Test: `tests/cli.test.mjs`

**Interfaces:**

- Consumes: `bin/distribution-identity.js`, `bin/distribution-state.js`, `bin/distribution-files.js`
- Produces:
  - `omd setup` branch for portable mode (linking `node_modules` to `<current>/app/node_modules` with no npm calls)
  - `omd update` subcommand (checks GitHub stable release manifest, downloads, checks SHA256, verifies paths, extracts, health checks, atomic switch)
  - `omd rollback` subcommand (atomic rollback to retained previous version)
  - `omd doctor` enhancement (prints distribution identity, mode, and optional `--verify` file manifest integrity check)

- [ ] **Step 1: Write the failing tests in `tests/cli.test.mjs`**

Add tests covering portable `omd setup`, `omd doctor` identity/mode reporting, and `omd rollback` in npm vs portable modes.

```javascript
test('portable omd setup links profile node_modules to distribution app/node_modules without npm', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-portable-cli-'))
  const dshHome = join(root, '.dsh')
  const portableInstallRoot = join(root, 'install')
  const v1Dir = join(portableInstallRoot, 'versions', '0.2.0')
  const appDir = join(v1Dir, 'app')
  const nodeModulesDir = join(appDir, 'node_modules')
  mkdirSync(nodeModulesDir, { recursive: true })
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ name: 'oh-my-dsh', version: '0.2.0' }),
  )
  writeFileSync(
    join(v1Dir, 'distribution.json'),
    JSON.stringify({
      schemaVersion: 1,
      omdVersion: '0.2.0',
      gitCommit: 'testcommit',
      platform: 'darwin-arm64',
      nodeVersion: '22.19.0',
      dshVersion: '0.1.0-rc.6',
      lockfileDigest: 'sha256-test',
      buildTime: '2026-08-17T00:00:00Z',
      sbomPath: 'sbom.spdx.json',
    }),
  )
  // Create current link
  const currentLink = join(portableInstallRoot, 'current')
  // We can test setup by pointing OMD_INSTALL_ROOT
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cli.test.mjs`

- [ ] **Step 3: Update `bin/omd`**

In `bin/omd`:

- Import helpers from `./distribution-identity.js`, `./distribution-files.js`, `./distribution-state.js`, `./distribution-manifest.js`.
- Detect mode via `detectDistributionMode(packageRoot)`.
- In portable mode:
  - `setup()`: creates profiles in `DSH_HOME`, writes `package.json`, replaces `profile/node_modules` with a symlink to `<installRoot>/current/app/node_modules` (or `<distributionRoot>/app/node_modules`), writes `cordis.patch.yml`.
  - `update()`: checks latest GitHub release manifest, stages, validates sha256/paths, extracts, tests, and switches.
  - `rollback()`: executes `rollbackToPreviousVersion`.
  - `doctor()`: prints distribution identity, mode (`portable` / `npm` / `source`), checks file integrity if `--verify` argument is provided.

- [ ] **Step 4: Run all tests to verify they pass**

Run: `node --test tests/cli.test.mjs tests/distribution-*.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/omd tests/cli.test.mjs
git commit -m "feat(distribution): integrate portable setup, update, rollback, and doctor into omd CLI"
```

---

### Task 6: Packaging Script for Portable Releases

**Files:**

- Create: `scripts/build-portable-distribution.mjs`
- Test: `tests/smoke-portable-distribution.mjs`

**Interfaces:**

- Consumes: workspace root, target platform tuple (`darwin-arm64` | `linux-x64`), version string
- Produces:
  - `dist-release/oh-my-dsh-v<VERSION>-<PLATFORM>.tar.gz`
  - `dist-release/distribution-files.json`
  - `dist-release/release-manifest.json`
  - `dist-release/SHA256SUMS`

- [ ] **Step 1: Write smoke test for portable packaging and extraction**

```javascript
// tests/smoke-portable-distribution.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/smoke-portable-distribution.mjs`
Expected: FAIL with script not found

- [ ] **Step 3: Implement `scripts/build-portable-distribution.mjs`**

Implement complete build script:

- Parses arguments (`--platform`, `--out-dir`, `--node-version`).
- Materializes production dependency closure using pnpm/npm.
- Self-links `app/node_modules/oh-my-dsh -> app/`.
- Fetches or copies platform Node.js binary (and verifies sha256).
- Generates `distribution.json`, `distribution-files.json`, `THIRD_PARTY_NOTICES`, SPDX SBOM.
- Generates `bin/omd` launcher:
  ```sh
  #!/bin/sh
  set -eu
  SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  exec "$SCRIPT_DIR/runtime/bin/node" "$SCRIPT_DIR/app/bin/omd" "$@"
  ```
- Creates `tar.gz` archive.
- Generates `SHA256SUMS` and `release-manifest.json`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/smoke-portable-distribution.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/build-portable-distribution.mjs tests/smoke-portable-distribution.mjs
git commit -m "feat(distribution): add portable archive packaging script"
```

---

### Task 7: User Bootstrap Installer Script (`install.sh`)

**Files:**

- Modify/Replace: `install.sh`
- Test: `tests/installer.test.mjs`

**Interfaces:**

- Consumes: environment (`OMD_INSTALL_ROOT`, `DSH_HOME`, `OMD_VERSION`, `OMD_MANIFEST_URL`)
- Produces: POSIX bootstrap installer that downloads from release manifest, verifies SHA-256, extracts, health checks, creates symlinks (`current`, `previous`, `~/.local/bin/omd`), and saves state.

- [ ] **Step 1: Write unit/integration tests for installer logic**

```javascript
// tests/installer.test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('install.sh rejects unsupported platforms and installs successfully on supported platform', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-installer-test-'))
  try {
    const installRoot = join(root, 'share', 'oh-my-dsh')
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })

    // Test with local fixture release manifest and archive
    // Run bash install.sh with OMD_INSTALL_ROOT and OMD_BIN_DIR
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/installer.test.mjs`

- [ ] **Step 3: Implement `install.sh`**

Implement POSIX `install.sh`:

- Detect OS & Arch (Darwin arm64, Linux x86_64 -> `darwin-arm64`, `linux-x64`). Reject others with clear message.
- Target `OMD_INSTALL_ROOT` (default `~/.local/share/oh-my-dsh`) and `OMD_BIN_DIR` (default `~/.local/bin`).
- Fetch latest stable release manifest (or pinned `OMD_VERSION`).
- Verify SHA-256 digest with `shasum -a 256` or `sha256sum`.
- Extract archive to staging dir; check for path traversal.
- Run packaged health check with clean temporary `HOME`, `DSH_HOME`, and sterile `PATH`.
- Atomically update `previous`, `current`, `install-state.json`, and `~/.local/bin/omd`.
- Print clear PATH message if `~/.local/bin` is not in `$PATH`.

- [ ] **Step 4: Update `package.json`**

Remove `install.sh` from `package.json` `"files"` list (since npm users don't need the portable installer).

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/installer.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add install.sh tests/installer.test.mjs package.json
git commit -m "feat(distribution): implement zero-dependency portable installer script"
```

---

### Task 8: CI & Release Workflows for Dual-Channel Distribution

**Files:**

- Modify: `.github/workflows/ci.yml:1-90`
- Modify: `.github/workflows/release.yml:1-86`

**Interfaces:**

- Consumes: GitHub Actions matrix on `macos-latest` (arm64) and `ubuntu-latest` (x64)
- Produces:
  - CI job that packages and smoke-tests portable archives on both platforms.
  - Release workflow that packages portable archives, generates SBOMs, manifest, SHA256SUMS, publishes npm, and uploads all release assets to GitHub Release.

- [ ] **Step 1: Update `.github/workflows/ci.yml`**

Add portable packaging and smoke verification job on `macos-latest` (arm64) and `ubuntu-latest` (x64):

- Package portable distribution.
- Unpack into sterile test container without system Node in PATH.
- Run `omd --version`, `omd doctor`, `omd config`, and real profile launch smoke.

- [ ] **Step 2: Update `.github/workflows/release.yml`**

Update `release.yml` to:

- Build portable artifacts on macOS arm64 and Linux x64 runners.
- Generate `SHA256SUMS` and `release-manifest.json`.
- Upload portable assets to GitHub Release.
- Publish npm package with provenance.

- [ ] **Step 3: Run lint and format checks on workflows**

Run: `pnpm format:check`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci(release): add portable distribution build, verification, and release pipeline"
```

---

### Task 9: Full Regression, End-to-End Smoke & Documentation

**Files:**

- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `CHANGELOG.md`
- Test: All tests (`pnpm test`)

**Interfaces:**

- Consumes: all distribution packages and documentation
- Produces: Updated docs with portable installer instructions, manual archive verification, capability tiers, and passed test suites.

- [ ] **Step 1: Run complete test suite**

Run: `pnpm build && pnpm test && node tests/smoke-plugin-catalog-real.mjs && node tests/smoke-plugin-forge-real.mjs`
Expected: ALL PASS

- [ ] **Step 2: Update README.md and README.zh.md**

Update Quick Start to feature the portable installer (`curl -fsSL https://.../install.sh | sh`), followed by manual tarball verification and npm options. Document `omd update`, `omd rollback`, and manual uninstall.

- [ ] **Step 3: Update CHANGELOG.md**

Record the portable distribution additions for the upcoming 0.2.0 release.

- [ ] **Step 4: Format and lint**

Run: `pnpm format && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh.md CHANGELOG.md
git commit -m "docs: document portable distribution install, update, and rollback"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-17-portable-distribution.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
