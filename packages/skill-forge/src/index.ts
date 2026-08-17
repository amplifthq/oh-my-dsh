import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {
  ProposalCommitResult,
  ProposalEffect,
  ProposalRuntime,
} from '../../proposals/src/index.ts'
import {
  planSkillWrite,
  renderSkillMarkdown,
  validateSkillInput,
  type SkillDocument,
  type SkillWritePlan,
} from './document.js'
import {
  commitSkillWrite,
  readExistingSkill,
  resolveSkillTarget,
  type SkillRoots,
  type SkillScope,
  type SkillTarget,
} from './store.js'

export const name = 'omd-skill-forge'

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillForge: SkillForgeRuntime
    proposals: ProposalRuntime
  }
}

export * from './document.js'
export * from './store.js'

export interface PrepareSaveArgs {
  scope: SkillScope
  name: string
  description: string
  when_to_use?: string
  body: string
}

export interface SkillSavePlan {
  document: SkillDocument
  target: SkillTarget
  plan: SkillWritePlan
  /** Digest the commit re-checks; undefined means the file must still be absent. */
  expectedDigest?: string
  title: string
  summary: string
  effects: ProposalEffect[]
}

/**
 * Validate the tool arguments and stage everything an approval needs to be
 * exact: the rendered after-content, the current before-content, and the
 * digest the commit will re-verify.
 */
export async function planSkillSave(
  args: PrepareSaveArgs,
  roots: SkillRoots,
): Promise<SkillSavePlan> {
  const document = validateSkillInput({
    slug: args.name,
    description: args.description,
    whenToUse: args.when_to_use,
    body: args.body,
  })
  const target = resolveSkillTarget(args.scope, document.slug, roots)
  const existing = await readExistingSkill(target.path)
  if (existing && existing.content === renderSkillMarkdown(document)) {
    throw new Error(
      `skill "${document.slug}" is already saved with identical content at ${target.path}`,
    )
  }
  const plan = planSkillWrite(document, existing?.content)
  const verb = plan.action === 'create' ? 'Create' : 'Update'
  return {
    document,
    target,
    plan,
    expectedDigest: existing?.digest,
    title: `Save skill "${document.slug}" (${target.scope} scope)`,
    summary:
      `${verb} ${target.path} after explicit approval. ` +
      'The upstream skill watcher picks the file up live; no restart is needed.',
    effects: [
      {
        type: 'skill-write',
        target: target.path,
        summary:
          `${verb} ${target.scope}-scope skill "${document.slug}"` +
          (plan.warnings.length ? ` — ${plan.warnings.length} content warning(s)` : ''),
        details: {
          scope: target.scope,
          slug: document.slug,
          action: plan.action,
          path: target.path,
          warnings: plan.warnings,
          before: plan.before ?? null,
          after: plan.after,
          expectedDigest: expectedDigestOf(existing?.digest),
        },
      },
    ],
  }
}

function expectedDigestOf(digest: string | undefined): string | null {
  return digest ?? null
}

/** The proposal commit: containment-checked, stale-guarded, atomic write. */
export function skillSaveCommit(saved: SkillSavePlan): () => Promise<ProposalCommitResult> {
  return async () => {
    await commitSkillWrite(saved.target, saved.plan, saved.expectedDigest)
    return {
      summary: `Saved skill "${saved.document.slug}" to ${saved.target.path}.`,
      details: {
        scope: saved.target.scope,
        slug: saved.document.slug,
        action: saved.plan.action,
        path: saved.target.path,
        warnings: saved.plan.warnings,
      },
    }
  }
}

export function distillInstruction(focus: string): string {
  return [
    '<omd-distill>',
    focus ? `Focus: ${focus}` : 'Focus: the most recently verified procedure in this session.',
    '',
    'Distill one procedure from this session that you actually executed and verified into a reusable skill:',
    '1. Pick a procedure that will repeat in future sessions; skip narrative that only describes this one.',
    '2. Draft a lowercase slug, a single-line description, an optional whenToUse trigger, and a body of numbered, verifiable steps with the exact commands and checks that proved success. Strip session-specific paths and every secret.',
    '3. Call skill_control prepare_save with scope "project" when the procedure is specific to this repository, otherwise scope "user".',
    '4. Report the proposal id and any content warnings, then stop: the file is written only when the user approves proposal_control apply.',
    'If nothing in this session was verified well enough to distill, say so instead of inventing a skill.',
    '</omd-distill>',
  ].join('\n')
}

