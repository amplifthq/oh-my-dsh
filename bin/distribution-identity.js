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
    } catch (error) {
      return {
        mode: 'corrupt-portable',
        distributionRoot: dirname(resolved),
        error: error instanceof Error ? error.message : String(error),
      }
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
    } catch (error) {
      return {
        mode: 'corrupt-portable',
        distributionRoot: resolved,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return { mode: 'npm' }
}
