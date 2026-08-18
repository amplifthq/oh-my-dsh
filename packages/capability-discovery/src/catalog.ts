/**
 * Pure capability catalog: normalized descriptors, stable refs, and
 * deterministic field-weighted ranking. No Cordis, no I/O, no activation.
 */

export type CapabilityKind = 'tool' | 'skill' | 'command' | 'mcp' | 'plugin'

export type CapabilityStatus =
  | 'active'
  | 'inactive'
  | 'available'
  | 'model-invocable'
  | 'user-invocable'
  | 'not-installed'
  | 'version-drift'
  | 'incomplete'

export interface CapabilityNextAction {
  kind: 'use' | 'activate' | 'deactivate' | 'load' | 'unload' | 'unavailable'
  instruction: string
  tool?: string
  args?: Record<string, unknown>
}

export interface CapabilityDescriptor {
  ref: string
  kind: CapabilityKind
  id: string
  title: string
  summary: string
  status: CapabilityStatus | string
  provenance?: string
  risk?: string
  availability?: string
  /** Survives search-hit compaction so forged plugins stay marked. */
  forged?: boolean
  nextAction: CapabilityNextAction
  /** Extra searchable tokens (cached MCP tool names, whenToUse, etc.). */
  keywords?: string[]
  details?: Record<string, unknown>
}

export type CapabilitySearchHit = Omit<CapabilityDescriptor, 'details' | 'keywords'> & {
  score: number
}

export interface CapabilitySearchOptions {
  kinds?: readonly CapabilityKind[]
  limit?: number
}

const DEFAULT_LIMIT = 12
const MAX_LIMIT = 50
const MAX_QUERY_CHARS = 512
const MAX_CATALOG_ENTRIES = 5_000
const MAX_SUMMARY_CHARS = 4_096
const MAX_PROVENANCE_CHARS = 1_024
const MAX_RISK_CHARS = 4_096
const MAX_MCP_TOOLS = 64
const MAX_TOOL_NAME_CHARS = 256
const MAX_TOOL_DESCRIPTION_CHARS = 1_024

const BM25_K1 = 1.2
const BM25_B = 0.75

const FIELD_WEIGHTS = {
  id: 8,
  title: 6,
  keywords: 4,
  summary: 2,
  context: 1,
} as const

const KIND_PREFIX: Record<CapabilityKind, string> = {
  tool: 'tool',
  skill: 'skill',
  command: 'command',
  mcp: 'mcp',
  plugin: 'plugin',
}

export function capabilityRef(kind: CapabilityKind, id: string): string {
  if (!Object.hasOwn(KIND_PREFIX, kind)) {
    throw new Error(`invalid capability kind ${JSON.stringify(kind)}`)
  }
  if (!id.trim()) throw new Error('capability id must be a non-empty string')
  return `${KIND_PREFIX[kind]}:${encodeURIComponent(id)}`
}

export function parseCapabilityRef(ref: string): { kind: CapabilityKind; id: string } {
  const trimmed = ref.trim()
  const colon = trimmed.indexOf(':')
  if (colon <= 0) throw new Error(`invalid capability ref ${JSON.stringify(ref)}`)
  const kind = trimmed.slice(0, colon) as CapabilityKind
  if (!Object.hasOwn(KIND_PREFIX, kind)) {
    throw new Error(`invalid capability ref ${JSON.stringify(ref)}`)
  }
  let id: string
  try {
    id = decodeURIComponent(trimmed.slice(colon + 1))
  } catch {
    throw new Error(`invalid capability ref ${JSON.stringify(ref)}`)
  }
  if (!id.trim()) throw new Error(`invalid capability ref ${JSON.stringify(ref)}`)
  return { kind, id }
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und')
}

function tokens(value: string): string[] {
  return normalizeText(value).match(/[\p{L}\p{N}]+/gu) ?? []
}

function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars)
}

interface IndexedCapability {
  entry: CapabilityDescriptor
  normalizedId: string
  normalizedTitle: string
  all: string
  fields: Record<keyof typeof FIELD_WEIGHTS, string[]>
  length: number
}

