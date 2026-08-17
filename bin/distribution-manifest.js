import { SUPPORTED_PLATFORMS } from './distribution-identity.js'

export const OMD_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$/
const ARTIFACT_FILENAME_PATTERN = /^[a-zA-Z0-9_.-]+\.tar\.gz$/
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/

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
  if (typeof record.omdVersion !== 'string' || !OMD_VERSION_PATTERN.test(record.omdVersion)) {
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
    if (!entry || typeof entry !== 'object') {
      throw new Error(`invalid artifact entry for ${platform}`)
    }
    if (
      typeof entry.filename !== 'string' ||
      !ARTIFACT_FILENAME_PATTERN.test(entry.filename) ||
      entry.filename.includes('/') ||
      entry.filename.includes('\\') ||
      entry.filename.includes('..')
    ) {
      throw new Error(`invalid artifact filename for ${platform}: ${entry.filename}`)
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
      throw new Error(`invalid artifact sha256 for ${platform}`)
    }
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
      throw new Error(`invalid artifact size for ${platform}`)
    }
    if (entry.platform !== platform) {
      throw new Error(`artifact platform mismatch for ${platform}: ${entry.platform}`)
    }
    if (typeof entry.nodeVersion !== 'string' || !entry.nodeVersion) {
      throw new Error(`invalid artifact nodeVersion for ${platform}`)
    }
    if (typeof entry.dshVersion !== 'string' || !entry.dshVersion) {
      throw new Error(`invalid artifact dshVersion for ${platform}`)
    }
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
    omdVersion: record.omdVersion,
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
