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
}

export const Config: z<Config> = z.object({
  minRunMs: z.number().min(0).default(15_000),
  title: z.string().default('oh-my-dsh'),
  notifyApproval: z.boolean().default(true),
})

function sendNotification(title: string, body: string): void {
  let command: string
  let args: string[]
  if (process.platform === 'darwin') {
    command = 'osascript'
    // JSON.stringify produces escaping that AppleScript string literals accept.
    args = ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]
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
}