function indexCapability(entry: CapabilityDescriptor): IndexedCapability {
  const id = bounded(entry.id, MAX_PROVENANCE_CHARS)
  const title = bounded(entry.title, MAX_PROVENANCE_CHARS)
  const summary = bounded(entry.summary, MAX_SUMMARY_CHARS)
  const keywords = bounded((entry.keywords ?? []).join(' '), MAX_SUMMARY_CHARS)
  const context = bounded(
    [entry.risk ?? '', entry.provenance ?? ''].join(' '),
    MAX_RISK_CHARS + MAX_PROVENANCE_CHARS,
  )
  const fields = {
    id: tokens(id),
    title: tokens(title),
    summary: tokens(summary),
    keywords: tokens(keywords),
    context: tokens(context),
  }
  return {
    entry,
    normalizedId: normalizeText(id),
    normalizedTitle: normalizeText(title),
    all: normalizeText([id, title, summary, keywords, context].join(' ')),
    fields,
    length: Math.max(
      1,
      Object.values(fields).reduce((sum, field) => sum + field.length, 0),
    ),
  }
}

function termFrequency(field: readonly string[], term: string): number {
  let count = 0
  for (const candidate of field) {
    if (candidate === term) count += 1
  }
  return count
}

function scoreIndexedCapabilities(
  indexed: readonly IndexedCapability[],
  query: string,
): Array<{ entry: CapabilityDescriptor; score: number }> {
  const raw = normalizeText(query.trim())
  if (!raw) return indexed.map(({ entry }) => ({ entry, score: 1 }))
  if (raw.length > MAX_QUERY_CHARS) {
    throw new Error(`capability search query must be at most ${MAX_QUERY_CHARS} characters`)
  }

  // Repeating a query word must not manufacture relevance.
  const queryTerms = [...new Set(tokens(raw))]
  if (!queryTerms.length) return []

  const averageLength =
    indexed.reduce((sum, document) => sum + document.length, 0) / Math.max(1, indexed.length)
  const documentFrequency = new Map<string, number>()
  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      indexed.filter((document) =>
        Object.values(document.fields).some((field) => field.includes(term)),
      ).length,
    )
  }

  return indexed.map((document) => {
    let score = 0
    if (document.normalizedId === raw || document.normalizedTitle === raw) score += 100
    else if (document.normalizedId.includes(raw) || document.normalizedTitle.includes(raw))
      score += 40
    else if (queryTerms.length === 1 && document.all.includes(raw)) score += 10

    for (const term of queryTerms) {
      let weightedFrequency = 0
      for (const [fieldName, field] of Object.entries(document.fields) as Array<
        [keyof typeof FIELD_WEIGHTS, string[]]
      >) {
        weightedFrequency += FIELD_WEIGHTS[fieldName] * termFrequency(field, term)
      }
      if (!weightedFrequency) continue

      const frequency = documentFrequency.get(term) ?? 0
      const inverseDocumentFrequency = Math.log(
        1 + (indexed.length - frequency + 0.5) / (frequency + 0.5),
      )
      const normalizedFrequency =
        weightedFrequency / (1 - BM25_B + BM25_B * (document.length / Math.max(1, averageLength)))
      score +=
        inverseDocumentFrequency *
        ((normalizedFrequency * (BM25_K1 + 1)) / (normalizedFrequency + BM25_K1))
    }

    return { entry: document.entry, score }
  })
}

/** Score one capability with the same bounded BM25-style machinery used by catalog search. */
export function scoreCapability(entry: CapabilityDescriptor, query: string): number {
  return scoreIndexedCapabilities([indexCapability(entry)], query)[0]?.score ?? 0
}

export function searchCapabilities(
  entries: readonly CapabilityDescriptor[],
  query: string,
  options: CapabilitySearchOptions = {},
): CapabilitySearchHit[] {
  if (
    options.limit !== undefined &&
    (!Number.isFinite(options.limit) || !Number.isInteger(options.limit) || options.limit < 1)
  ) {
    throw new Error('capability search limit must be a positive finite integer')
  }
  const kinds = options.kinds ? new Set(options.kinds) : undefined
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
  const filtered = kinds ? entries.filter((entry) => kinds.has(entry.kind)) : [...entries]
  const indexed = filtered.slice(0, MAX_CATALOG_ENTRIES).map(indexCapability)
  const scored = scoreIndexedCapabilities(indexed, query).filter(({ score }) => score > 0)

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.entry.kind.localeCompare(right.entry.kind) ||
      left.entry.id.localeCompare(right.entry.id) ||
      left.entry.ref.localeCompare(right.entry.ref),
  )

  return scored.slice(0, limit).map(({ entry, score }) => {
    const { details: _details, keywords: _keywords, ...compact } = entry
    return { ...compact, score }
  })
}

export function showCapability(
  entries: readonly CapabilityDescriptor[],
  ref: string,
): CapabilityDescriptor | undefined {
  const parsed = parseCapabilityRef(ref)
  return entries.find((entry) => entry.kind === parsed.kind && entry.id === parsed.id)
}

