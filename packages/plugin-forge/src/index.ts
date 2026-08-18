import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
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
  IN_PROCESS_PRIVILEGE_WARNING,
  OrganController,
  organUnloadCommit,
  planOrganUnload,
  registerOrganOwnerCleanup,
  type OrganIndexEntry,
} from '../../plugin-control/src/index.js'
import {
  scanPluginSource,
  validateForgedPluginInput,
  type ForgedPluginDocument,
  type ForgedPluginInput,
  type PluginSourceReport,
} from './document.js'
import { readBundledOrganIndex } from '../../plugin-control/src/index.js'
import {
  assemblePromotionPacket,
  appendCapabilityGap,
  appendUsageEvent,
  attributionKey,
  emptyUsage,
  readAttribution,
  readCapabilityGaps,
  recordMountAttribution,
  summarizeUsage,
  writePromotionPacket,
} from './journal.js'
import { type ForgedCapabilityView } from './evidence.js'
import { capabilityRef } from '../../capability-discovery/src/catalog.js'
import {
  commitForgedPluginWrite,
  ensureImportResolution,
  forgedSourceFileUrl,
  listForgedPlugins,
  planForgedPluginWrite,
  readForgedPlugin,
  resolveForgedPluginTarget,
  type ForgeRoots,
  type ForgedPluginScope,
  type ForgedPluginState,
  type ForgedPluginTarget,
  type ForgedPluginWritePlan,
} from './store.js'

export const name = 'omd-plugin-forge'

export const FORGED_PRIVILEGE_WARNING =
  `${IN_PROCESS_PRIVILEGE_WARNING} This code was written by the agent during this session, ` +
  'so the proposal review is the entire trust decision.'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginForge: PluginForgeRuntime
    proposals: ProposalRuntime
  }
}

export * from './document.js'
export * from './evidence.js'
export * from './journal.js'
export * from './store.js'

const HOST_TOOL_NAMES = new Set([
  'plugin_forge',
  'proposal_control',
  'capability_search',
  'plugin_control',
  'mcp_control',
  'skill_control',
  'eval_control',
  'opt_control',
])

interface LiveAttribution {
  slug: string
  scope: ForgedPluginScope
  digest: string
  revision: number
  tools: Set<string>
}

function snapshotToolNames(ctx: Context, owner: object): string[] {
  const schemas = (ctx as { tools?: { schemas?: (scope?: object) => Array<{ name: string }> } })
    .tools?.schemas
  if (typeof schemas !== 'function') return []
  const names = new Set<string>()
  for (const scope of [undefined, owner]) {
    try {
      for (const schema of schemas(scope)) {
        if (schema?.name) names.add(schema.name)
      }
    } catch {
      // Invalid or re-entrant scope views are skipped; the other view may work.
    }
  }
  return [...names]
}

