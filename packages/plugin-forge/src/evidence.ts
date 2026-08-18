import { createHash } from 'node:crypto'

import { detectSecretLikeContent } from '../../skill-forge/src/document.js'
import type { ForgedPluginManifest } from './document.js'
import type { ForgedPluginMeta, ForgedPluginScope } from './store.js'

export const GAP_QUERY_MAX_CHARS = 512
export const USAGE_LOG_RETAIN = 2_000
export const GAP_LOG_RETAIN = 200
export const FORGED_CAPABILITY_MARKER = 'forged'

export interface ForgedCapabilityView {
  slug: string
  scope: ForgedPluginScope
  summary: string
  revision: number
  digest: string
  digestMatches: boolean
  active: boolean
  status: 'ok' | 'invalid'
  reason?: string
  risk: string
  invocations?: number
}

export const CATALOG_PLACEHOLDERS = {
  module: 'REPLACE_WITH_PUBLISHED_PACKAGE',
  version: 'REPLACE_WITH_EXACT_SEMVER',
  repository: 'REPLACE_WITH_HTTPS_REPO',
  publisher: 'REPLACE_WITH_PUBLISHER',
  integrity: 'REPLACE_WITH_NPM_SHA512',
  commit: 'REPLACE_WITH_40_CHAR_COMMIT',
} as const