export function buildToolCapability(input: {
  name: string
  description: string
}): CapabilityDescriptor {
  return {
    ref: capabilityRef('tool', input.name),
    kind: 'tool',
    id: input.name,
    title: bounded(input.name, MAX_PROVENANCE_CHARS),
    summary: bounded(input.description, MAX_SUMMARY_CHARS),
    status: 'active',
    provenance: 'model-visible-tool',
    nextAction: {
      kind: 'use',
      instruction: `Call the tool "${input.name}" directly.`,
      tool: input.name,
    },
  }
}

export function buildSkillCapability(input: {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  provider: string
  source: string
  complete?: boolean
}): CapabilityDescriptor {
  const status =
    input.complete === false
      ? 'incomplete'
      : input.modelInvocable
        ? 'model-invocable'
        : input.userInvocable
          ? 'user-invocable'
          : 'inactive'
  return {
    ref: capabilityRef('skill', input.name),
    kind: 'skill',
    id: input.name,
    title: bounded(input.name, MAX_PROVENANCE_CHARS),
    summary: bounded(input.description, MAX_SUMMARY_CHARS),
    status,
    provenance: bounded(`${input.source}/${input.provider}`, MAX_PROVENANCE_CHARS),
    keywords: input.whenToUse ? [bounded(input.whenToUse, MAX_SUMMARY_CHARS)] : undefined,
    details: {
      whenToUse: input.whenToUse ? bounded(input.whenToUse, MAX_SUMMARY_CHARS) : undefined,
      modelInvocable: input.modelInvocable,
      userInvocable: input.userInvocable,
      complete: input.complete !== false,
    },
    nextAction: {
      kind: 'use',
      instruction: input.modelInvocable
        ? `Load skill "${input.name}" through the skill tool.`
        : input.userInvocable
          ? `Ask the user to invoke /${input.name}, or load it if modelInvocable becomes true.`
          : `Skill "${input.name}" is not currently invocable.`,
      tool: input.modelInvocable ? 'skill' : undefined,
      args: input.modelInvocable ? { name: input.name } : undefined,
    },
  }
}

export function buildCommandCapability(input: {
  name: string
  description: string
  inputHint?: string
}): CapabilityDescriptor {
  return {
    ref: capabilityRef('command', input.name),
    kind: 'command',
    id: input.name,
    title: bounded(`/${input.name}`, MAX_PROVENANCE_CHARS),
    summary: bounded(input.description, MAX_SUMMARY_CHARS),
    status: 'available',
    provenance: 'slash-command',
    keywords: input.inputHint ? [bounded(input.inputHint, MAX_SUMMARY_CHARS)] : undefined,
    nextAction: {
      kind: 'use',
      instruction: `Invoke the slash command /${input.name}${input.inputHint ? ` (${input.inputHint})` : ''}.`,
    },
  }
}

export function buildMcpCapability(input: {
  name: string
  status: 'inactive' | 'active'
  source: string
  transport: string
  endpoint: string
  cachedTools?: Array<{ name: string; description: string }>
}): CapabilityDescriptor {
  const cachedToolCount = input.cachedTools?.length ?? 0
  const cachedTools = (input.cachedTools ?? []).slice(0, MAX_MCP_TOOLS).map((tool) => ({
    name: bounded(tool.name, MAX_TOOL_NAME_CHARS),
    description: bounded(tool.description, MAX_TOOL_DESCRIPTION_CHARS),
  }))
  const toolNames = cachedTools.map((tool) => tool.name)
  const toolDescriptions = cachedTools.map((tool) => tool.description)
  const active = input.status === 'active'
  return {
    ref: capabilityRef('mcp', input.name),
    kind: 'mcp',
    id: input.name,
    title: bounded(input.name, MAX_PROVENANCE_CHARS),
    summary: bounded(
      `${input.transport} MCP server from ${input.source} at ${input.endpoint}`,
      MAX_SUMMARY_CHARS,
    ),
    status: input.status,
    provenance: bounded(input.source, MAX_PROVENANCE_CHARS),
    keywords: [...toolNames, ...toolDescriptions],
    details: {
      transport: bounded(input.transport, MAX_PROVENANCE_CHARS),
      endpoint: bounded(input.endpoint, MAX_PROVENANCE_CHARS),
      cachedToolCount,
      cachedTools,
      cachedToolsTruncated: cachedToolCount > cachedTools.length,
    },
    nextAction: active
      ? {
          kind: 'deactivate',
          instruction:
            'Use mcp_control prepare_deactivate, then proposal_control apply with user approval.',
          tool: 'mcp_control',
          args: { action: 'prepare_deactivate', server_name: input.name },
        }
      : {
          kind: 'activate',
          instruction:
            'Use mcp_control prepare_activate, then proposal_control apply with user approval. Discovery never starts the process.',
          tool: 'mcp_control',
          args: { action: 'prepare_activate', server_name: input.name },
        },
  }
}

