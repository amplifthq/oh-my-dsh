import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

function hashPathSha256(filePath) {
  const stat = lstatSync(filePath)
  if (stat.isSymbolicLink()) {
    return createHash('sha256').update(readlinkSync(filePath)).digest('hex')
  }
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

    const stat = lstatSync(fullPath)
    if (stat.isSymbolicLink()) {
      results.push(relPath)
      continue
    }
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
    map[file] = hashPathSha256(join(resolved, file))
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
    const currentHash = hashPathSha256(join(resolved, relPath))
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
