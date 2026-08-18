/**
 * Unified, read-only capability discovery for oh-my-dsh.
 *
 * Searches model-visible tools, skills, slash commands, inert/active MCP
 * servers, curated session plugins, and agent-forged plugins (marked `forged`).
 * Never activates a process, imports a package, expands credentials, or creates
 * a proposal — those remain on mcp_control, plugin_control, plugin_forge, and
 * proposal_control. Zero-hit searches are recorded as capability gaps so
 * plugin forge has a direction; discovery itself stays read-only.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { McpCatalogView, McpControlRuntime } from '../../mcp-control/src/index.ts'
import type { OrganView, PluginControlRuntime } from '../../plugin-control/src/index.ts'
import {
  buildCommandCapability,
  buildForgedPluginCapability,
  buildMcpCapability,
  buildPluginCapability,
  buildSkillCapability,
  buildToolCapability,
  searchCapabilities,
  showCapability,
  type CapabilityDescriptor,
  type CapabilityKind,
  type CapabilitySearchHit,
  type CapabilitySearchOptions,
} from './catalog.js'
import { shouldRecordSearchMiss } from '../../plugin-forge/src/evidence.js'

export const name = 'omd-capability-discovery'

export * from './catalog.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    capabilityDiscovery: CapabilityDiscoveryRuntime
    mcpControl: McpControlRuntime
    pluginControl: PluginControlRuntime
  }
}

export interface ToolSchemaLike {
  name: string
  description: string
}

export interface SkillSummaryLike {
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  provider: string
  source: string
}

export interface CommandDescriptorLike {
  name: string
  description: string
  input?: { hint?: string }
}

export interface CapabilitySources {
  tools: readonly ToolSchemaLike[]
  skills: readonly SkillSummaryLike[]
  skillsComplete: boolean
  commands: readonly CommandDescriptorLike[]
  mcpServers: readonly McpCatalogView[]
  plugins: readonly OrganView[]
  forgedPlugins?: readonly ForgedCapabilitySource[]
}

export interface ForgedCapabilitySource {
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
}

export interface CapabilitySnapshot {
  capabilities: CapabilityDescriptor[]
  skillsComplete: boolean
  counts: Record<CapabilityKind, number>
}

export function aggregateCapabilities(sources: CapabilitySources): CapabilitySnapshot {
  const capabilities: CapabilityDescriptor[] = []

  for (const tool of sources.tools) {
    capabilities.push(buildToolCapability({ name: tool.name, description: tool.description ?? '' }))
  }

  for (const skill of sources.skills) {
    capabilities.push(
      buildSkillCapability({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        modelInvocable: skill.invocation.modelInvocable,
        userInvocable: skill.invocation.userInvocable,
        provider: skill.provider,
        source: String(skill.source),
        complete: sources.skillsComplete,
      }),
    )
  }

  for (const command of sources.commands) {
    capabilities.push(
      buildCommandCapability({
        name: command.name,
        description: command.description,
        inputHint: command.input?.hint,
      }),
    )
  }

  for (const server of sources.mcpServers) {
    capabilities.push(
      buildMcpCapability({
        name: server.name,
        status: server.status,
        source: server.source,
        transport: server.transport,
        endpoint: server.endpoint,
        cachedTools: server.cachedTools,
      }),
    )
  }

  for (const organ of sources.plugins) {
    capabilities.push(
      buildPluginCapability({
        id: organ.id,
        module: organ.module,
        version: organ.version,
        summary: organ.summary,
        risk: organ.risk,
        source: organ.source,
        active: organ.active,
        availability: organ.availability.status,
      }),
    )
  }

  for (const forged of sources.forgedPlugins ?? []) {
    capabilities.push(
      buildForgedPluginCapability({
        slug: forged.slug,
        scope: forged.scope,
        summary: forged.summary,
        revision: forged.revision,
        digest: forged.digest,
        digestMatches: forged.digestMatches,
        active: forged.active,
        status: forged.status,
        reason: forged.reason,
        risk: forged.risk,
        invocations: forged.invocations,
      }),
    )
  }

  const counts: Record<CapabilityKind, number> = {
    tool: 0,
    skill: 0,
    command: 0,
    mcp: 0,
    plugin: 0,
  }
  for (const entry of capabilities) counts[entry.kind] += 1

  return { capabilities, skillsComplete: sources.skillsComplete, counts }
}

export function formatCapabilityHits(
  hits: readonly CapabilitySearchHit[],
  options: { skillsComplete?: boolean; emptyMessage?: string } = {},
): string {
  if (!hits.length) {
    const empty = options.emptyMessage ?? 'No matching capabilities.'
    return options.skillsComplete === false
      ? `${empty} Skill discovery was incomplete, so this absence is not authoritative.`
      : empty
  }
  const lines = hits.map((hit) => {
    const risk = hit.risk ? ` risk=${JSON.stringify(hit.risk)}` : ''
    const forged = hit.forged ? ' forged' : ''
    return (
      `${hit.ref} [${hit.status}${forged}] score=${hit.score} — ${hit.summary}` +
      `\n  next: ${hit.nextAction.instruction}${risk}`
    )
  })
  if (options.skillsComplete === false) {
    lines.push('note: skill discovery was incomplete; results may grow after the next scan.')
  }
  return lines.join('\n')
}

function parseKinds(value: unknown): CapabilityKind[] | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const raw = Array.isArray(value) ? value : String(value).split(',')
  const kinds = raw
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean) as CapabilityKind[]
  const allowed = new Set<CapabilityKind>(['tool', 'skill', 'command', 'mcp', 'plugin'])
  for (const kind of kinds) {
    if (!allowed.has(kind)) throw new Error(`unsupported capability kind "${kind}"`)
  }
  return kinds.length ? kinds : undefined
}

function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new Error('capability_search requires an active agent session')
  return exec.agent
}

export class CapabilityDiscoveryRuntime extends Service {
  static inject = ['tools', 'skills', 'commands', 'systemPrompt', 'mcpControl', 'pluginControl']

  constructor(ctx: Context) {
    super(ctx, 'capabilityDiscovery')

    ctx.systemPrompt.section({
      name: 'omd:capability-discovery',
      order: 112,
      text:
        'Before claiming a capability is unavailable, call capability_search. It indexes ' +
        'active tools, skills, slash commands, inert MCP servers, curated session plugins, ' +
        'and agent-forged plugins (marked forged). A zero-hit search is recorded as a ' +
        'capability gap that can steer plugin_forge. Discovery is read-only: activating an ' +
        'MCP server or loading a plugin still requires mcp_control / plugin_control / ' +
        'plugin_forge prepare_* plus an approved proposal_control apply.',
    })

    ctx.commands.register({
      name: 'omd-capabilities',
      description:
        'Search tools, skills, commands, MCP servers, curated plugins, and forged plugins.',
      input: { hint: 'search query' },
      recordInput: false,
      handler: async ({ agent, rawInput, signal }) => {
        const query = rawInput.trim()
        if (!query) {
          return {
            kind: 'success',
            text: 'Usage: /omd-capabilities <query> — e.g. /omd-capabilities browser',
          }
        }
        const snapshot = await this.snapshot(agent as Agent, signal)
        const hits = searchCapabilities(snapshot.capabilities, query)
        this.recordMiss(query, undefined, hits.length, snapshot.skillsComplete)
        return {
          kind: 'success',
          text: formatCapabilityHits(hits, { skillsComplete: snapshot.skillsComplete }),
        }
      },
    })

    ctx.tools.register(
      defineTool({
        name: 'capability_search',
        description:
          'Search the unified capability catalog (tools, skills, commands, MCP servers, curated plugins, forged plugins) or show one stable ref. Read-only: never activates MCP servers or loads plugins. Zero-hit searches are recorded as capability gaps.',
        parameters: {
          action: {
            type: 'string',
            required: true,
            enum: ['search', 'show'],
            description: 'search ranks matching capabilities; show returns one ref.',
          },
          query: {
            type: 'string',
            description: 'Free-text query for action=search.',
          },
          ref: {
            type: 'string',
            description: 'Stable ref such as mcp:omd-playwright for action=show.',
          },
          kinds: {
            type: 'string',
            description: 'Optional comma-separated kind filter: tool,skill,command,mcp,plugin.',
          },
          limit: {
            type: 'number',
            description: 'Maximum search hits (default 12, max 50).',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args, exec) => {
          const agent = requireAgent(exec)
          const snapshot = await this.snapshot(agent, exec.signal)
          if (args.action === 'show') {
            if (!args.ref?.trim()) throw new Error('show requires ref')
            const entry = showCapability(snapshot.capabilities, args.ref)
            if (!entry) throw new Error(`unknown capability ref ${JSON.stringify(args.ref)}`)
            return JSON.stringify(
              { capability: entry, skillsComplete: snapshot.skillsComplete },
              null,
              2,
            )
          }
          if (!args.query?.trim()) throw new Error('search requires query')
          const options: CapabilitySearchOptions = {
            kinds: parseKinds(args.kinds),
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          }
          const hits = searchCapabilities(snapshot.capabilities, args.query, options)
          this.recordMiss(args.query, options.kinds, hits.length, snapshot.skillsComplete)
          return JSON.stringify(
            {
              hits,
              counts: snapshot.counts,
              skillsComplete: snapshot.skillsComplete,
            },
            null,
            2,
          )
        },
      }),
    )
  }

  async snapshot(agent: Agent, signal?: AbortSignal): Promise<CapabilitySnapshot> {
    return aggregateCapabilities(await this.collect(agent, signal))
  }

  private async collect(agent: Agent, signal?: AbortSignal): Promise<CapabilitySources> {
    signal?.throwIfAborted()
    const tools = this.ctx.tools.schemas(agent).map((schema) => ({
      name: schema.name,
      description: schema.description ?? '',
    }))

    let skills: SkillSummaryLike[] = []
    let skillsComplete = true
    try {
      const skillSnapshot = await this.ctx.skills.snapshot({
        scope: agent,
        cwd: agent.session.header.cwd,
        signal,
      })
      skills = skillSnapshot.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        invocation: skill.invocation,
        provider: skill.provider,
        source: String(skill.source),
      }))
      skillsComplete = skillSnapshot.complete
    } catch (error) {
      signal?.throwIfAborted()
      this.ctx.logger.warn(
        `oh-my-dsh: capability discovery could not read skills: ${String(error)}`,
      )
      skillsComplete = false
    }
    signal?.throwIfAborted()

    const commands = this.ctx.commands.list(agent).map((command) => ({
      name: command.name,
      description: command.description,
      input: command.input,
    }))

    const mcpServers = this.ctx.mcpControl.list(agent)
    const plugins = this.ctx.pluginControl.list(agent)
    const forgedPlugins = (await this.ctx.get('pluginForge')?.listForDiscovery(agent)) ?? []

    return { tools, skills, skillsComplete, commands, mcpServers, plugins, forgedPlugins }
  }

  private recordMiss(
    query: string,
    kinds: readonly CapabilityKind[] | undefined,
    hitCount: number,
    skillsComplete: boolean,
  ): void {
    if (
      !shouldRecordSearchMiss({
        hitCount,
        skillsComplete,
        kinds,
      })
    ) {
      return
    }
    const forge = this.ctx.get('pluginForge')
    if (!forge) return
    void forge.recordSearchMiss({ query, kinds, hitCount, skillsComplete }).catch((error) => {
      this.ctx.logger.warn(`oh-my-dsh: could not record capability gap: ${String(error)}`)
    })
  }
}

export default CapabilityDiscoveryRuntime