export function buildPluginCapability(input: {
  id: string
  module: string
  version: string
  summary: string
  risk: string
  source: string
  active: boolean
  availability: string
}): CapabilityDescriptor {
  const available = input.availability === 'available'
  const unavailableAction: CapabilityNextAction = {
    kind: 'unavailable',
    instruction:
      `Plugin "${input.id}" is ${input.availability}. Install the exact reviewed version ` +
      `${input.module}@${input.version} outside the agent runtime, then search again. ` +
      'Discovery and plugin_control never install packages.',
  }
  return {
    ref: capabilityRef('plugin', input.id),
    kind: 'plugin',
    id: input.id,
    title: bounded(input.id, MAX_PROVENANCE_CHARS),
    summary: bounded(input.summary, MAX_SUMMARY_CHARS),
    status: input.active
      ? 'active'
      : input.availability === 'available'
        ? 'inactive'
        : input.availability,
    provenance: bounded(`${input.source}:${input.module}@${input.version}`, MAX_PROVENANCE_CHARS),
    risk: bounded(input.risk, MAX_RISK_CHARS),
    availability: input.availability,
    keywords: [input.module, input.risk],
    details: {
      module: input.module,
      version: input.version,
      active: input.active,
      availability: input.availability,
    },
    nextAction: input.active
      ? {
          kind: 'unload',
          instruction:
            'Use plugin_control prepare_unload, then proposal_control apply with user approval.',
          tool: 'plugin_control',
          args: { action: 'prepare_unload', plugin_id: input.id },
        }
      : available
        ? {
            kind: 'load',
            instruction:
              'Use plugin_control prepare_load, then proposal_control apply with user approval. Discovery never imports the package.',
            tool: 'plugin_control',
            args: { action: 'prepare_load', plugin_id: input.id },
          }
        : unavailableAction,
  }
}

export function buildForgedPluginCapability(input: {
  slug: string
  scope: 'user' | 'project'
  summary: string
  revision: number
  digest: string
  digestMatches: boolean
  active: boolean
  status: 'ok' | 'invalid'
  reason?: string
  risk: string
  invocations?: number
}): CapabilityDescriptor {
  const id = `forged/${input.scope}/${input.slug}`
  const usable = input.status === 'ok' && input.digestMatches
  const unavailableAction: CapabilityNextAction = {
    kind: 'unavailable',
    instruction:
      input.status === 'invalid'
        ? `Forged plugin "${input.slug}" is invalid (${input.reason ?? 'unknown'}). ` +
          'Revise it with plugin_forge prepare_forge; discovery never mounts it.'
        : `Forged plugin "${input.slug}" source does not match its stored digest. ` +
          'Forge a fresh revision instead of loading it.',
  }
  return {
    ref: capabilityRef('plugin', id),
    kind: 'plugin',
    id,
    title: bounded(input.slug, MAX_PROVENANCE_CHARS),
    summary: bounded(input.summary, MAX_SUMMARY_CHARS),
    status: input.active ? 'active' : usable ? 'inactive' : 'unavailable',
    provenance: bounded(`forged:${input.scope}`, MAX_PROVENANCE_CHARS),
    risk: bounded(input.risk, MAX_RISK_CHARS),
    availability: usable ? 'available' : input.status,
    forged: true,
    keywords: ['forged', 'plugin-forge', input.slug, input.scope],
    details: {
      forged: true,
      scope: input.scope,
      slug: input.slug,
      revision: input.revision,
      digest: input.digest,
      digestMatches: input.digestMatches,
      invocations: input.invocations ?? 0,
    },
    nextAction: input.active
      ? {
          kind: 'unload',
          instruction:
            'Use plugin_forge prepare_unload, then proposal_control apply with user approval.',
          tool: 'plugin_forge',
          args: { action: 'prepare_unload', name: input.slug },
        }
      : usable
        ? {
            kind: 'load',
            instruction:
              'Use plugin_forge prepare_load, then proposal_control apply with user approval. Discovery never imports the source.',
            tool: 'plugin_forge',
            args: { action: 'prepare_load', scope: input.scope, name: input.slug },
          }
        : unavailableAction,
  }
}
