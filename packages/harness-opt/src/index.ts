/**
 * Agent-facing opt_control: suggest, show.
 * @module oh-my-dsh/harness-opt
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { bundledTasksDir } from '../../harness-eval/src/index.js'
import type { EvalRoots } from '../../harness-eval/src/store.js'
import {
  OPT_CONTROL_DESCRIPTION,
  OPT_CONTROL_PARAMETERS,
  envelope,
  nextForSuggestion,
  parseOptControlRequest,
  type OptControlEnvelope,
  type OptPolicy,
  type OptSuggestion,
} from './contract.js'
import { listCreditableCompares, observeLegalCandidates } from './observe.js'
import {
  creditCompares,
  optPolicyPath,
  pickSuggestion,
  readPolicy,
  withLastSuggestion,
  writePolicy,
} from './policy.js'

export const name = 'omd-harness-opt'

declare module '@deepseek-ai/cordis' {
  interface Context {
    harnessOpt: HarnessOptRuntime
  }
}

export * from './contract.js'
export * from './observe.js'
export * from './policy.js'

export class HarnessOptRuntime extends Service {
  static inject = ['tools', 'commands', 'systemPrompt']

  constructor(ctx: Context) {
    super(ctx, 'harnessOpt')

    ctx.systemPrompt.section({
      name: 'omd:harness-opt',
      order: 114,
      text:
        'Call opt_control suggest to pick the next harness mutation from a durable policy. ' +
        'The reply is one arm and a next tool call — never an apply. ' +
        'Promote still needs eval_control compare mode=diff and mode=ablate. ' +
        'opt_control never writes source, skills, or presets/plugins.json.',
    })

    ctx.commands.register({
      name: 'omd-opt',
      description: 'Show the durable opt_control policy.',
      recordInput: false,
      handler: async () => {
        const dshHome = this.dshHome()
        const policy = await readPolicy(dshHome)
        const lines = [
          `policy ${optPolicyPath(dshHome)}`,
          ...Object.entries(policy.arms).map(
            ([arm, stats]) => `${arm} wins=${stats.wins} losses=${stats.losses}`,
          ),
          policy.last
            ? `last ${policy.last.arm}${policy.last.target ? ` ${policy.last.target}` : ''}`
            : 'last none',
        ]
        return { kind: 'success', text: lines.join('\n') }
      },
    })

    ctx.tools.register(
      defineTool({
        name: 'opt_control',
        description: OPT_CONTROL_DESCRIPTION,
        parameters: { ...OPT_CONTROL_PARAMETERS },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args, exec) => {
          const request = parseOptControlRequest(args)
          if (request.action === 'show') return JSON.stringify(await this.show(), null, 2)
          return JSON.stringify(await this.suggest(exec.agent), null, 2)
        },
      }),
    )
  }

  roots(agent?: Agent): EvalRoots {
    const dshHome = this.dshHome()
    const cwd = agent?.session.header.cwd
    const evalRuntime = this.ctx.get('harnessEval') as
      { roots(owner?: Agent): EvalRoots } | undefined
    if (evalRuntime) return evalRuntime.roots(agent)
    return {
      dshHome,
      workspace: cwd ? resolve(cwd) : undefined,
      bundledTasks: bundledTasksDir(),
    }
  }

  async suggest(agent?: Agent): Promise<OptControlEnvelope<SuggestData>> {
    const evalRoots = this.roots(agent)
    const policy = await readPolicy(evalRoots.dshHome)
    const credited = creditCompares(policy, await listCreditableCompares(evalRoots))
    const forge = this.ctx.get('pluginForge') as
      { list(owner: Agent): { id: string }[] } | undefined
    const activeSlugs = new Set(agent && forge ? forge.list(agent).map((view) => view.id) : [])
    const picked = pickSuggestion(
      credited.policy,
      await observeLegalCandidates({
        dshHome: evalRoots.dshHome,
        workspace: evalRoots.workspace,
        bundledTasks: evalRoots.bundledTasks,
        activeSlugs,
      }),
    )
    const suggestion: OptSuggestion = { ...picked, next: nextForSuggestion(picked) }
    const nextPolicy = withLastSuggestion(credited.policy, suggestion)
    await writePolicy(evalRoots.dshHome, nextPolicy)
    return envelope(
      'suggest',
      {
        arm: suggestion.arm,
        ...(suggestion.target ? { target: suggestion.target } : {}),
        ...(suggestion.query ? { query: suggestion.query } : {}),
        ...(suggestion.scope ? { scope: suggestion.scope } : {}),
        credited: credited.credited,
        arms: nextPolicy.arms,
      },
      {
        refs: suggestion.target ? [suggestion.target] : [],
        files: [policyPointer(evalRoots.dshHome)],
        next: suggestion.next,
      },
    )
  }

  async show(): Promise<OptControlEnvelope<{ policy: OptPolicy }>> {
    const dshHome = this.dshHome()
    const policy = await readPolicy(dshHome)
    return envelope(
      'show',
      { policy },
      {
        refs: ['policy:v1'],
        files: [policyPointer(dshHome)],
        next: [
          {
            tool: 'opt_control',
            action: 'suggest',
            instruction: 'Pick the next arm from this policy. Do not apply from show.',
          },
        ],
      },
    )
  }

  private dshHome(): string {
    return resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
  }
}

interface SuggestData {
  arm: OptSuggestion['arm']
  target?: string
  query?: string
  scope?: 'user' | 'project'
  credited: number
  arms: OptPolicy['arms']
}

function policyPointer(dshHome: string) {
  return { kind: 'policy' as const, ref: 'policy:v1', path: optPolicyPath(dshHome) }
}

export function apply(ctx: Context): void {
  new HarnessOptRuntime(ctx)
}

export default HarnessOptRuntime