function jsonSafe(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export function forgedEntry(target: ForgedPluginTarget, state: ForgedPluginState): OrganIndexEntry {
  const entry: OrganIndexEntry = {
    id: state.meta.slug,
    module: forgedSourceFileUrl(target, state.meta),
    version: `0.0.${state.meta.revision}`,
    summary: state.meta.summary,
    risk:
      `Agent-forged revision ${state.meta.revision} (sha256 ${state.meta.digest.slice(0, 12)}…). ` +
      FORGED_PRIVILEGE_WARNING,
    manifest: { ...state.meta.manifest },
    source: 'oh-my-dsh',
  }
  if (state.meta.config !== undefined) entry.config = state.meta.config
  return entry
}

/**
 * Commit-time defense in depth: re-read the stored plugin, require the source
 * to hash to the reviewed digest, and re-run the static scan before anything
 * is imported. Catches disk drift between prepare and apply; a local attacker
 * with filesystem write access is outside this threat model.
 */
export async function verifyForgedState(
  target: ForgedPluginTarget,
  reviewedDigest: string,
): Promise<{ state: ForgedPluginState; entry: OrganIndexEntry }> {
  const state = await readForgedPlugin(target)
  if (!state) {
    throw new Error(
      `forged plugin at ${target.metaPath} disappeared after the proposal was prepared`,
    )
  }
  if (!state.digestMatches || state.source === undefined) {
    throw new Error(
      `forged plugin source at ${target.directory} does not hash to its plugin.json digest; ` +
        'refusing to import it',
    )
  }
  if (state.meta.digest !== reviewedDigest) {
    throw new Error(
      `forged plugin "${state.meta.slug}" changed after the proposal was prepared: reviewed ` +
        `digest ${reviewedDigest.slice(0, 12)}…, stored ${state.meta.digest.slice(0, 12)}…; ` +
        'prepare a fresh proposal',
    )
  }
  await scanPluginSource(state.source)
  return { state, entry: forgedEntry(target, state) }
}

export interface PlannedForge {
  target: ForgedPluginTarget
  plan: ForgedPluginWritePlan
  report: PluginSourceReport
  expectedMetaDigest?: string
  title: string
  summary: string
  effects: ProposalEffect[]
}

export async function planForge(
  document: ForgedPluginDocument,
  scope: ForgedPluginScope,
  roots: ForgeRoots,
): Promise<PlannedForge> {
  const report = await scanPluginSource(document.source)
  const target = resolveForgedPluginTarget(scope, document.slug, roots)
  const existing = await readForgedPlugin(target)
  const plan = planForgedPluginWrite(document, scope, existing)
  const verb = plan.action === 'create' ? 'Create' : 'Revise'
  return {
    target,
    plan,
    report,
    expectedMetaDigest: existing?.metaDigest,
    title: `Forge plugin "${document.slug}" (${scope} scope, revision ${plan.meta.revision})`,
    summary:
      `${verb} agent-authored source at ${target.directory} and mount it in this session ` +
      `after explicit approval. ${FORGED_PRIVILEGE_WARNING}`,
    effects: [
      {
        type: 'plugin-forge',
        target: target.metaPath,
        summary:
          `${verb} and mount forged plugin "${document.slug}" revision ${plan.meta.revision}` +
          (plan.warnings.length ? ` — ${plan.warnings.length} content warning(s)` : '') +
          `. ${FORGED_PRIVILEGE_WARNING}`,
        details: jsonSafe({
          scope,
          slug: document.slug,
          action: plan.action,
          revision: plan.meta.revision,
          digest: plan.digest,
          sourceFile: plan.sourceFile,
          imports: report.imports,
          manifest: document.manifest,
          intendedEffects: document.intendedEffects,
          config: document.config ?? null,
          warnings: plan.warnings,
          source: document.source,
          before: existing?.source ?? null,
          path: target.metaPath,
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

export function forgeCommit(
  planned: PlannedForge,
  controller: OrganController,
  owner: object,
  ownerCtx: Context,
  lifecycleSignal?: AbortSignal,
  onMounted?: (
    owner: object,
    target: ForgedPluginTarget,
    state: ForgedPluginState,
    attributedTools: readonly string[],
  ) => void,
): (exec: ToolRunContext) => Promise<ProposalCommitResult> {
  const snapshot = {
    target: planned.target,
    plan: structuredClone(planned.plan),
    expectedMetaDigest: planned.expectedMetaDigest,
  }
  return async (exec) => {
    await commitForgedPluginWrite(snapshot.target, snapshot.plan, snapshot.expectedMetaDigest)
    await ensureImportResolution(snapshot.target.root)
    // The write is durable from here: a failed mount leaves the source inert
    // on disk so the agent can revise it instead of losing the revision.
    const { state, entry } = await verifyForgedState(snapshot.target, snapshot.plan.digest)
    const beforeTools = snapshotToolNames(ownerCtx, owner)
    const loaded = await controller.load(
      owner,
      ownerCtx,
      entry,
      entry.config ?? {},
      commitSignal(exec, lifecycleSignal),
    )
    const registered = snapshotToolNames(ownerCtx, owner).filter(
      (name) => !beforeTools.includes(name),
    )
    const attributedTools = await recordMountAttribution(
      snapshot.target,
      state,
      loaded.effectLabels,
      registered,
      snapshot.plan.document.source,
    )
    onMounted?.(owner, snapshot.target, state, attributedTools)
    return {
      summary:
        `Forged plugin "${loaded.id}" revision ${state.meta.revision} written to ` +
        `${snapshot.target.metaPath} and mounted (Cordis state ${loaded.fiberState}).`,
      details: jsonSafe({
        loaded,
        revision: state.meta.revision,
        digest: state.meta.digest,
        declaredIntendedEffects: state.meta.intendedEffects,
        observedEffectLabels: loaded.effectLabels,
        attributedTools,
      }),
    }
  }
}

function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new Error('plugin_forge requires an active agent session')
  return exec.agent
}

export class PluginForgeRuntime extends Service {
  static inject = ['tools', 'proposals', 'commands', 'systemPrompt']

  private readonly controller = new OrganController({
    importModule: (specifier) => import(specifier),
    // Availability is verified by verifyForgedState immediately before load;
    // the curated version-pin check does not apply to file-backed sources.
    checkAvailability: () => {},
  })
  private readonly lifecycle = new AbortController()
  private readonly owners = new Set<Agent>()
  private readonly liveAttribution = new WeakMap<Agent, Map<string, LiveAttribution>>()

  constructor(ctx: Context) {
    super(ctx, 'pluginForge')

    ctx.effect(
      () => async () => {
        this.lifecycle.abort(new Error('omd-plugin-forge unloaded'))
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
      'omd-plugin-forge.lifecycle',
    )

    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next()
      if (exec.agent && typeof exec.name === 'string') {
        await this.recordInvocation(exec.agent, exec.name).catch(() => {
          // Usage is evidence, not a control-plane failure.
        })
      }
      return decision
    })

    ctx.systemPrompt.section({
      name: 'omd:plugin-forge',
      order: 112,
      text:
        'Forged plugins are agent-authored code that runs in-process only after an approved ' +
        'proposal. When a capability_search miss repeats, draft a minimal Cordis plugin and call ' +
        'plugin_forge prepare_forge with the complete source; declare every import and intended ' +
        'effect honestly. Use plugin_forge gaps and usage to decide what to forge, revise, or ' +
        'retire. prepare_promote writes a human-reviewed pull-request draft only — it never ' +
        'writes the curated catalog. When eval_control is mounted, promote needs a non-regressing ' +
        'compare mode=diff and a faithful compare mode=ablate. Never claim a forged plugin is ' +
        'active before an approved proposal_control apply reports Cordis state ACTIVE. Prefer ' +
        'revising a failed plugin over retrying identical source, and unload forged plugins when ' +
        'no longer needed.',
    })

    ctx.commands.register({
      name: 'omd-forged',
      description: 'List agent-forged plugins with revision, digest, and session state.',
      recordInput: false,
      handler: async ({ agent }) => {
        const views = await this.listForDiscovery(agent)
        return {
          kind: 'success',
          text: views.length
            ? views
                .map((view) =>
                  view.status === 'ok'
                    ? `${view.active ? '●' : '○'} ${view.slug} [${view.scope}] ` +
                      `rev ${view.revision} ${view.digest.slice(0, 12)} ` +
                      `${view.digestMatches ? '' : '[digest mismatch] '}` +
                      `${view.invocations ?? 0} calls — ${view.summary}`
                    : `✗ ${view.slug} [${view.scope}] invalid — ${view.reason}`,
                )
                .join('\n')
            : 'No forged plugins.',
        }
      },
    })

    ctx.commands.register({
      name: 'omd-gaps',
      description: 'List recent capability_search misses that can steer plugin forge.',
      recordInput: false,
      handler: async ({ agent }) => {
        const gaps = await readCapabilityGaps(this.roots(agent).dshHome)
        return {
          kind: 'success',
          text: gaps.length
            ? gaps
                .slice(-20)
                .map(
                  (gap) =>
                    `${gap.at} hits=${gap.hitCount}${gap.redacted ? ' redacted' : ''} — ${gap.query}`,
                )
                .join('\n')
            : 'No recorded capability_search misses.',
        }
      },
    })

    ctx.tools.register(
      defineTool({
        name: 'plugin_forge',
        description:
          'Author, persist, and mount agent-written session plugins through approval-gated ' +
          'proposals. prepare_forge stages the complete reviewed source; only an approved ' +
          'proposal_control apply writes and mounts it. prepare_promote writes a catalog ' +
          'pull-request draft and never writes presets/plugins.json. Imports are whitelisted ' +
          'for review clarity, not sandboxing: forged code runs in-process with full privileges.',
        parameters: {
          action: {
            type: 'string',
            required: true,
            enum: [
              'list',
              'show',
              'gaps',
              'usage',
              'prepare_forge',
              'prepare_load',
              'prepare_unload',
              'prepare_promote',
            ],
            description: 'Inventory, evidence, or proposal operation.',
          },
          scope: {
            type: 'string',
            enum: ['user', 'project'],
            description:
              'user → $DSH_HOME/forged-plugins (every project); project → ' +
              '<workspace>/.dsh/forged-plugins (this repository only).',
          },
          name: {
            type: 'string',
            description: 'Forged plugin slug: lowercase letters, digits, hyphens, ≤ 41 chars.',
          },
          summary: {
            type: 'string',
            description: 'Single-line description of what the plugin does (≤ 500 characters).',
          },
          manifest: {
            type: 'object',
            additionalProperties: true,
            description:
              'Declared { name, provide: string[], inject: string[] }; name must equal the slug ' +
              'and is verified against the imported module at mount.',
          },
          intended_effects: {
            type: 'array',
            items: { type: 'string' },
            description:
              '1-8 single-line statements of what the plugin will register or change, compared ' +
              'against observed Cordis effect labels after mount.',
          },
          source: {
            type: 'string',
            description:
              'Complete ESM source (≤ 32 KiB). Static imports only from @deepseek-ai/cordis and ' +
              '@deepseek-ai/dsh-tools; no dynamic import() or require; must export name and apply.',
          },
          config: {
            type: 'object',
            additionalProperties: true,
            description: 'Optional JSON config passed to the plugin at mount.',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args, exec) => {
          const agent = requireAgent(exec)
          const roots = this.roots(agent)
          if (args.action === 'list') {
            return JSON.stringify(
              {
                plugins: await this.listForDiscovery(agent),
                active: this.controller.list(agent),
                gaps: await readCapabilityGaps(roots.dshHome),
              },
              null,
              2,
            )
          }
          if (args.action === 'gaps') {
            return JSON.stringify({ gaps: await readCapabilityGaps(roots.dshHome) }, null, 2)
          }
          if (args.action === 'prepare_unload') {
            if (!args.name) throw new Error('prepare_unload requires name')
            const slug = args.name
            const active = this.controller.list(agent).find((view) => view.id === slug)
            if (!active) throw new Error(`forged plugin "${slug}" is not active`)
            const planned = planOrganUnload(active)
            const proposal = ctx.proposals.create(agent, {
              kind: 'plugin-unload',
              title: planned.title,
              summary: planned.summary,
              effects: planned.effects,
              signal: this.lifecycle.signal,
              commit: async () => {
                const result = await organUnloadCommit(planned, this.controller, agent)()
                this.forgetAttribution(agent, slug)
                return result
              },
            })
            return JSON.stringify({ proposal }, null, 2)
          }
          const scope = requireScope(args.scope)
          if (!args.name) throw new Error(`${args.action} requires name`)
          if (args.action === 'show' || args.action === 'usage') {
            const target = resolveForgedPluginTarget(scope, args.name, roots)
            const state = await readForgedPlugin(target)
            if (!state) throw new Error(`no forged plugin "${args.name}" in ${scope} scope`)
            const active = this.controller.list(agent).some((view) => view.id === args.name)
            const usage = await summarizeUsage(target, state.meta.slug, scope)
            if (args.action === 'usage') return JSON.stringify({ usage }, null, 2)
            return JSON.stringify({ plugin: { ...state, active, usage } }, null, 2)
          }
          this.ensureOwner(agent)
          if (args.action === 'prepare_promote') {
            return JSON.stringify(
              { proposal: await this.preparePromote(agent, scope, args.name, roots) },
              null,
              2,
            )
          }
          if (args.action === 'prepare_load') {
            if (this.controller.list(agent).some((view) => view.id === args.name)) {
              throw new Error(`forged plugin "${args.name}" is already active`)
            }
            const target = resolveForgedPluginTarget(scope, args.name, roots)
            const state = await readForgedPlugin(target)
            if (!state) throw new Error(`no forged plugin "${args.name}" in ${scope} scope`)
            if (!state.digestMatches || state.source === undefined) {
              throw new Error(
                `forged plugin "${args.name}" source does not hash to its stored digest; ` +
                  'forge a fresh revision instead of loading it',
              )
            }
            const report = await scanPluginSource(state.source)
            const reviewedDigest = state.meta.digest
            const proposal = ctx.proposals.create(agent, {
              kind: 'plugin-load',
              title: `Load forged plugin "${state.meta.slug}" (revision ${state.meta.revision})`,
              summary:
                `Mount the previously forged ${scope}-scope plugin after approval. ` +
                FORGED_PRIVILEGE_WARNING,
              effects: [
                {
                  type: 'plugin-load',
                  target: `${state.meta.slug}@0.0.${state.meta.revision}`,
                  summary:
                    `Mount forged plugin "${state.meta.slug}" revision ${state.meta.revision}. ` +
                    FORGED_PRIVILEGE_WARNING,
                  details: jsonSafe({
                    scope,
                    slug: state.meta.slug,
                    revision: state.meta.revision,
                    digest: reviewedDigest,
                    imports: report.imports,
                    manifest: state.meta.manifest,
                    intendedEffects: state.meta.intendedEffects,
                    config: state.meta.config ?? null,
                    source: state.source,
                  }),
                },
              ],
              signal: this.lifecycle.signal,
              commit: async (commitExec) => {
                await ensureImportResolution(target.root)
                const { state: fresh, entry } = await verifyForgedState(target, reviewedDigest)
                const beforeTools = snapshotToolNames(agent.ctx, agent)
                const loaded = await this.controller.load(
                  agent,
                  agent.ctx,
                  entry,
                  entry.config ?? {},
                  commitSignal(commitExec, this.lifecycle.signal),
                )
                const registered = snapshotToolNames(agent.ctx, agent).filter(
                  (name) => !beforeTools.includes(name),
                )
                const attributedTools = await recordMountAttribution(
                  target,
                  fresh,
                  loaded.effectLabels,
                  registered,
                  fresh.source ?? '',
                )
                this.rememberAttribution(agent, target, fresh, attributedTools)
                return {
                  summary:
                    `Loaded forged plugin "${loaded.id}" revision ${fresh.meta.revision} ` +
                    `(Cordis state ${loaded.fiberState}).`,
                  details: jsonSafe({ loaded, digest: fresh.meta.digest, attributedTools }),
                }
              },
            })
            return JSON.stringify({ proposal }, null, 2)
          }
          // prepare_forge
          if (this.controller.list(agent).some((view) => view.id === args.name)) {
            throw new Error(
              `forged plugin "${args.name}" is active in this session; unload it before forging ` +
                'a new revision',
            )
          }
          const document = validateForgedPluginInput({
            slug: args.name,
            summary: args.summary ?? '',
            manifest: (args.manifest ?? {}) as ForgedPluginInput['manifest'],
            intendedEffects: (args.intended_effects ?? []) as string[],
            source: args.source ?? '',
            config: args.config,
          })
          const planned = await planForge(document, scope, roots)
          const proposal = ctx.proposals.create(agent, {
            kind: 'plugin-forge',
            title: planned.title,
            summary: planned.summary,
            effects: planned.effects,
            signal: this.lifecycle.signal,
            commit: forgeCommit(
              planned,
              this.controller,
              agent,
              agent.ctx,
              this.lifecycle.signal,
              (owner, target, state, attributedTools) => {
                this.rememberAttribution(owner as Agent, target, state, attributedTools)
              },
            ),
          })
          return JSON.stringify(
            { proposal, imports: planned.report.imports, warnings: planned.plan.warnings },
            null,
            2,
          )
        },
      }),
    )
  }

  list(agent: Agent): ReturnType<OrganController['list']> {
    return this.controller.list(agent)
  }

  async listForDiscovery(agent: Agent): Promise<ForgedCapabilityView[]> {
    const active = new Set(this.controller.list(agent).map((view) => view.id))
    const roots = this.roots(agent)
    const summaries = await listForgedPlugins(roots)
    const views: ForgedCapabilityView[] = []
    for (const summary of summaries) {
      if (summary.status === 'invalid') {
        views.push({
          slug: summary.slug,
          scope: summary.scope,
          summary: summary.reason,
          revision: 0,
          digest: '0'.repeat(64),
          digestMatches: false,
          active: false,
          status: 'invalid',
          reason: summary.reason,
          risk: FORGED_PRIVILEGE_WARNING,
        })
        continue
      }
      const usage = await summarizeUsage(
        resolveForgedPluginTarget(summary.scope, summary.slug, roots),
        summary.slug,
        summary.scope,
      ).catch(() => emptyUsage(summary.slug, summary.scope))
      views.push({
        slug: summary.slug,
        scope: summary.scope,
        summary: summary.meta.summary,
        revision: summary.meta.revision,
        digest: summary.meta.digest,
        digestMatches: summary.digestMatches,
        active: active.has(summary.slug),
        status: 'ok',
        risk: FORGED_PRIVILEGE_WARNING,
        invocations: usage.totalInvocations,
      })
    }
    return views
  }

  async recordSearchMiss(input: {
    query: string
    kinds?: readonly string[]
    hitCount: number
    skillsComplete: boolean
  }): Promise<void> {
    const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
    await appendCapabilityGap(dshHome, input)
  }

  async recordInvocation(agent: Agent, toolName: string): Promise<void> {
    if (HOST_TOOL_NAMES.has(toolName)) return
    const match = await this.attributionFor(agent, toolName)
    if (!match) return
    await appendUsageEvent(match.target, {
      at: new Date().toISOString(),
      tool: toolName,
      digest: match.digest,
      revision: match.revision,
    })
  }

  private async preparePromote(
    agent: Agent,
    scope: ForgedPluginScope,
    name: string,
    roots: ForgeRoots,
  ) {
    const target = resolveForgedPluginTarget(scope, name, roots)
    const state = await readForgedPlugin(target)
    if (!state) throw new Error(`no forged plugin "${name}" in ${scope} scope`)
    if (!state.digestMatches || state.source === undefined) {
      throw new Error(
        `forged plugin "${name}" source does not hash to its stored digest; ` +
          'forge a fresh revision before promoting',
      )
    }
    const report = await scanPluginSource(state.source)
    const evalRuntime = this.ctx.get('harnessEval') as
      | {
          roots(owner: Agent): { dshHome: string; workspace?: string; bundledTasks: string }
          assertPromotionAllowed(
            roots: { dshHome: string; workspace?: string; bundledTasks: string },
            pluginRef: string,
          ): Promise<unknown>
        }
      | undefined
    if (evalRuntime) {
      await evalRuntime.assertPromotionAllowed(
        evalRuntime.roots(agent),
        capabilityRef('plugin', `forged/${scope}/${name}`),
      )
    }
    const packet = await assemblePromotionPacket({
      target,
      state,
      report,
      privilegeWarning: FORGED_PRIVILEGE_WARNING,
      catalogIds: readBundledOrganIndex().map((entry) => entry.id),
      roots,
    })
    const reviewedDigest = state.meta.digest
    return this.ctx.proposals.create(agent, {
      kind: 'plugin-promote',
      title: `Promote forged plugin "${state.meta.slug}" to a catalog pull-request draft`,
      summary:
        `Write an audit packet under ${target.directory}/promotions/. ` +
        'Runtime never writes presets/plugins.json. ' +
        FORGED_PRIVILEGE_WARNING,
      effects: [
        {
          type: 'plugin-promote',
          target: `${state.meta.slug}@${state.meta.digest.slice(0, 12)}`,
          summary:
            'Assemble a human-reviewed promotion packet. Does not write the curated catalog.',
          details: jsonSafe({
            ...packet,
            catalogPath: 'presets/plugins.json',
            writesCatalog: false,
          }),
        },
      ],
      signal: this.lifecycle.signal,
      commit: async () => {
        const fresh = await readForgedPlugin(target)
        if (!fresh || fresh.meta.digest !== reviewedDigest) {
          throw new Error(
            `forged plugin "${name}" changed after the proposal was prepared; ` +
              'prepare a fresh promotion packet',
          )
        }
        const written = await writePromotionPacket(target, packet)
        return {
          summary: `Wrote promotion packet to ${written.directory}. Catalog was not modified.`,
          details: jsonSafe({
            written,
            blockingReasons: packet.blockingReasons,
            writesCatalog: false,
          }),
        }
      },
    })
  }

  private rememberAttribution(
    agent: Agent,
    target: ForgedPluginTarget,
    state: ForgedPluginState,
    attributedTools: readonly string[],
  ): void {
    let map = this.liveAttribution.get(agent)
    if (!map) {
      map = new Map()
      this.liveAttribution.set(agent, map)
    }
    map.set(attributionKey(target.scope, state.meta.slug), {
      slug: state.meta.slug,
      scope: target.scope,
      digest: state.meta.digest,
      revision: state.meta.revision,
      tools: new Set(attributedTools),
    })
  }

  private forgetAttribution(agent: Agent, slug: string): void {
    const map = this.liveAttribution.get(agent)
    if (!map) return
    for (const key of map.keys()) {
      if (key.endsWith(`:${slug}`)) map.delete(key)
    }
  }

  private async attributionFor(
    agent: Agent,
    toolName: string,
  ): Promise<{ target: ForgedPluginTarget; digest: string; revision: number } | undefined> {
    const live = this.liveAttribution.get(agent)
    if (live) {
      for (const record of live.values()) {
        if (!record.tools.has(toolName)) continue
        return {
          target: resolveForgedPluginTarget(record.scope, record.slug, this.roots(agent)),
          digest: record.digest,
          revision: record.revision,
        }
      }
    }
    const roots = this.roots(agent)
    for (const view of this.controller.list(agent)) {
      for (const scope of roots.workspace ? (['project', 'user'] as const) : (['user'] as const)) {
        try {
          const target = resolveForgedPluginTarget(scope, view.id, roots)
          const attribution = await readAttribution(target)
          if (attribution?.attributedTools.includes(toolName)) {
            return { target, digest: attribution.digest, revision: attribution.revision }
          }
        } catch {
          // Wrong scope or unsafe slug: keep looking.
        }
      }
    }
    return undefined
  }

  private ensureOwner(agent: Agent): void {
    if (this.owners.has(agent)) return
    this.owners.add(agent)
    registerOrganOwnerCleanup(agent, this.controller, () => {
      this.owners.delete(agent)
      this.liveAttribution.delete(agent)
    })
  }

  private roots(agent: Agent): ForgeRoots {
    const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
    const headerCwd = agent.session.header.cwd
    return { dshHome, workspace: headerCwd ? resolve(headerCwd) : undefined }
  }
}

function requireScope(scope: unknown): ForgedPluginScope {
  if (scope !== 'user' && scope !== 'project') {
    throw new Error('this action requires scope "user" or "project"')
  }
  return scope
}

export default PluginForgeRuntime
