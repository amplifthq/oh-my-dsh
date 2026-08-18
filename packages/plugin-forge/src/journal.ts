import { randomBytes } from 'node:crypto'
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'

import {
  aggregateUsage,
  catalogDraftFromMeta,
  mergeAttributedTools,
  GAP_LOG_RETAIN,
  planCapabilityGap,
  PROMOTION_CHECKLIST,
  promotionBlockingReasons,
  renderPromotionAudit,
  revisionRecordFromMeta,
  USAGE_LOG_RETAIN,
  type CapabilityGap,
  type ForgeAttribution,
  type ForgeRevisionRecord,
  type ForgeUsageEvent,
  type ForgeUsageSummary,
  type PromotionPacket,
} from './evidence.js'
import type { PluginSourceReport } from './document.js'
import {
  type ForgedPluginScope,
  type ForgedPluginState,
  type ForgedPluginTarget,
  type ForgeRoots,
} from './store.js'

export const REVISION_LOG_FILE = 'revisions.jsonl'
export const USAGE_LOG_FILE = 'usage.jsonl'
export const ATTRIBUTION_FILE = 'attribution.json'
export const GAPS_RELATIVE = join('omd', 'capability-gaps.jsonl')

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

async function refuseSymlink(path: string, label: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined)
  if (stat?.isSymbolicLink()) {
    throw new Error(`${label} ${path} is a symlink; refusing to write through it`)
  }
}

function assertInside(root: string, path: string, label: string): void {
  const rel = relative(resolve(root), resolve(path))
  if (rel.startsWith('..') || rel === '') {
    throw new Error(`${label} ${path} escapes ${root}`)
  }
}

async function readJsonl<T>(
  path: string,
  parse: (value: unknown) => T,
  retain: number,
): Promise<T[]> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const records: T[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(parse(JSON.parse(trimmed)))
    } catch {
      // Skip a corrupt line rather than dropping the whole evidence log.
    }
  }
  return records.length > retain ? records.slice(-retain) : records
}

async function appendJsonl(path: string, value: unknown, retain: number): Promise<void> {
  await refuseSymlink(path, 'journal file')
  await mkdir(resolve(path, '..'), { recursive: true })
  await appendFile(path, jsonLine(value), { encoding: 'utf8', mode: 0o644 })
  const content = await readFile(path, 'utf8')
  const lines = content.split('\n').filter((line) => line.trim())
  if (lines.length <= retain + 500) return
  const kept = `${lines.slice(-retain).join('\n')}\n`
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temp, kept, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
  try {
    await rename(temp, path)
    await chmod(path, 0o644)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await refuseSymlink(path, 'journal file')
  await mkdir(resolve(path, '..'), { recursive: true })
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const content = `${JSON.stringify(value, null, 2)}\n`
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
    await rename(temp, path)
    await chmod(path, 0o644)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

export function revisionLogPath(target: ForgedPluginTarget): string {
  return join(target.directory, REVISION_LOG_FILE)
}

export function usageLogPath(target: ForgedPluginTarget): string {
  return join(target.directory, USAGE_LOG_FILE)
}

export function attributionPath(target: ForgedPluginTarget): string {
  return join(target.directory, ATTRIBUTION_FILE)
}

export function gapsPath(dshHome: string): string {
  return resolve(dshHome, GAPS_RELATIVE)
}

export function promotionDirectory(
  target: ForgedPluginTarget,
  revision: number,
  digest: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error('promotion digest must be a lowercase sha256 hex string')
  }
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error('promotion revision must be a positive integer')
  }
  const directory = join(target.directory, 'promotions', `${revision}-${digest.slice(0, 12)}`)
  assertInside(target.directory, directory, 'promotion directory')
  return directory
}

function parseRevision(value: unknown): ForgeRevisionRecord {
  const record = asRecord(value, 'revision log entry')
  if (
    typeof record.revision !== 'number' ||
    !Number.isInteger(record.revision) ||
    record.revision < 1
  ) {
    throw new Error('revision log revision must be a positive integer')
  }
  if (typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest)) {
    throw new Error('revision log digest must be a lowercase sha256 hex string')
  }
  if (typeof record.sourceFile !== 'string' || !record.sourceFile) {
    throw new Error('revision log sourceFile must be a string')
  }
  if (typeof record.summary !== 'string' || typeof record.createdAt !== 'string') {
    throw new Error('revision log summary and createdAt must be strings')
  }
  if (record.action !== 'create' && record.action !== 'update') {
    throw new Error('revision log action must be create or update')
  }
  if (
    !Array.isArray(record.intendedEffects) ||
    record.intendedEffects.some((item) => typeof item !== 'string')
  ) {
    throw new Error('revision log intendedEffects must be a string array')
  }
  return {
    revision: record.revision,
    digest: record.digest,
    sourceFile: record.sourceFile,
    summary: record.summary,
    intendedEffects: record.intendedEffects as string[],
    action: record.action,
    createdAt: record.createdAt,
  }
}

