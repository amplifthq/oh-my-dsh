import { readFileSync } from 'node:fs'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'

import type {
  ProposalCommitResult,
  ProposalEffect,
  ProposalRuntime,
} from '../../proposals/src/index.ts'
import {
  organView,
  parseOrganIndex,
  resolveOrganAvailability,
  type OrganIndexEntry,
  type OrganView,
} from './catalog.js'
import { OrganController, type ActiveOrganView } from './controller.js'

export const name = 'omd-plugin-control'

export const IN_PROCESS_PRIVILEGE_WARNING =
  "Runs in-process with the harness's full privileges (environment, filesystem, network) — a stronger grant than MCP activation."

declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginControl: PluginControlRuntime
    proposals: ProposalRuntime
  }
}

export * from './catalog.js'
export * from './controller.js'

export interface PlannedOrganLoad {
  entry: OrganIndexEntry
  config: Record<string, unknown>
  title: string
  summary: string
  effects: ProposalEffect[]
}

export interface PlannedOrganUnload {
  active: ActiveOrganView
  title: string
  summary: string
  effects: ProposalEffect[]
}

function jsonSafe(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function jsonObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`)
  }
  const cloned = jsonSafe(value)
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new Error(`${field} must be a JSON object`)
  }
  return cloned as Record<string, unknown>
}

export function planOrganLoad(
  entry: OrganIndexEntry,
  configOverride: Record<string, unknown> = {},
): PlannedOrganLoad {
  const config = {
    ...jsonObject(entry.config, 'plugin default config'),
    ...jsonObject(configOverride, 'plugin config override'),
  }
  const target = `${entry.module}@${entry.version}`
  return {
    entry: structuredClone(entry),
    config,
    title: `Load curated plugin "${entry.id}"`,
    summary:
      `Mount ${target} inside this agent session after approval. ` +
      `${IN_PROCESS_PRIVILEGE_WARNING}`,
    effects: [
      {
        type: 'plugin-load',
        target,
        summary: `Mount curated plugin "${entry.id}". ${IN_PROCESS_PRIVILEGE_WARNING}`,
        details: jsonSafe({
          id: entry.id,
          module: entry.module,
          version: entry.version,
          source: entry.source,
          provenance: entry.provenance ?? null,
          summary: entry.summary,
          risk: entry.risk,
          manifest: entry.manifest,
          config,
          privilege: IN_PROCESS_PRIVILEGE_WARNING,
        }),
      },
    ],
  }
}

export function planOrganUnload(active: ActiveOrganView): PlannedOrganUnload {
  return {
    active: structuredClone(active),
    title: `Unload plugin "${active.id}"`,
    summary:
      `Dispose ${active.module}@${active.version} from this agent session and run ` +
      'its Cordis effect reversal chain.',
    effects: [
      {
        type: 'plugin-unload',
        target: active.id,
        summary: `Dispose plugin "${active.id}" and reverse its live effects.`,
        details: jsonSafe({
          id: active.id,
          instanceId: active.instanceId,
          module: active.module,
          version: active.version,
          fiberState: active.fiberState,
          effectLabels: active.effectLabels,
          config: active.config,
        }),
      },
    ],
  }
}

function commitSignal(
  exec: ToolRunContext,
  lifecycleSignal?: AbortSignal,
): AbortSignal | undefined {
  const signals = [exec.signal, lifecycleSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  )
  return signals.length ? AbortSignal.any(signals) : undefined
}

export function organLoadCommit(
  planned: PlannedOrganLoad,
  controller: OrganController,
  owner: object,
  ownerCtx: Context,
  lifecycleSignal?: AbortSignal,
): (exec: ToolRunContext) => Promise<ProposalCommitResult> {
  const snapshot = structuredClone(planned)
  return async (exec) => {
    const loaded = await controller.load(
      owner,
      ownerCtx,
      snapshot.entry,
      snapshot.config,
      commitSignal(exec, lifecycleSignal),
    )
    return {
      summary: `Loaded plugin "${loaded.id}" in Cordis state ${loaded.fiberState}.`,
      details: jsonSafe(loaded),
    }
  }
}

export function organUnloadCommit(
  planned: PlannedOrganUnload,
  controller: OrganController,
  owner: object,
): () => Promise<ProposalCommitResult> {
  const snapshot = structuredClone(planned)
  return async () => {
    const unloaded = await controller.unload(owner, snapshot.active.id, snapshot.active.instanceId)
    if (!unloaded) throw new Error(`plugin "${snapshot.active.id}" is no longer active`)
    return {
      summary: `Unloaded plugin "${snapshot.active.id}" and reversed its Cordis effects.`,
      details: jsonSafe({
        id: snapshot.active.id,
        reversedEffects: snapshot.active.effectLabels,
      }),
    }
  }
}

export function readBundledOrganIndex(): OrganIndexEntry[] {
  const path = new URL('../../../../presets/plugins.json', import.meta.url)
  return parseOrganIndex(readFileSync(path, 'utf8'))
}

function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new Error('plugin_control requires an active agent session')
  return exec.agent
}

export function registerOrganOwnerCleanup(
  owner: Pick<Agent, 'id' | 'ctx'>,
  controller: OrganController,
  onDispose: () => void = () => {},
): () => Promise<void> {
  return owner.ctx.effect(
    () => async () => {
      onDispose()
      await controller.disposeOwner(owner)
    },
    `omd-plugin-control.owner.${String(owner.id)}`,
  )
}

export class PluginControlRuntime extends Service {
  static inject = ['tools', 'proposals', 'commands', 'systemPrompt']

  private readonly controller = new OrganController()
  private readonly catalog = readBundledOrganIndex()
  private readonly byId = new Map(this.catalog.map((entry) => [entry.id, entry]))
  private readonly lifecycle = new AbortController()
  private readonly owners = new Set<Agent>()

  constructor(ctx: Context) {
    super(ctx, 'pluginControl')

    ctx.effect(
      () => async () => {
        this.lifecycle.abort(new Error('omd-plugin-control unloaded'))
        let firstError: unknown
        for (const owner of this.owners) {
          try {
            await this.controller.disposeOwner(owner)
          } catch (error) {
            firstError ??= error
          }
        }
        this.owners.clear()
        if (firstError) throw firstError
      },
      'omd-plugin-control.lifecycle',
    )

    ctx.systemPrompt.section({
      name: 'omd:plugin-control',
      order: 111,
      text:
        'Session plugins are curated and inert. Use plugin_control list or show to inspect the ' +
        'catalog. prepare_load returns an exact, approval-gated proposal; never claim a plugin is ' +
        'active before an approved proposal_control apply reports Cordis state ACTIVE. Unload ' +
        'session plugins when they are no longer needed.',
    })

    ctx.commands.register({
      name: 'omd-plugins',
      description: 'List curated session plugins and their availability in this session.',
      recordInput: false,
      handler: ({ agent }) => {
        const views = this.views(agent)
        return {
          kind: 'success',
          text: views.length
            ? views
                .map(
                  (view) =>
                    `${view.active ? '●' : '○'} ${view.id} [${view.availability.status}] ` +
                    `${view.module}@${view.version} — ${view.summary}`,
                )
                .join('\n')
            : 'No curated plugins.',
        }
      },
    })

    ctx.tools.register(
      defineTool({
        name: 'plugin_control',
        description:
          'Inspect the curated plugin catalog or prepare an approval-gated session plugin load/unload. Arbitrary npm packages cannot be selected.',
        parameters: {
          action: {
            type: 'string',
            required: true,
            enum: ['list', 'show', 'prepare_load', 'prepare_unload'],
            description: 'Catalog or proposal operation.',
          },
          plugin_id: {
            type: 'string',
            description: 'Curated plugin id required by show, prepare_load, and prepare_unload.',
          },
          config: {
            type: 'object',
            additionalProperties: true,
            description: 'Optional config merged over the reviewed catalog defaults.',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args, exec) => {
          const agent = requireAgent(exec)
          if (args.action === 'list') {
            return JSON.stringify({ plugins: this.views(agent) }, null, 2)
          }
          if (!args.plugin_id) throw new Error(`${args.action} requires plugin_id`)
          const entry = this.byId.get(args.plugin_id)
          if (!entry) throw new Error(`unknown curated plugin "${args.plugin_id}"`)
          if (args.action === 'show') {
            return JSON.stringify({ plugin: this.view(agent, entry) }, null, 2)
          }
          this.ensureOwner(agent)
          if (args.action === 'prepare_load') {
            const view = this.view(agent, entry)
            if (view.active) throw new Error(`plugin "${entry.id}" is already active`)
            if (view.availability.status === 'not-installed') {
              throw new Error(
                `plugin "${entry.id}" is not installed; v1 never installs packages at runtime`,
              )
            }
            if (view.availability.status === 'version-drift') {
              throw new Error(
                `plugin "${entry.id}" version drift: reviewed ${view.availability.expectedVersion}, ` +
                  `installed ${view.availability.installedVersion}`,
              )
            }
            const planned = planOrganLoad(entry, jsonObject(args.config, 'plugin config'))
            const proposal = ctx.proposals.create(agent, {
              kind: 'plugin-load',
              title: planned.title,
              summary: planned.summary,
              effects: planned.effects,
              signal: this.lifecycle.signal,
              commit: organLoadCommit(
                planned,
                this.controller,
                agent,
                agent.ctx,
                this.lifecycle.signal,
              ),
            })
            return JSON.stringify({ proposal }, null, 2)
          }
          const active = this.controller.list(agent).find((organ) => organ.id === entry.id)
          if (!active) throw new Error(`plugin "${entry.id}" is not active`)
          const planned = planOrganUnload(active)
          const proposal = ctx.proposals.create(agent, {
            kind: 'plugin-unload',
            title: planned.title,
            summary: planned.summary,
            effects: planned.effects,
            signal: this.lifecycle.signal,
            commit: organUnloadCommit(planned, this.controller, agent),
          })
          return JSON.stringify({ proposal }, null, 2)
        },
      }),
    )
  }

  list(agent: Agent): OrganView[] {
    return this.views(agent)
  }

  private views(agent: Agent): OrganView[] {
    const active = new Set(this.controller.list(agent).map((organ) => organ.id))
    return this.catalog.map((entry) => this.view(agent, entry, active.has(entry.id)))
  }

  private view(agent: Agent, entry: OrganIndexEntry, active?: boolean): OrganView {
    const isActive = active ?? this.controller.list(agent).some((organ) => organ.id === entry.id)
    return organView(entry, resolveOrganAvailability(entry), isActive)
  }

  private ensureOwner(agent: Agent): void {
    if (this.owners.has(agent)) return
    this.owners.add(agent)
    registerOrganOwnerCleanup(agent, this.controller, () => this.owners.delete(agent))
  }
}

export default PluginControlRuntime
