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
