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
  kind: 'use' | 'activate' | 'deactivate' | 'load' | 'unload'
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
  nextAction: CapabilityNextAction
  /** Extra searchable tokens (cached MCP tool names, whenToUse, etc.). */
  keywords?: string[]
  details?: Record<string, unknown>
}

export interface CapabilitySearchHit extends CapabilityDescriptor {
  score: number
}

export interface CapabilitySearchOptions {
  kinds?: readonly CapabilityKind[]
  limit?: number
}

const DEFAULT_LIMIT = 12
const MAX_LIMIT = 50

const KIND_PREFIX: Record<CapabilityKind, string> = {
  tool: 'tool',
  skill: 'skill',
  command: 'command',
  mcp: 'mcp',
  plugin: 'plugin',
}

export function capabilityRef(kind: CapabilityKind, id: string): string {
  const trimmed = id.trim()
  if (!trimmed) throw new Error('capability id must be a non-empty string')
  return `${KIND_PREFIX[kind]}:${trimmed}`
}

export function parseCapabilityRef(ref: string): { kind: CapabilityKind; id: string } {
  const trimmed = ref.trim()
  const colon = trimmed.indexOf(':')
  if (colon <= 0) throw new Error(`invalid capability ref ${JSON.stringify(ref)}`)
  const kind = trimmed.slice(0, colon) as CapabilityKind
  const id = trimmed.slice(colon + 1).trim()
  if (!(kind in KIND_PREFIX) || !id) {
    throw new Error(`invalid capability ref ${JSON.stringify(ref)}`)
  }
  return { kind, id }
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function fieldText(entry: CapabilityDescriptor): {
  id: string
  title: string
  summary: string
  keywords: string
  all: string
} {
  const keywords = (entry.keywords ?? []).join(' ')
  return {
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
    keywords,
    all: [entry.id, entry.title, entry.summary, keywords, entry.risk ?? '', entry.provenance ?? '']
      .join(' ')
      .toLowerCase(),
  }
}

/**
 * Field-weighted score: exact id/title match >> token hit on id/title >>
 * keyword/summary hits >> prefix matches. Returns 0 when nothing matches.
 */
export function scoreCapability(entry: CapabilityDescriptor, query: string): number {
  const raw = query.trim().toLowerCase()
  if (!raw) return 1

  const fields = fieldText(entry)
  const idLower = entry.id.toLowerCase()
  const titleLower = entry.title.toLowerCase()
  const queryTokens = tokens(raw)
  if (!queryTokens.length) return 1

  let score = 0

  // Exact / substring boosts on identity fields.
  if (idLower === raw || titleLower === raw) score += 100
  else if (idLower.includes(raw) || titleLower.includes(raw)) score += 40
  else if (fields.all.includes(raw)) score += 10

  const idTokens = tokens(entry.id)
  const titleTokens = tokens(entry.title)
  const summaryTokens = tokens(entry.summary)
  const keywordTokens = tokens(fields.keywords)

  for (const token of queryTokens) {
    if (idTokens.includes(token)) score += 12
    else if (titleTokens.includes(token)) score += 10
    else if (keywordTokens.includes(token)) score += 7
    else if (summaryTokens.includes(token)) score += 4
    else if (idTokens.some((candidate) => candidate.startsWith(token))) score += 3
    else if (titleTokens.some((candidate) => candidate.startsWith(token))) score += 2
    else if (keywordTokens.some((candidate) => candidate.startsWith(token))) score += 1
  }

  return score
}

export function searchCapabilities(
  entries: readonly CapabilityDescriptor[],
  query: string,
  options: CapabilitySearchOptions = {},
): CapabilitySearchHit[] {
  const kinds = options.kinds ? new Set(options.kinds) : undefined
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
  const filtered = kinds ? entries.filter((entry) => kinds.has(entry.kind)) : [...entries]

  const scored = filtered
    .map((entry) => ({ entry, score: scoreCapability(entry, query) }))
    .filter(({ score }) => score > 0)

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.entry.kind.localeCompare(right.entry.kind) ||
      left.entry.id.localeCompare(right.entry.id) ||
      left.entry.ref.localeCompare(right.entry.ref),
  )

  return scored.slice(0, limit).map(({ entry, score }) => ({ ...entry, score }))
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
    title: input.name,
    summary: input.description,
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
    title: input.name,
    summary: input.description,
    status,
    provenance: `${input.source}/${input.provider}`,
    keywords: input.whenToUse ? [input.whenToUse] : undefined,
    details: {
      whenToUse: input.whenToUse,
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
    title: `/${input.name}`,
    summary: input.description,
    status: 'available',
    provenance: 'slash-command',
    keywords: input.inputHint ? [input.inputHint] : undefined,
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
  const toolNames = (input.cachedTools ?? []).map((tool) => tool.name)
  const toolDescriptions = (input.cachedTools ?? []).map((tool) => tool.description)
  const active = input.status === 'active'
  return {
    ref: capabilityRef('mcp', input.name),
    kind: 'mcp',
    id: input.name,
    title: input.name,
    summary: `${input.transport} MCP server from ${input.source} at ${input.endpoint}`,
    status: input.status,
    provenance: input.source,
    keywords: [...toolNames, ...toolDescriptions],
    details: {
      transport: input.transport,
      endpoint: input.endpoint,
      cachedTools: input.cachedTools ?? [],
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
  return {
    ref: capabilityRef('plugin', input.id),
    kind: 'plugin',
    id: input.id,
    title: input.id,
    summary: input.summary,
    status: input.active
      ? 'active'
      : input.availability === 'available'
        ? 'inactive'
        : input.availability,
    provenance: `${input.source}:${input.module}@${input.version}`,
    risk: input.risk,
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
      : {
          kind: 'load',
          instruction:
            'Use plugin_control prepare_load, then proposal_control apply with user approval. Discovery never imports the package.',
          tool: 'plugin_control',
          args: { action: 'prepare_load', plugin_id: input.id },
        },
  }
}