const TOOL_REGISTER_LABEL = /(?:^|[.\s/])tools\.register\(\s*["']([A-Za-z][\w-]*)["']\s*\)/g
const DEFINE_TOOL_NAME = /\bname:\s*['"]([A-Za-z][\w-]*)['"]/g

export function toolsFromEffectLabels(labels: readonly string[]): string[] {
  const names = new Set<string>()
  for (const label of labels) {
    TOOL_REGISTER_LABEL.lastIndex = 0
    for (const match of label.matchAll(TOOL_REGISTER_LABEL)) names.add(match[1]!)
  }
  return [...names].sort()
}

export function toolsFromSource(source: string): string[] {
  const names = new Set<string>()
  DEFINE_TOOL_NAME.lastIndex = 0
  for (const match of source.matchAll(DEFINE_TOOL_NAME)) names.add(match[1]!)
  return [...names].sort()
}

export function mergeAttributedTools(
  effectLabels: readonly string[],
  registeredDuringMount: readonly string[] = [],
  source = '',
): string[] {
  return [
    ...new Set([
      ...toolsFromEffectLabels(effectLabels),
      ...registeredDuringMount,
      ...toolsFromSource(source),
    ]),
  ].sort()
}

export interface ForgeRevisionRecord {
  revision: number
  digest: string
  sourceFile: string
  summary: string
  intendedEffects: string[]
  action: 'create' | 'update'
  createdAt: string
}

export interface ForgeUsageEvent {
  at: string
  tool: string
  digest: string
  revision: number
}

export interface ForgeUsageByRevision {
  revision: number
  digest: string
  invocations: number
  tools: Record<string, number>
}

export interface ForgeUsageSummary {
  slug: string
  scope: ForgedPluginScope
  totalInvocations: number
  attributedTools: string[]
  byTool: Record<string, number>
  byRevision: ForgeUsageByRevision[]
  lastInvokedAt?: string
}

export interface ForgeAttribution {
  digest: string
  revision: number
  effectLabels: string[]
  attributedTools: string[]
  updatedAt: string
}

export interface CapabilityGap {
  at: string
  query: string
  queryDigest: string
  kinds?: string[]
  hitCount: number
  skillsComplete: boolean
  authoritative: boolean
  redacted: boolean
}

export interface CatalogDraft {
  id: string
  module: string
  version: string
  summary: string
  risk: string
  manifest: ForgedPluginManifest
  config: Record<string, unknown>
  source: 'community'
  provenance: {
    repository: string
    publisher: string
    integrity: string
    commit: string
  }
}

export interface PromotionPacket {
  slug: string
  scope: ForgedPluginScope
  summary: string
  manifest: ForgedPluginManifest
  intendedEffects: string[]
  config?: Record<string, unknown>
  current: {
    revision: number
    digest: string
    sourceFile: string
    source: string
    imports: string[]
  }
  revisionLog: ForgeRevisionRecord[]
  usage: ForgeUsageSummary
  capabilityGaps: CapabilityGap[]
  catalogDraft: CatalogDraft
  blockingReasons: string[]
  warnings: string[]
  checklist: string[]
  privilegeWarning: string
}

export function queryDigest(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex')
}

export function shouldRecordSearchMiss(input: {
  hitCount: number
  skillsComplete: boolean
  kinds?: readonly string[]
}): boolean {
  if (input.hitCount > 0) return false
  const kinds = input.kinds
  if (!kinds || kinds.length === 0 || kinds.includes('skill')) return input.skillsComplete
  return true
}

export function planCapabilityGap(
  input: {
    query: string
    kinds?: readonly string[]
    hitCount: number
    skillsComplete: boolean
    at?: string
  },
  now: () => Date = () => new Date(),
): CapabilityGap {
  const raw = input.query.trim()
  if (!raw) throw new Error('capability gap query must not be empty')
  const clipped = raw.length > GAP_QUERY_MAX_CHARS ? raw.slice(0, GAP_QUERY_MAX_CHARS) : raw
  const secretWarnings = detectSecretLikeContent(clipped)
  const redacted = secretWarnings.length > 0
  const kinds = input.kinds?.map((kind) => kind.trim()).filter(Boolean)
  return {
    at: (input.at ?? now().toISOString()) as string,
    query: redacted ? `[redacted sha256=${queryDigest(clipped)}]` : clipped,
    queryDigest: queryDigest(clipped),
    ...(kinds?.length ? { kinds } : {}),
    hitCount: input.hitCount,
    skillsComplete: input.skillsComplete,
    authoritative: shouldRecordSearchMiss({
      hitCount: input.hitCount,
      skillsComplete: input.skillsComplete,
      kinds,
    }),
    redacted,
  }
}

export function aggregateUsage(
  slug: string,
  scope: ForgedPluginScope,
  events: readonly ForgeUsageEvent[],
  attributedTools: readonly string[] = [],
): ForgeUsageSummary {
  const byTool: Record<string, number> = {}
  const revisionMap = new Map<string, ForgeUsageByRevision>()
  let lastInvokedAt: string | undefined
  for (const event of events) {
    byTool[event.tool] = (byTool[event.tool] ?? 0) + 1
    const key = `${event.revision}:${event.digest}`
    const current = revisionMap.get(key) ?? {
      revision: event.revision,
      digest: event.digest,
      invocations: 0,
      tools: {},
    }
    current.invocations += 1
    current.tools[event.tool] = (current.tools[event.tool] ?? 0) + 1
    revisionMap.set(key, current)
    if (!lastInvokedAt || event.at > lastInvokedAt) lastInvokedAt = event.at
  }
  const byRevision = [...revisionMap.values()].sort(
    (left, right) => left.revision - right.revision || left.digest.localeCompare(right.digest),
  )
  const summary: ForgeUsageSummary = {
    slug,
    scope,
    totalInvocations: events.length,
    attributedTools: [...new Set(attributedTools)].sort(),
    byTool,
    byRevision,
  }
  if (lastInvokedAt) summary.lastInvokedAt = lastInvokedAt
  return summary
}

export function catalogDraftFromMeta(
  meta: Pick<ForgedPluginMeta, 'slug' | 'summary' | 'manifest' | 'config'>,
  risk: string,
): CatalogDraft {
  return {
    id: meta.slug,
    module: CATALOG_PLACEHOLDERS.module,
    version: CATALOG_PLACEHOLDERS.version,
    summary: meta.summary,
    risk,
    manifest: { ...meta.manifest },
    config: meta.config ? { ...meta.config } : {},
    source: 'community',
    provenance: {
      repository: CATALOG_PLACEHOLDERS.repository,
      publisher: CATALOG_PLACEHOLDERS.publisher,
      integrity: CATALOG_PLACEHOLDERS.integrity,
      commit: CATALOG_PLACEHOLDERS.commit,
    },
  }
}

export function promotionBlockingReasons(input: {
  slug: string
  digestMatches: boolean
  catalogCollision?: boolean
}): string[] {
  const reasons = [
    'Runtime never writes presets/plugins.json; promotion is a human pull-request draft.',
    'Source is agent-authored session code, not a published package with reviewed provenance.',
    'Catalog admission requires an exact semver pin, npm sha512 integrity, and an HTTPS repository.',
    'A forged plugin runs in-process with the harness full privileges; review is the trust decision.',
  ]
  if (!input.digestMatches) {
    reasons.unshift(`Forged plugin "${input.slug}" source does not match its stored digest.`)
  }
  if (input.catalogCollision) {
    reasons.unshift(
      `Slug "${input.slug}" already exists in the curated catalog; pick a new published id.`,
    )
  }
  return reasons
}

export const PROMOTION_CHECKLIST = [
  'Publish the source as a real package; do not copy session files into the catalog.',
  'Pin an exact semver in package.json and the lockfile.',
  'Record HTTPS repository, publisher, npm sha512 integrity, and reviewed commit.',
  'Confirm the module top level has no I/O, network, timers, or service registration.',
  'Re-verify exported name / provide / inject against the reviewed manifest.',
  'Demonstrate every apply effect is Cordis-owned and reversed by fiber.dispose().',
  'State the in-process privilege and agent-authored origin in the catalog risk field.',
  'Open a pull request against presets/plugins.json; the runtime must not write that file.',
] as const

export function renderPromotionAudit(packet: PromotionPacket): string {
  const usageLines =
    packet.usage.totalInvocations === 0
      ? ['- No attributed tool invocations recorded yet.']
      : [
          `- Total attributed invocations: ${packet.usage.totalInvocations}`,
          `- Tools: ${
            Object.entries(packet.usage.byTool)
              .map(([tool, count]) => `${tool}=${count}`)
              .join(', ') || '(none)'
          }`,
          `- Last invoked: ${packet.usage.lastInvokedAt ?? 'never'}`,
        ]
  const revisionLines = packet.revisionLog.length
    ? packet.revisionLog.map(
        (record) =>
          `- rev ${record.revision} ${record.digest.slice(0, 12)} ${record.action} ${record.createdAt}`,
      )
    : ['- No revision log (current revision is the only known state).']
  const gapLines = packet.capabilityGaps.length
    ? packet.capabilityGaps.map(
        (gap) =>
          `- ${gap.at} hits=${gap.hitCount} ${gap.redacted ? '(redacted) ' : ''}` +
          `${JSON.stringify(gap.query)}`,
      )
    : ['- No recorded capability_search misses.']
  return [
    `# Promotion audit: ${packet.slug}`,
    '',
    `Scope: ${packet.scope}`,
    `Revision: ${packet.current.revision}`,
    `Digest: ${packet.current.digest}`,
    `Source file: ${packet.current.sourceFile}`,
    '',
    '## Why this is not a catalog write',
    '',
    ...packet.blockingReasons.map((reason) => `- ${reason}`),
    '',
    '## Declared manifest',
    '',
    '```json',
    JSON.stringify(packet.manifest, null, 2),
    '```',
    '',
    '## Intended effects',
    '',
    ...packet.intendedEffects.map((effect) => `- ${effect}`),
    '',
    '## Usage',
    '',
    ...usageLines,
    '',
    '## Revision log',
    '',
    ...revisionLines,
    '',
    '## Capability-search misses (forging direction)',
    '',
    ...gapLines,
    '',
    '## Catalog entry draft (placeholders are intentional)',
    '',
    '```json',
    JSON.stringify(packet.catalogDraft, null, 2),
    '```',
    '',
    '## Human checklist',
    '',
    ...packet.checklist.map((item) => `- [ ] ${item}`),
    '',
    '## Privilege',
    '',
    packet.privilegeWarning,
    '',
    '## Current source',
    '',
    '```javascript',
    packet.current.source,
    '```',
    '',
  ].join('\n')
}

export function revisionRecordFromMeta(
  meta: ForgedPluginMeta,
  action: 'create' | 'update',
): ForgeRevisionRecord {
  return {
    revision: meta.revision,
    digest: meta.digest,
    sourceFile: meta.sourceFile,
    summary: meta.summary,
    intendedEffects: [...meta.intendedEffects],
    action,
    createdAt: meta.updatedAt,
  }
}
