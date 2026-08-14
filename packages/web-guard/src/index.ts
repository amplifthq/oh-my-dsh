/**
 * Safe-by-default web retrieval for oh-my-dsh. Registers an SSRF-hardened
 * fetch provider with `ctx.web` (private networks blocked at URL validation
 * AND at connect time), and — when the web_fetch tool is disabled — turns the
 * model's silent `curl`/`wget` degradation for public URLs into an explicit
 * approval prompt instead of an invisible bypass.
 * @module @oh-my-dsh/web-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { SafeFetchProvider } from './provider.js'
import { assessFetchCommand } from './guard.js'

export {
  SAFE_FETCH_PROVIDER_ID,
  SafeFetchProvider,
  classifyContentType,
  parseCharset,
  validateFetchUrl,
  guardedLookup,
} from './provider.js'
export type { SafeFetchLimits } from './provider.js'
export { assessFetchCommand, commandWords, extractUrls } from './guard.js'
export type { FetchCommandAssessment } from './guard.js'
export { expandIpv6, isForbiddenAddress, isPrivateHost } from './address.js'

/** Default `User-Agent`: an explicit product agent, never a browser disguise. */
export const DEFAULT_USER_AGENT = 'oh-my-dsh (+https://github.com/amplifthq/oh-my-dsh)'

export const name = 'omd-web-guard'
export const inject = ['web', 'systemPrompt']

export interface Config {
  /** Maximum accepted request URL length. */
  maxUrlLength?: number
  /** Maximum response body size in bytes. */
  maxResponseBytes?: number
  /** Maximum decoded body length in characters. */
  maxBodyChars?: number
  /** Default fetch timeout in milliseconds. */
  timeoutMs?: number
  /** Maximum number of same-origin redirect hops to follow. */
  maxRedirects?: number
  /** `User-Agent` header sent on every request. */
  userAgent?: string
  /** Permit private/reserved destinations (internal doc hosts). Default off. */
  allowPrivateNetwork?: boolean
  /** Intercept shell fetches of public URLs with an approval prompt (set when web_fetch is disabled). */
  guardShellFetch?: boolean
}

export const Config: z<Config> = z.object({
  maxUrlLength: z.number().min(1).default(2048),
  maxResponseBytes: z.number().min(1).default(5_000_000),
  maxBodyChars: z.number().min(1).default(100_000),
  timeoutMs: z.number().min(1).max(2_147_483_647).default(30_000),
  maxRedirects: z.number().min(0).default(5),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  allowPrivateNetwork: z.boolean().default(false),
  guardShellFetch: z.boolean().default(false),
})

export function apply(ctx: Context, config: Config): void {
  const provider = new SafeFetchProvider({
    maxUrlLength: config.maxUrlLength ?? 2048,
    maxResponseBytes: config.maxResponseBytes ?? 5_000_000,
    maxBodyChars: config.maxBodyChars ?? 100_000,
    timeoutMs: config.timeoutMs ?? 30_000,
    maxRedirects: config.maxRedirects ?? 5,
    userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
    allowPrivateNetwork: config.allowPrivateNetwork ?? false,
  })
  ctx.web.registerFetchProvider(provider)
  ctx.effect(() => () => provider.dispose())

  ctx.systemPrompt.section({
    name: 'omd:web-guard',
    order: 115,
    text: config.allowPrivateNetwork
      ? 'Prefer the web_fetch tool over shell curl/wget for retrieving web pages.'
      : 'Prefer the web_fetch tool over shell curl/wget for retrieving public web pages. '
        + 'web_fetch blocks private and internal network destinations by design; use shell '
        + 'tools for localhost and in-workspace services.',
  })

  if (config.guardShellFetch === true) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== 'bash') return next()
      const args = exec.arguments as { command?: unknown } | null
      const command = typeof args?.command === 'string' ? args.command : undefined
      if (command === undefined) return next()
      const assessment = assessFetchCommand(command)
      if (!assessment.usesFetcher || assessment.publicUrls.length === 0) return next()
      const listed = assessment.publicUrls.slice(0, 3).join(', ')
      return {
        kind: 'ask',
        reason: `Shell fetch of a public URL while the web_fetch tool is disabled: ${listed}. `
          + 'Approve once, or re-enable web fetch (unset OMD_DISABLE_WEB_FETCH) for guarded retrieval.',
      }
    })
  }
}
