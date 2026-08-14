/**
 * First-run workspace registration. The dsh web UI opens on a workspace
 * picker that starts empty; users who just ran `omd web` from their project
 * directory face a "Choose workspace" hurdle before the first prompt. This
 * plugin registers the launch directory as a workspace at startup —
 * `WorkspaceRegistry.create` is idempotent per canonical path and prepends
 * new records, so the launch directory appears first in the picker. Homes and
 * filesystem roots are skipped: launching from `~` is not a workspace intent.
 * @module @oh-my-dsh/workspace
 */

import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-workspace'

export const name = 'omd-workspace'
export const inject = ['workspaceRegistry']

export interface Config {
  /** Directory to register (defaults to the process working directory). */
  root?: string
}

export const Config: z<Config> = z.object({
  root: z.string(),
})

/** Whether a directory is a plausible workspace rather than a home or root. */
export function isRegistrableRoot(root: string, home: string): boolean {
  const canonical = resolve(root)
  if (canonical === resolve(home)) return false
  if (dirname(canonical) === canonical) return false // filesystem root
  return true
}

export function apply(ctx: Context, config: Config = {}): void {
  const root = resolve(config.root ?? process.cwd())
  if (!isRegistrableRoot(root, homedir())) return
  void ctx.workspaceRegistry.create(root, basename(root)).catch(() => {
    // Nonexistent or non-directory path; the picker simply stays manual.
  })
}
