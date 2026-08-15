/**
 * Desktop notification when an agent turn finishes. Long agent turns invite
 * tab-switching; this pings the user when the agent goes idle again after
 * running for at least `minRunMs`. macOS (osascript) and Linux (notify-send)
 * are supported; other platforms are a silent no-op.
 * @module @oh-my-dsh/notify
 */

import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'

export const name = 'omd-notify'
export const inject = ['approval']

export interface Config {
  /** Minimum time an agent must have been running before idle triggers a notification (default 15s). */
  minRunMs?: number
  /** Notification title (default "oh-my-dsh"). */
  title?: string
  /** Notify immediately when a tool is waiting for approval. */
  notifyApproval?: boolean
  /** Notify when user input sits queued behind a running turn. */
  notifyQueued?: boolean
  /** How long queued input must wait unclaimed before notifying (default 3s). */
  queuedAfterMs?: number
}

export const Config: z<Config> = z.object({
  minRunMs: z.number().min(0).default(15_000),
  title: z.string().default('oh-my-dsh'),
  notifyApproval: z.boolean().default(true),
  notifyQueued: z.boolean().default(true),
  queuedAfterMs: z.number().min(0).default(3_000),
})

function sendNotification(title: string, body: string): void {
  let command: string
  let args: string[]
  if (process.platform === 'darwin') {
    command = 'osascript'
    // JSON.stringify produces escaping that AppleScript string literals accept.
    args = [
      '-e',
      `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`,
    ]
  } else if (process.platform === 'linux') {
    command = 'notify-send'
    args = [title, body]
  } else {
    return
  }
  spawn(command, args, { stdio: 'ignore' }).on('error', () => {
    // Notifier binary missing; notifications are best-effort.
  })
}

export function apply(ctx: Context, config: Config) {
  const minRunMs = config.minRunMs ?? 15_000
  const title = config.title ?? 'oh-my-dsh'
  const runningSince = new Map<object, number>()

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') {
      if (!runningSince.has(agent)) runningSince.set(agent, Date.now())
      return
    }
    const startedAt = runningSince.get(agent)
    runningSince.delete(agent)
    if (startedAt === undefined) return
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs < minRunMs) return
    sendNotification(title, `Agent finished after ${Math.round(elapsedMs / 1000)}s`)
  })

  if (config.notifyApproval !== false) {
    ctx.on('approval/request', async (request, next) => {
      const reason = request.reason ? `: ${request.reason.slice(0, 120)}` : ''
      sendNotification(title, `Approval needed for ${request.toolName}${reason}`)
      return next()
    })
  }

  // A message inserted while the agent is mid-turn waits for the next step;
  // without feedback users assume it was ignored. Notify only if it stays
  // unclaimed past the delay, so instant pickups (idle agent, fast steps)
  // produce no noise.
  if (config.notifyQueued !== false) {
    const queuedAfterMs = config.queuedAfterMs ?? 3_000
    const pending = new Map<object, ReturnType<typeof setTimeout>>()
    const cancel = (message: object): void => {
      const timer = pending.get(message)
      if (timer === undefined) return
      clearTimeout(timer)
      pending.delete(message)
    }
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (message.source.kind !== 'user') return
      if (!runningSince.has(agent)) return
      const block = message.content.find((item) => item.type === 'text')
      const raw = block?.type === 'text' ? block.text.trim() : ''
      const snippet = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw
      const timer = setTimeout(() => {
        pending.delete(message)
        sendNotification(
          title,
          snippet.length > 0
            ? `Input queued: "${snippet}" — delivered at the next model step.`
            : 'Input queued — delivered at the next model step.',
        )
      }, queuedAfterMs)
      timer.unref?.()
      pending.set(message, timer)
    })
    ctx.on('agent/inbox/claimed', ({ message }) => cancel(message))
    ctx.on('agent/inbox/discarded', ({ message }) => cancel(message))
    ctx.effect(() => () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    })
  }
}
