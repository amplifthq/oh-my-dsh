/**
 * Agent-facing eval_control: snapshot, run, compare, show.
 * @module oh-my-dsh/harness-eval
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { capabilityRef } from '../../capability-discovery/src/catalog.js'
import { readForgedPlugin, resolveForgedPluginTarget } from '../../plugin-forge/src/store.js'
import {
  EVAL_CONTROL_DESCRIPTION,
  EVAL_CONTROL_PARAMETERS,
  compareScores,
  conditionDigest,
  envelope,
  evalCanonical,
  evalSha256Hex,
  nextAfterCompare,
  nextAfterSnapshot,
  nextMissingAblatePair,
  parseEvalControlRequest,
  type CompareResult,
  type Intervention,
} from './contract.js'
import {
  assertDistillJustified as requireDistillCompare,
  assertPromotionAllowed as requirePromotionCompares,
} from './gate.js'
import { interpretRun } from './interpret.js'
import { buildOverlay } from './overlay.js'
import { captureFromAgent, readOptionalFile, readSkillBytes } from './snapshot.js'
import {
  bundledSuiteDigest,
  grepEvalStore,
  listRuns,
  listTasks,
  readRun,
  readSnapshot,
  resolveTask,
  showArtifact,
  writeCompare,
  writeRun,
  type EvalRoots,
} from './store.js'

export const name = 'omd-harness-eval'

declare module '@deepseek-ai/cordis' {
  interface Context {
    harnessEval: HarnessEvalRuntime
  }
}

export * from './contract.js'
export * from './gate.js'
export * from './task.js'

export function bundledTasksDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return resolve(here, '../../../../packages/harness-eval/tasks')
}

function requireAgent(exec: { agent?: Agent }): Agent {
  if (!exec.agent) throw new Error('eval_control requires an active agent session')
  return exec.agent
}

export class HarnessEvalRuntime extends Service {
  static inject = ['tools', 'commands', 'systemPrompt']

  constructor(ctx: Context) {
    super(ctx, 'harnessEval')

    ctx.systemPrompt.section({
      name: 'omd:harness-eval',
      order: 113,
      text:
        'Before claiming a skill or forged plugin helped, call eval_control snapshot, then run, ' +
        'then compare. run requires snapshot_digest. Read evidence with eval_control show; ' +
        'do not treat assistant text as a score. plugin_forge prepare_promote needs compare ' +
        'mode=diff (no regress) and mode=ablate (faithful). Updating a skill with ' +
        'skill_control prepare_save needs a faithful ablate. eval_control never applies ' +
        'proposals or writes the catalog.',
    })

    ctx.commands.register({
      name: 'omd-eval',
      description: 'List frozen eval tasks and recent runs.',
      recordInput: false,
      handler: async ({ agent }) => {
        const roots = this.roots(agent as Agent | undefined)
        const tasks = await listTasks(roots)
        const runs = await listRuns(roots)
        const text = [
          tasks.length
            ? tasks.map((task) => `${task.id} — ${task.summary}`).join('\n')
            : 'No eval tasks.',
          runs.length
            ? runs
                .slice(-10)
                .map((run) => `${run.run_id} ${run.task_id} pass=${run.pass}`)
                .join('\n')
            : '',
        ]
          .filter(Boolean)
          .join('\n\n')
        return { kind: 'success', text }
      },
    })

    ctx.tools.register(
      defineTool({
        name: 'eval_control',
        description: EVAL_CONTROL_DESCRIPTION,
        parameters: { ...EVAL_CONTROL_PARAMETERS },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args, exec) => {
          const request = parseEvalControlRequest(args)
          const agent = request.action === 'snapshot' ? requireAgent(exec) : exec.agent
          const roots = this.roots(agent)
          if (request.action === 'snapshot') {
            const digest = await this.capture(requireAgent(exec), roots)
            return JSON.stringify(
              envelope(
                'snapshot',
                { snapshot_digest: digest },
                {
                  refs: [`snapshot:${digest}`],
                  next: nextAfterSnapshot(digest),
                },
              ),
              null,
              2,
            )
          }
          if (request.action === 'run')
            return JSON.stringify(await this.run(roots, request), null, 2)
          if (request.action === 'compare') {
            return JSON.stringify(await this.compare(roots, request), null, 2)
          }
          return JSON.stringify(await this.show(roots, request), null, 2)
        },
      }),
    )
  }

  roots(agent?: Agent): EvalRoots {
    const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
    const cwd = agent?.session.header.cwd
    return {
      dshHome,
      workspace: cwd ? resolve(cwd) : undefined,
      bundledTasks: bundledTasksDir(),
    }
  }

  async assertPromotionAllowed(roots: EvalRoots, pluginRef: string) {
    return requirePromotionCompares(roots, pluginRef)
  }

  async assertDistillJustified(roots: EvalRoots, skillRef: string) {
    return requireDistillCompare(roots, skillRef)
  }

  private async capture(agent: Agent, roots: EvalRoots): Promise<string> {
    const { digest } = await captureFromAgent(roots, {
      listSkills: async () => {
        const skills: { name: string; bytes?: Buffer }[] = []
        try {
          const snap = await this.ctx.get('skills')?.snapshot({
            scope: agent,
            cwd: agent.session.header.cwd,
          })
          for (const skill of snap?.skills ?? []) {
            skills.push({ name: skill.name, bytes: await readSkillBytes(roots, skill.name) })
          }
        } catch {
          // Skills are optional on a snapshot; plugins still score.
        }
        return skills
      },
      listPlugins: async () => {
        const plugins: { ref: string; bytes?: Buffer; revision?: number; version?: string }[] = []
        const forged = (await this.ctx.get('pluginForge')?.listForDiscovery(agent)) ?? []
        for (const view of forged) {
          const target = resolveForgedPluginTarget(view.scope, view.slug, {
            dshHome: roots.dshHome,
            workspace: roots.workspace,
          })
          const state = await readForgedPlugin(target)
          plugins.push({
            ref: capabilityRef('plugin', `forged/${view.scope}/${view.slug}`),
            bytes: state?.source ? Buffer.from(state.source) : undefined,
            revision: view.revision,
          })
        }
        for (const organ of this.ctx.get('pluginControl')?.list(agent) ?? []) {
          plugins.push({
            ref: capabilityRef('plugin', organ.id),
            version: organ.version,
          })
        }
        return plugins
      },
      readPatch: async () => {
        if (!roots.workspace) return null
        return (await readOptionalFile(join(roots.workspace, 'cordis.patch.yml'))) ?? null
      },
    })
    return digest
  }

  private async run(
    roots: EvalRoots,
    request: { task_id: string; snapshot_digest: string; intervention: Intervention | null },
  ) {
    const started = Date.now()
    const snapshot = await readSnapshot(roots, request.snapshot_digest)
    if (!snapshot || !snapshot.digestMatches) {
      throw new Error(`unknown or drifted snapshot ${request.snapshot_digest}`)
    }
    const task = await resolveTask(roots, request.task_id)
    if (!task) throw new Error(`unknown eval task "${request.task_id}"`)
    const suite = await bundledSuiteDigest(roots)
    const overlay = await buildOverlay({
      snapshot,
      intervention: request.intervention,
      fixtureDir: task.document.fixture ? join(task.dir, task.document.fixture) : undefined,
      taskDir: task.dir,
    })
    try {
      const interpreted = await interpretRun({
        task: task.document,
        overlay,
        snapshot,
        suite_digest: suite,
        intervention: request.intervention,
      })
      interpreted.score.duration_ms = Date.now() - started
      const { run_id } = await writeRun(roots, {
        task_id: request.task_id,
        snapshot_digest: request.snapshot_digest,
        suite_digest: suite,
        intervention: request.intervention,
        score: interpreted.score,
        tree: interpreted.tree,
        traces: interpreted.traces,
        meta: { task_id: request.task_id, snapshot_digest: request.snapshot_digest },
      })
      return envelope(
        'run',
        {
          run_id,
          task_id: request.task_id,
          snapshot_digest: request.snapshot_digest,
          condition_digest: conditionDigest(request.snapshot_digest, request.intervention),
          pass: interpreted.score.pass,
          intervention: request.intervention,
        },
        {
          refs: [`run:${run_id}`, `task:${request.task_id}`, `snapshot:${request.snapshot_digest}`],
          next: request.intervention
            ? [
                {
                  tool: 'eval_control',
                  action: 'compare',
                  args: {
                    mode: 'ablate',
                    task_id: request.task_id,
                    snapshot_digest: request.snapshot_digest,
                    intervention: request.intervention,
                  },
                  instruction: 'After the intact run exists, compare mode=ablate.',
                },
              ]
            : [
                {
                  tool: 'eval_control',
                  action: 'show',
                  args: { ref: `run:${run_id}/score` },
                  instruction: 'Read the machine score. Do not use assistant text as a score.',
                },
              ],
        },
      )
    } finally {
      await overlay.dispose()
    }
  }

  private async compare(
    roots: EvalRoots,
    request:
      | { mode: 'diff'; task_id: string; baseline: string; candidate: string }
      | { mode: 'ablate'; task_id: string; snapshot_digest: string; intervention: Intervention },
  ) {
    if (request.mode === 'ablate') {
      const runs = await listRuns(roots, {
        task_id: request.task_id,
        snapshot_digest: request.snapshot_digest,
      })
      const intact = [...runs].reverse().find((run) => run.intervention === null)
      const ablated = [...runs]
        .reverse()
        .find(
          (run) =>
            run.intervention?.op === 'ablate' &&
            run.intervention.target === request.intervention.target,
        )
      if (!intact || !ablated) {
        return envelope(
          'compare',
          { status: 'needs_runs', mode: 'ablate' },
          {
            refs: [`task:${request.task_id}`, `snapshot:${request.snapshot_digest}`],
            next: nextMissingAblatePair(
              request.task_id,
              request.snapshot_digest,
              request.intervention.target,
            ),
          },
        )
      }
      const result = compareScores({
        mode: 'ablate',
        baseline: intact,
        candidate: ablated,
        target: request.intervention.target,
      })
      await persistCompare(roots, result)
      return envelope('compare', result, {
        refs: [result.baseline_ref, result.candidate_ref],
        next: nextAfterCompare(result),
      })
    }
    const baseline = await readRun(roots, request.baseline)
    const candidate = await readRun(roots, request.candidate)
    if (!baseline || !candidate) throw new Error('compare mode=diff requires two existing run ids')
    if (baseline.score.task_id !== request.task_id || candidate.score.task_id !== request.task_id) {
      throw new Error('compare mode=diff run ids must belong to task_id')
    }
    const result = compareScores({
      mode: 'diff',
      baseline: baseline.score,
      candidate: candidate.score,
    })
    await persistCompare(roots, result)
    return envelope('compare', result, {
      refs: [result.baseline_ref, result.candidate_ref],
      next: nextAfterCompare(result),
    })
  }

  private async show(
    roots: EvalRoots,
    request: {
      artifact?: { kind: string; id: string; file?: string; ref: string }
      query?: string
      in: 'tasks' | 'snapshots' | 'scores' | 'traces' | 'assertions' | 'all'
      max_bytes: number
      task_id?: string
      snapshot_digest?: string
    },
  ) {
    if (request.query) {
      const hits = await grepEvalStore(roots, request.query, request.in)
      return envelope('show', { hits }, { refs: hits.map((hit) => hit.ref) })
    }
    if (!request.artifact || request.artifact.kind === 'index') {
      const id = request.artifact?.id ?? 'tasks'
      if (id === 'runs') {
        const runs = await listRuns(roots, {
          task_id: request.task_id,
          snapshot_digest: request.snapshot_digest,
        })
        return envelope('show', { runs }, { refs: runs.map((run) => `run:${run.run_id}`) })
      }
      const tasks = await listTasks(roots)
      return envelope('show', {
        tasks: tasks.map((task) => ({ id: task.id, summary: task.summary, suite: task.suite })),
      })
    }
    const shown = await showArtifact(roots, request.artifact as never, request.max_bytes)
    return envelope(
      'show',
      { content: shown.content, truncated: shown.truncated },
      {
        refs: [request.artifact.ref],
        files: [{ kind: 'index', ref: request.artifact.ref, path: shown.path }],
      },
    )
  }
}

async function persistCompare(roots: EvalRoots, result: CompareResult): Promise<void> {
  const digest = evalSha256Hex(evalCanonical(result))
  await writeCompare(roots, digest, result)
}

export function apply(ctx: Context): void {
  new HarnessEvalRuntime(ctx)
}

export default HarnessEvalRuntime
