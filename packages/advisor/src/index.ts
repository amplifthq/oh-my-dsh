/**
 * Optional independent reviewer. After each completed top-level turn, a second
 * model reviews the bounded transcript and injects only actionable concerns
 * into the next step; it never wakes the agent or creates a self-running loop.
 * @module oh-my-dsh/advisor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'omd-advisor'
export const inject = ['llm']

export interface Config {
  enabled?: boolean
  provider: string
  model: string
  maxInputBytes?: number
  maxTokens?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  provider: z.string().default(''),
  model: z.string().default(''),
  maxInputBytes: z.number().min(4096).default(48_000),
  maxTokens: z.number().min(64).default(800),
})

function blockText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .filter((block): block is { type: string; text: string } => typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

export function transcriptForReview(agent: Agent, maxBytes: number): string {
  const entries: string[] = []
  for (const event of agent.session.events) {
    if (event.type === 'user/message') {
      entries.push(`USER:\n${blockText(event.data.content)}`)
    } else if (event.type === 'assistant/message') {
      entries.push(`ASSISTANT:\n${blockText(event.data.message.content)}`)
    } else if (event.type === 'tool/call') {
      entries.push(`TOOL CALL ${event.data.name}:\n${event.data.arguments}`)
    } else if (event.type === 'tool/result') {
      entries.push(`TOOL RESULT:\n${blockText(event.data.message.content)}`)
    }
  }
  const selected: string[] = []
  let bytes = 0
  for (const entry of entries.reverse()) {
    const size = Buffer.byteLength(entry)
    if (bytes + size > maxBytes) break
    selected.push(entry)
    bytes += size
  }
  return selected.reverse().join('\n\n')
}

async function review(
  ctx: Context,
  agent: Agent,
  config: Config,
  signal: AbortSignal,
): Promise<string> {
  const transcript = transcriptForReview(agent, config.maxInputBytes ?? 48_000)
  if (!transcript) return ''
  const prompt = createUserMessage({
    content: [
      {
        type: 'text',
        text: [
          'Review the completed coding-agent turn below as an independent senior engineer.',
          'Look only for concrete correctness, safety, requirement, or verification problems.',
          'Return exactly OK if there is no actionable issue.',
          'Otherwise return one short line beginning ASIDE:, CONCERN:, or BLOCKER:, followed by the issue and the next action.',
          'Do not praise, summarize, or speculate.',
          '',
          transcript,
        ].join('\n'),
      },
    ],
    source: { kind: 'plugin', plugin: name },
  })
  let output = ''
  for await (const chunk of ctx.llm.stream({
    provider: config.provider,
    model: config.model,
    messages: [prompt],
    system: 'You are a terse, evidence-driven code reviewer.',
    maxTokens: config.maxTokens ?? 800,
    signal,
  })) {
    if (chunk.type === 'text-delta') output += chunk.text
  }
  return output.trim()
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!config.provider.trim() || !config.model.trim()) {
    throw new Error('omd-advisor: enabled requires provider and model')
  }

  const reviewedSeq = new WeakMap<Agent, number>()
  const reviewing = new WeakSet<Agent>()

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || agent.session.header.delegationDepth) return
    const last = reviewedSeq.get(agent) ?? agent.session.firstLiveSeq
    if (agent.session.seq <= last || reviewing.has(agent)) return
    const hasAssistant = agent.session.events
      .slice(last)
      .some((event) => event.type === 'assistant/message')
    reviewedSeq.set(agent, agent.session.seq)
    if (!hasAssistant) return

    reviewing.add(agent)
    queueMicrotask(() => {
      if (agent.status !== 'idle') {
        reviewing.delete(agent)
        return
      }
      void agent
        .runMaintenance(async (signal) => {
          const note = await review(ctx, agent, config, signal)
          if (!note || /^OK[.!]?$/i.test(note)) return
          agent.inject(
            createUserMessage({
              content: [
                {
                  type: 'text',
                  text: `<advisor-note>\n${note}\nAddress this on the next relevant step or explain why it does not apply.\n</advisor-note>`,
                },
              ],
              source: {
                kind: 'plugin',
                plugin: name,
                form: 'notice',
                summary: note.slice(0, 120),
              },
            }),
          )
        })
        .catch(() => {
          // Advisory review is non-authoritative; a provider failure must not
          // fail or wake the primary agent.
        })
        .finally(() => reviewing.delete(agent))
    })
  })
}
