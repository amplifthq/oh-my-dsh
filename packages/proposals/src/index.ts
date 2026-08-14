import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'

export const name = 'omd-proposals'

declare module '@deepseek-ai/cordis' {
  interface Context {
    proposals: ProposalRuntime
  }
}

export type ProposalKind =
  | 'mcp-activate'
  | 'mcp-deactivate'
  | 'lsp-refactor'
  | 'lsp-recovery'

export interface ProposalEffect {
  type: string
  target: string
  summary: string
  details?: JsonValue
}

export interface ProposalCommitResult {
  summary: string
  details?: JsonValue
}

export interface CreateProposalInput {
  kind: ProposalKind
  title: string
  summary: string
  effects: ProposalEffect[]
  signal?: AbortSignal
  commit(exec: ToolRunContext): Promise<ProposalCommitResult>
}

export interface ProposalView {
  id: string
  kind: ProposalKind
  title: string
  summary: string
  effects: ProposalEffect[]
  status: 'pending' | 'applying' | 'failed'
  error?: string
}

interface ProposalRecord extends ProposalView {
  commit(exec: ToolRunContext): Promise<ProposalCommitResult>
  detachAbort?: () => void
}

export class ProposalStore {
  private sequence = 0
  private readonly byOwner = new WeakMap<object, Map<string, ProposalRecord>>()

  create(owner: object, input: CreateProposalInput): ProposalView {
    if (input.signal?.aborted) throw new Error('cannot create a proposal from an aborted producer')
    const id = `proposal-${++this.sequence}`
    const record: ProposalRecord = {
      id,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      effects: structuredClone(input.effects),
      status: 'pending',
      commit: input.commit,
    }
    const records = this.records(owner)
    records.set(id, record)
    if (input.signal) {
      const onAbort = () => {
        if (record.status === 'pending' && records.get(id) === record) records.delete(id)
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
      record.detachAbort = () => input.signal?.removeEventListener('abort', onAbort)
    }
    return this.view(record)
  }

  list(owner: object): ProposalView[] {
    return [...(this.byOwner.get(owner)?.values() ?? [])].map((record) => this.view(record))
  }

  show(owner: object, id: string): ProposalView | undefined {
    const record = this.byOwner.get(owner)?.get(id)
    return record && this.view(record)
  }

  discard(owner: object, id: string): boolean {
    const records = this.byOwner.get(owner)
    const record = records?.get(id)
    if (!record) return false
    if (record.status === 'applying') {
      throw new Error('cannot discard an applying proposal')
    }
    record.detachAbort?.()
    return records?.delete(id) ?? false
  }

  async apply(owner: object, id: string, exec: ToolRunContext): Promise<ProposalCommitResult> {
    const record = this.byOwner.get(owner)?.get(id)
    if (!record) throw new Error(`unknown proposal "${id}"`)
    if (record.status !== 'pending') {
      throw new Error(`proposal "${id}" is not pending`)
    }
    record.status = 'applying'
    try {
      const result = await record.commit(exec)
      record.detachAbort?.()
      this.byOwner.get(owner)?.delete(id)
      return structuredClone(result)
    } catch (error) {
      record.status = 'failed'
      record.error = error instanceof Error ? error.message : String(error)
      record.detachAbort?.()
      throw error
    }
  }

  private records(owner: object): Map<string, ProposalRecord> {
    let records = this.byOwner.get(owner)
    if (!records) {
      records = new Map()
      this.byOwner.set(owner, records)
    }
    return records
  }

  private view(record: ProposalRecord): ProposalView {
    const { commit: _commit, detachAbort: _detachAbort, ...view } = record
    return structuredClone(view)
  }
}

export function requiresProposalApproval(toolName: string, args: unknown): boolean {
  if (toolName !== 'proposal_control' || !args || typeof args !== 'object') return false
  return (args as { action?: unknown }).action === 'apply'
}

export function proposalApprovalReason(proposal: ProposalView): string {
  return [
    `Apply reviewed proposal ${proposal.id}: ${proposal.title}`,
    proposal.summary,
    JSON.stringify({ kind: proposal.kind, effects: proposal.effects }, null, 2),
  ].join('\n')
}

function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new Error('proposal_control requires an active agent session')
  return exec.agent
}

export class ProposalRuntime extends Service {
  static inject = ['tools', 'systemPrompt']
  private readonly store = new ProposalStore()

  constructor(ctx: Context) {
    super(ctx, 'proposals')

    ctx.systemPrompt.section({
      name: 'omd:proposals',
      order: 109,
      text: 'Capability activation and semantic refactors return proposals. Inspect the exact effects, then use proposal_control apply only when the effects match the user intent. Applying always requires explicit user approval.',
    })

    ctx.on('tools/pre-execute', async (exec, next) => {
      if (!requiresProposalApproval(exec.name, exec.arguments)) return next()
      const proposalId = (exec.arguments as { proposal_id?: unknown }).proposal_id
      if (!exec.agent || typeof proposalId !== 'string') {
        return { kind: 'deny', reason: 'proposal apply requires an active agent and proposal_id' }
      }
      const proposal = this.store.show(exec.agent, proposalId)
      if (!proposal) return { kind: 'deny', reason: `unknown proposal "${proposalId}"` }
      return {
        kind: 'ask',
        reason: proposalApprovalReason(proposal),
      }
    })

    ctx.tools.register(defineTool({
      name: 'proposal_control',
      description: 'List, inspect, explicitly apply, or discard pending oh-my-dsh capability and refactor proposals.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'show', 'apply', 'discard'],
          description: 'Operation to perform.',
        },
        proposal_id: {
          type: 'string',
          description: 'Proposal id required by show, apply, and discard.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args, exec) => {
        const agent = requireAgent(exec)
        if (args.action === 'list') {
          return JSON.stringify({ action: 'list', proposals: this.list(agent) }, null, 2)
        }
        if (!args.proposal_id) {
          throw new Error(`${args.action} requires proposal_id`)
        }
        if (args.action === 'show') {
          return JSON.stringify({
            action: 'show',
            proposal: this.show(agent, args.proposal_id) ?? null,
          }, null, 2)
        }
        if (args.action === 'discard') {
          return JSON.stringify({
            action: 'discard',
            proposalId: args.proposal_id,
            discarded: this.discard(agent, args.proposal_id),
          }, null, 2)
        }
        return JSON.stringify({
          action: 'apply',
          proposalId: args.proposal_id,
          result: await this.apply(agent, args.proposal_id, exec),
        }, null, 2)
      },
    }))
  }

  create(agent: Agent, input: CreateProposalInput): ProposalView {
    return this.store.create(agent, input)
  }

  list(agent: Agent): ProposalView[] {
    return this.store.list(agent)
  }

  show(agent: Agent, id: string): ProposalView | undefined {
    return this.store.show(agent, id)
  }

  discard(agent: Agent, id: string): boolean {
    return this.store.discard(agent, id)
  }

  apply(agent: Agent, id: string, exec: ToolRunContext): Promise<ProposalCommitResult> {
    return this.store.apply(agent, id, exec)
  }
}

export default ProposalRuntime