function parseUsageEvent(value: unknown): ForgeUsageEvent {
  const record = asRecord(value, 'usage event')
  if (typeof record.at !== 'string' || typeof record.tool !== 'string' || !record.tool) {
    throw new Error('usage event at and tool must be strings')
  }
  if (typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest)) {
    throw new Error('usage event digest must be a lowercase sha256 hex string')
  }
  if (
    typeof record.revision !== 'number' ||
    !Number.isInteger(record.revision) ||
    record.revision < 1
  ) {
    throw new Error('usage event revision must be a positive integer')
  }
  return {
    at: record.at,
    tool: record.tool,
    digest: record.digest,
    revision: record.revision,
  }
}

function parseGap(value: unknown): CapabilityGap {
  const record = asRecord(value, 'capability gap')
  if (typeof record.at !== 'string' || typeof record.query !== 'string') {
    throw new Error('capability gap at and query must be strings')
  }
  if (typeof record.queryDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.queryDigest)) {
    throw new Error('capability gap queryDigest must be a lowercase sha256 hex string')
  }
  if (
    typeof record.hitCount !== 'number' ||
    !Number.isInteger(record.hitCount) ||
    record.hitCount < 0
  ) {
    throw new Error('capability gap hitCount must be a non-negative integer')
  }
  return {
    at: record.at,
    query: record.query,
    queryDigest: record.queryDigest,
    kinds: Array.isArray(record.kinds)
      ? record.kinds.filter((item): item is string => typeof item === 'string')
      : undefined,
    hitCount: record.hitCount,
    skillsComplete: record.skillsComplete !== false,
    authoritative: record.authoritative !== false,
    redacted: record.redacted === true,
  }
}

export async function appendRevisionLog(
  target: ForgedPluginTarget,
  record: ForgeRevisionRecord,
): Promise<void> {
  assertInside(target.directory, revisionLogPath(target), 'revision log')
  await appendJsonl(revisionLogPath(target), record, USAGE_LOG_RETAIN)
}

export async function readRevisionLog(target: ForgedPluginTarget): Promise<ForgeRevisionRecord[]> {
  return readJsonl(revisionLogPath(target), parseRevision, USAGE_LOG_RETAIN)
}

export async function appendUsageEvent(
  target: ForgedPluginTarget,
  event: ForgeUsageEvent,
): Promise<void> {
  assertInside(target.directory, usageLogPath(target), 'usage log')
  await appendJsonl(usageLogPath(target), event, USAGE_LOG_RETAIN)
}

export async function readUsageEvents(target: ForgedPluginTarget): Promise<ForgeUsageEvent[]> {
  return readJsonl(usageLogPath(target), parseUsageEvent, USAGE_LOG_RETAIN)
}

export async function writeAttribution(
  target: ForgedPluginTarget,
  attribution: ForgeAttribution,
): Promise<void> {
  assertInside(target.directory, attributionPath(target), 'attribution file')
  await writeJsonAtomic(attributionPath(target), attribution)
}

