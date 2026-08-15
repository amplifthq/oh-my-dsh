/**
 * `/usage` reports authoritative token accounting already stored on assistant
 * message events. Monetary cost is intentionally omitted because dsh adapters
 * do not expose a provider-neutral pricing contract.
 * @module oh-my-dsh/usage
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'

export const name = 'omd-usage'
export const inject = ['commands']

export interface UsageSummary {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export function summarizeUsage(session: Session): UsageSummary {
  const summary: UsageSummary = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
  const usages = new Map<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
      reasoningTokens?: number
    }
  >()
  for (const event of session.events) {
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
      usages.set(`${event.data.turn}:${event.data.step}`, event.data.chunk.usage)
    } else if (event.type === 'assistant/message' && event.data.usage) {
      usages.set(`${event.data.turn}:${event.data.step}`, event.data.usage)
    }
  }
  for (const usage of usages.values()) {
    summary.calls += 1
    summary.inputTokens += usage.inputTokens
    summary.outputTokens += usage.outputTokens
    summary.cacheReadTokens += usage.cacheReadTokens ?? 0
    summary.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    summary.reasoningTokens += usage.reasoningTokens ?? 0
  }
  return summary
}

function number(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

export function renderUsage(summary: UsageSummary): string {
  return [
    `Model calls: ${number(summary.calls)}`,
    `Input tokens: ${number(summary.inputTokens)}`,
    `Output tokens: ${number(summary.outputTokens)}`,
    `Reasoning tokens: ${number(summary.reasoningTokens)}`,
    `Cache read: ${number(summary.cacheReadTokens)}`,
    `Cache write: ${number(summary.cacheWriteTokens)}`,
    'Estimated cost: unavailable (the active adapter does not expose provider-neutral pricing).',
  ].join('\n')
}

export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'usage',
    description: 'Show token usage for the current session.',
    recordInput: false,
    handler: ({ agent }) => ({
      kind: 'success',
      text: renderUsage(summarizeUsage(agent.session)),
    }),
  })
}