function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new Error('skill_control requires an active agent session')
  return exec.agent
}

export class SkillForgeRuntime extends Service {
  static inject = ['tools', 'proposals', 'commands', 'systemPrompt']

  private readonly lifecycle = new AbortController()

  constructor(ctx: Context) {
    super(ctx, 'skillForge')

    ctx.effect(
      () => () => this.lifecycle.abort(new Error('omd-skill-forge unloaded')),
      'omd-skill-forge.lifecycle',
    )

    ctx.systemPrompt.section({
      name: 'omd:skill-forge',
      order: 110,
      text:
        'When a non-trivial task ends with a verified, repeatable procedure, offer to distill it: ' +
        'draft the steps and call skill_control prepare_save (scope "project" for repo-specific ' +
        'procedures, "user" otherwise). The skill is written only when the user approves ' +
        'proposal_control apply — never claim a skill was saved before an approved apply reports success.',
    })

    ctx.commands.register({
      name: 'omd-distill',
      description: 'Distill a verified procedure from this session into a durable, reusable skill.',
      input: { hint: 'optional focus, e.g. the release steps we just verified' },
      handler: ({ agent, rawInput }) => {
        agent.followup(
          createUserMessage({
            content: [{ type: 'text', text: distillInstruction(rawInput.trim()) }],
            source: { kind: 'plugin', plugin: name, form: 'instructions' },
          }),
        )
        return {
          kind: 'success',
          text: 'Queued a distillation turn. The agent will draft the skill and file a proposal; nothing is saved without your approval.',
        }
      },
    })

    ctx.tools.register(
      defineTool({
        name: 'skill_control',
        description:
          'Distill a session-verified procedure into a durable SKILL.md via an approval-gated proposal. prepare_save returns a proposal with the exact file content; only proposal_control apply writes it.',
        parameters: {
          action: {
            type: 'string',
            required: true,
            enum: ['prepare_save'],
            description: 'Skill operation to prepare.',
          },
          scope: {
            type: 'string',
            required: true,
            enum: ['user', 'project'],
            description:
              'user → $DSH_HOME/skills (available in every project); project → <workspace>/.dsh/skills (this repository only).',
          },
          name: {
            type: 'string',
            required: true,
            description:
              'Skill slug: lowercase letters, digits, and hyphens, at most 41 characters.',
          },
          description: {
            type: 'string',
            required: true,
            description: 'Single-line description of what the skill does (at most 500 characters).',
          },
          when_to_use: {
            type: 'string',
            description: 'Optional single-line trigger hint (at most 500 characters).',
          },
          body: {
            type: 'string',
            required: true,
            description:
              'Markdown body: numbered, verifiable steps with exact commands and checks (at most 32 KiB). No secrets.',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args, exec) => {
          const agent = requireAgent(exec)
          const saved = await planSkillSave(
            {
              scope: args.scope as SkillScope,
              name: args.name,
              description: args.description,
              when_to_use: args.when_to_use,
              body: args.body,
            },
            this.roots(agent),
          )
          const proposal = ctx.proposals.create(agent, {
            kind: 'skill-write',
            title: saved.title,
            summary: saved.summary,
            effects: saved.effects,
            signal: this.lifecycle.signal,
            commit: skillSaveCommit(saved),
          })
          return JSON.stringify({ proposal, warnings: saved.plan.warnings }, null, 2)
        },
      }),
    )
  }

  private roots(agent: Agent): SkillRoots {
    const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
    const headerCwd = agent.session.header.cwd
    return { dshHome, workspace: headerCwd ? resolve(headerCwd) : undefined }
  }
}

export default SkillForgeRuntime