export async function readAttribution(
  target: ForgedPluginTarget,
): Promise<ForgeAttribution | undefined> {
  try {
    const value = JSON.parse(await readFile(attributionPath(target), 'utf8')) as unknown
    const record = asRecord(value, 'attribution')
    if (typeof record.digest !== 'string' || typeof record.revision !== 'number') return undefined
    if (!Array.isArray(record.attributedTools) || !Array.isArray(record.effectLabels))
      return undefined
    return {
      digest: record.digest,
      revision: record.revision,
      effectLabels: record.effectLabels.filter((item): item is string => typeof item === 'string'),
      attributedTools: record.attributedTools.filter(
        (item): item is string => typeof item === 'string',
      ),
      updatedAt:
        typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return undefined
  }
}

export async function summarizeUsage(
  target: ForgedPluginTarget,
  slug: string,
  scope: ForgedPluginScope,
): Promise<ForgeUsageSummary> {
  const [events, attribution] = await Promise.all([
    readUsageEvents(target),
    readAttribution(target),
  ])
  return aggregateUsage(slug, scope, events, attribution?.attributedTools ?? [])
}

export async function appendCapabilityGap(
  dshHome: string,
  input: Parameters<typeof planCapabilityGap>[0],
): Promise<CapabilityGap | undefined> {
  const gap = planCapabilityGap(input)
  if (!gap.authoritative) return undefined
  const path = gapsPath(dshHome)
  assertInside(resolve(dshHome), path, 'capability-gap log')
  await appendJsonl(path, gap, GAP_LOG_RETAIN)
  return gap
}

export async function readCapabilityGaps(dshHome: string): Promise<CapabilityGap[]> {
  return readJsonl(gapsPath(dshHome), parseGap, GAP_LOG_RETAIN)
}

export async function assemblePromotionPacket(input: {
  target: ForgedPluginTarget
  state: ForgedPluginState
  report: PluginSourceReport
  privilegeWarning: string
  catalogIds?: readonly string[]
  roots?: ForgeRoots
}): Promise<PromotionPacket> {
  if (!input.state.source || !input.state.digestMatches) {
    throw new Error(
      `forged plugin "${input.state.meta.slug}" source does not hash to its stored digest; ` +
        'forge a fresh revision before promoting',
    )
  }
  const [revisionLog, usage, gaps] = await Promise.all([
    readRevisionLog(input.target),
    summarizeUsage(input.target, input.state.meta.slug, input.state.meta.scope),
    input.roots ? readCapabilityGaps(input.roots.dshHome) : Promise.resolve([]),
  ])
  const catalogCollision = input.catalogIds?.includes(input.state.meta.slug) === true
  const blockingReasons = promotionBlockingReasons({
    slug: input.state.meta.slug,
    digestMatches: input.state.digestMatches,
    catalogCollision,
  })
  const warnings: string[] = []
  if (usage.totalInvocations === 0) {
    warnings.push(
      'No attributed tool invocations yet; the draft still has no selection-pressure evidence.',
    )
  }
  if (revisionLog.length === 0) {
    warnings.push('Revision log is empty; the packet records only the current digest.')
  }
  const packet: PromotionPacket = {
    slug: input.state.meta.slug,
    scope: input.state.meta.scope,
    summary: input.state.meta.summary,
    manifest: input.state.meta.manifest,
    intendedEffects: input.state.meta.intendedEffects,
    current: {
      revision: input.state.meta.revision,
      digest: input.state.meta.digest,
      sourceFile: input.state.meta.sourceFile,
      source: input.state.source,
      imports: input.report.imports,
    },
    revisionLog: revisionLog.length
      ? revisionLog
      : [
          revisionRecordFromMeta(
            input.state.meta,
            input.state.meta.revision === 1 ? 'create' : 'update',
          ),
        ],
    usage,
    capabilityGaps: gaps.slice(-20),
    catalogDraft: catalogDraftFromMeta(input.state.meta, input.privilegeWarning),
    blockingReasons,
    warnings,
    checklist: [...PROMOTION_CHECKLIST],
    privilegeWarning: input.privilegeWarning,
  }
  if (input.state.meta.config !== undefined) packet.config = input.state.meta.config
  return packet
}

export interface PromotionWriteResult {
  directory: string
  auditPath: string
  catalogDraftPath: string
  packetPath: string
}

export async function writePromotionPacket(
  target: ForgedPluginTarget,
  packet: PromotionPacket,
): Promise<PromotionWriteResult> {
  const directory = promotionDirectory(target, packet.current.revision, packet.current.digest)
  await refuseSymlink(directory, 'promotion directory')
  await mkdir(directory, { recursive: true })
  const auditPath = join(directory, 'AUDIT.md')
  const catalogDraftPath = join(directory, 'catalog-entry.json')
  const packetPath = join(directory, 'packet.json')
  for (const path of [auditPath, catalogDraftPath, packetPath]) {
    assertInside(directory, path, 'promotion file')
    await refuseSymlink(path, 'promotion file')
  }
  const files: Array<[string, string]> = [
    [auditPath, renderPromotionAudit(packet)],
    [catalogDraftPath, `${JSON.stringify(packet.catalogDraft, null, 2)}\n`],
    [packetPath, `${JSON.stringify(packet, null, 2)}\n`],
  ]
  for (const [path, content] of files) {
    const temp = join(directory, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await writeFile(temp, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
      await rename(temp, path)
      await chmod(path, 0o644)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
  }
  return { directory, auditPath, catalogDraftPath, packetPath }
}

export function emptyUsage(slug: string, scope: ForgedPluginScope): ForgeUsageSummary {
  return aggregateUsage(slug, scope, [], [])
}

/** Stable identity for an in-memory attribution map. */
export function attributionKey(scope: ForgedPluginScope, slug: string): string {
  return `${scope}:${slug}`
}

export async function recordMountAttribution(
  target: ForgedPluginTarget,
  state: { meta: { digest: string; revision: number } },
  effectLabels: readonly string[],
  registeredDuringMount: readonly string[],
  source = '',
): Promise<string[]> {
  const attributedTools = mergeAttributedTools(effectLabels, registeredDuringMount, source)
  await writeAttribution(target, {
    digest: state.meta.digest,
    revision: state.meta.revision,
    effectLabels: [...effectLabels],
    attributedTools,
    updatedAt: new Date().toISOString(),
  })
  return attributedTools
}
