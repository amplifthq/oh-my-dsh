/**
 * Unified, read-only capability discovery for oh-my-dsh.
 *
 * Searches model-visible tools, skills, slash commands, inert/active MCP
 * servers, and curated session plugins. Never activates a process, imports a
 * package, expands credentials, or creates a proposal — those remain on
 * mcp_control, plugin_control, and proposal_control.
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
  if (!hits.length) return options.emptyMessage ?? 'No matching capabilities.'
  const lines = hits.map((hit) => {
    const risk = hit.risk ? ` risk=${JSON.stringify(hit.risk)}` : ''
    return (
      `${hit.ref} [${hit.status}] score=${hit.score} — ${hit.summary}` +
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
        'active tools, skills, slash commands, inert MCP servers, and curated session plugins. ' +
        'Discovery is read-only: activating an MCP server or loading a plugin still requires ' +
        'mcp_control / plugin_control prepare_* plus an approved proposal_control apply.',
    })

    ctx.commands.register({
      name: 'omd-capabilities',
      description: 'Search tools, skills, commands, MCP servers, and curated plugins.',
      input: { hint: 'search query' },
      recordInput: false,
      handler: async ({ agent, rawInput }) => {
        const query = rawInput.trim()
        if (!query) {
          return {
            kind: 'success',
            text: 'Usage: /omd-capabilities <query> — e.g. /omd-capabilities browser',
          }
        }
        const snapshot = await this.snapshot(agent as Agent)
        const hits = searchCapabilities(snapshot.capabilities, query)
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
          'Search the unified capability catalog (tools, skills, commands, MCP servers, curated plugins) or show one stable ref. Read-only: never activates MCP servers or loads plugins.',
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
      this.ctx.logger.warn(
        `oh-my-dsh: capability discovery could not read skills: ${String(error)}`,
      )
      skillsComplete = false
    }

    const commands = this.ctx.commands.list(agent).map((command) => ({
      name: command.name,
      description: command.description,
      input: command.input,
    }))

    const mcpServers = this.ctx.mcpControl.list(agent)
    const plugins = this.ctx.pluginControl.list(agent)

    return { tools, skills, skillsComplete, commands, mcpServers, plugins }
  }
}

export default CapabilityDiscoveryRuntime
