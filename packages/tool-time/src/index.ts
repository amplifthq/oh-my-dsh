/**
 * Model-facing `time_now` tool. The stock dsh composition has no way for the
 * model to learn the wall-clock time; this closes that gap with zero
 * dependencies beyond the tool registry.
 * @module @oh-my-dsh/tool-time
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'omd-tool-time'
export const inject = ['tools']

function hostTimezone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone
}

function formatHuman(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(date)
}

/** ISO 8601 with the target zone's UTC offset rather than `Z`. */
function formatIso(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'longOffset',
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const rawOffset = get('timeZoneName') // e.g. "GMT+08:00" or "GMT"
  const offset = rawOffset === 'GMT' ? '+00:00' : rawOffset.replace('GMT', '')
  const hour = get('hour') === '24' ? '00' : get('hour')
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}${offset}`
}

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'time_now',
    description:
      'Get the current date and time. Use this whenever the current date, '
      + 'time, weekday, or timezone matters; do not guess from prior context.',
    parameters: {
      timezone: {
        type: 'string',
        description: 'IANA timezone such as "Asia/Shanghai" or "UTC". Defaults to the host timezone.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          iso: { type: 'string', required: true },
          unix: { type: 'integer', required: true },
          timezone: { type: 'string', required: true },
          human: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.human} — ${value.iso} (${value.timezone})`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const timezone = args.timezone ?? hostTimezone()
      try {
        // Throws RangeError for unknown zones before we do any formatting.
        new Intl.DateTimeFormat('en-US', { timeZone: timezone })
      } catch {
        throw new Error(`unknown timezone: ${timezone}`)
      }
      const now = new Date()
      return {
        iso: formatIso(now, timezone),
        unix: Math.floor(now.getTime() / 1000),
        timezone,
        human: formatHuman(now, timezone),
      }
    },
  }))
}
