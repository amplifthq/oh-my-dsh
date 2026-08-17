/**
 * SSRF-hardened HTTP(S) fetch provider for `ctx.web`. Mirrors the upstream
 * `@deepseek-ai/dsh-web-fetch-http` transport contract (same-origin redirects,
 * byte/char caps, charset-aware decoding) and adds the private-network
 * protection upstream explicitly defers: IP-literal and local-name hosts are
 * rejected before any request, and every DNS resolution is validated at
 * connect time through a guarded lookup, so redirects and DNS rebinding cannot
 * reach loopback, RFC1918, link-local, or cloud-metadata addresses.
 * @module @oh-my-dsh/web-guard/provider
 */

import { lookup as dnsLookup } from 'node:dns'
import type { LookupAddress } from 'node:dns'
import type { LookupFunction } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { isForbiddenAddress, isPrivateHost } from './address.js'

/** Stable id this provider registers under. */
export const SAFE_FETCH_PROVIDER_ID = 'omd-safe'

/** Resolved provider limits (the plugin's schemastery Config supplies defaults). */
export interface SafeFetchLimits {
  maxUrlLength: number
  maxResponseBytes: number
  maxBodyChars: number
  timeoutMs: number
  maxRedirects: number
  userAgent: string
  /** Escape hatch: permit private/reserved destinations (internal doc hosts). */
  allowPrivateNetwork: boolean
}

/** Classify a response `Content-Type` into a decodable body kind. */
export function classifyContentType(contentType: string | null): 'html' | 'text' | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml')
  )
    return 'text'
  return undefined
}

/** Extract the lower-cased `charset` parameter of a `Content-Type`, if any. */
export function parseCharset(contentType: string | null): string | undefined {
  return /;\s*charset\s*=\s*"?([^";]+)"?/i
    .exec(contentType ?? '')?.[1]
    ?.trim()
    .toLowerCase()
}

function decoderForCharset(charset: string | undefined): TextDecoder {
  if (charset === undefined) return new TextDecoder('utf-8')
  try {
    return new TextDecoder(charset)
  } catch (error) {
    throw new WebError(`unsupported charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', {
      cause: error,
    })
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

/**
 * Validate a request URL: http(s) only, no embedded credentials, bounded
 * length, and — unless private networks are allowed — no private or reserved
 * destination decidable without DNS.
 */
export function validateFetchUrl(
  input: string,
  limits: Pick<SafeFetchLimits, 'maxUrlLength' | 'allowPrivateNetwork'>,
): URL {
  if (input.length > limits.maxUrlLength) {
    throw new WebError(
      `URL exceeds the maximum length of ${limits.maxUrlLength}`,
      'WEB_INVALID_URL',
    )
  }
  let url: URL
  try {
    url = new URL(input)
  } catch (error) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(
      `unsupported URL scheme "${url.protocol}" (only http and https are allowed)`,
      'WEB_INVALID_URL',
    )
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  if (!limits.allowPrivateNetwork && isPrivateHost(url.hostname)) {
    throw new WebError(
      `"${url.hostname}" is a private or reserved destination; web fetch reaches only public networks`,
      'WEB_BLOCKED_URL',
    )
  }
  return url
}

/**
 * A `net.connect`-compatible lookup that validates every resolved address
 * before the socket dials it. A hostname resolving to ANY forbidden address is
 * rejected outright — a public/private mix is an attack shape, not a fallback
 * opportunity. The resolver parameter exists for hermetic rebinding tests;
 * production callers use the real `dns.lookup`.
 */
export function guardedLookup(
  hostname: string,
  options: Parameters<LookupFunction>[1],
  callback: Parameters<LookupFunction>[2],
  resolve: typeof dnsLookup = dnsLookup,
): void {
  resolve(hostname, { ...options, all: true }, (error, addresses) => {
    if (error !== null) {
      callback(error, '', undefined)
      return
    }
    const list = addresses as LookupAddress[]
    if (list.length === 0) {
      callback(
        Object.assign(new Error(`no addresses for ${hostname}`), { code: 'ENOTFOUND' }),
        '',
        undefined,
      )
      return
    }
    const blocked = list.find((entry) => isForbiddenAddress(entry.address))
    if (blocked !== undefined) {
      callback(
        new WebError(
          `"${hostname}" resolves to the private or reserved address ${blocked.address}; web fetch reaches only public networks`,
          'WEB_BLOCKED_URL',
        ),
        '',
        undefined,
      )
      return
    }
    if (options.all) callback(null, list, undefined)
    else callback(null, list[0].address, list[0].family)
  })
}

/** The SSRF-hardened HTTP(S) fetch provider. */
export class SafeFetchProvider implements WebFetchProvider {
  readonly id = SAFE_FETCH_PROVIDER_ID
  private readonly agent: Agent

  constructor(private readonly limits: SafeFetchLimits) {
    this.agent = new Agent(limits.allowPrivateNetwork ? {} : { connect: { lookup: guardedLookup } })
  }

  /** An anonymous public fetcher is always usable. */
  available(): boolean {
    return true
  }

  /** Release pooled sockets; wired to the plugin scope's disposal. */
  dispose(): void {
    void this.agent.close().catch(() => {})
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    const timeout = AbortSignal.timeout(this.limits.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    try {
      return await this.followAndRead(request.url, combined)
    } catch (error) {
      throw this.translate(error, timeout, signal)
    }
  }

  private translate(error: unknown, timeout: AbortSignal, caller?: AbortSignal): WebError {
    if (error instanceof WebError) return error
    // undici wraps connect-phase lookup errors; surface a guarded rejection as-is.
    if (error instanceof Error && error.cause instanceof WebError) return error.cause
    if (timeout.aborted)
      return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: error })
    if (caller?.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
    return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', {
      cause: error,
    })
  }

  /** Follow same-origin redirects up to the hop cap, then read the final response. */
  private async followAndRead(initialUrl: string, signal: AbortSignal): Promise<WebFetchResult> {
    let currentUrl = validateFetchUrl(initialUrl, this.limits)
    let redirectsFollowed = 0
    for (;;) {
      const response = await this.requestOnce(currentUrl, signal)
      if (isRedirectStatus(response.status)) {
        if (redirectsFollowed >= this.limits.maxRedirects) {
          await response.body?.cancel()
          throw new WebError(
            `exceeded the maximum of ${this.limits.maxRedirects} redirects`,
            'WEB_REDIRECT_BLOCKED',
          )
        }
        const location = response.headers.get('location')
        if (location === null) {
          await response.body?.cancel()
          throw new WebError(
            `redirect response (HTTP ${response.status}) without a Location header`,
            'WEB_PROVIDER_ERROR',
          )
        }
        let validatedTarget: URL
        try {
          const target = new URL(location, currentUrl)
          validatedTarget = validateFetchUrl(target.toString(), this.limits)
          if (!isSameOrigin(validatedTarget, currentUrl)) {
            throw new WebError(
              `cross-origin redirect to ${validatedTarget.origin} is not followed automatically; retry against that URL directly`,
              'WEB_REDIRECT_BLOCKED',
            )
          }
        } catch (error) {
          await response.body?.cancel()
          throw error
        }
        await response.body?.cancel()
        currentUrl = validatedTarget
        redirectsFollowed++
        continue
      }
      return await this.readBody(response, currentUrl)
    }
  }

  private async requestOnce(url: URL, signal: AbortSignal): Promise<Response> {
    return (await undiciFetch(url, {
      method: 'GET',
      redirect: 'manual',
      dispatcher: this.agent,
      headers: {
        'user-agent': this.limits.userAgent,
        accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
      },
      signal,
    })) as unknown as Response
  }

  private async readBody(response: Response, finalUrl: URL): Promise<WebFetchResult> {
    const contentType = response.headers.get('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      await response.body?.cancel()
      throw new WebError(
        `unsupported content type "${contentType ?? 'unknown'}"`,
        'WEB_UNSUPPORTED_CONTENT_TYPE',
      )
    }
    let decoder: TextDecoder
    try {
      decoder = decoderForCharset(parseCharset(contentType))
    } catch (error) {
      await response.body?.cancel()
      throw error
    }
    const { bytes, truncatedByBytes } = await this.readCapped(response)
    const decoded = decoder.decode(bytes)
    const truncatedByChars = decoded.length > this.limits.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded
    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body: kind === 'html' ? { kind: 'html', content } : { kind: 'text', content },
      truncated: truncatedByBytes || truncatedByChars,
    }
  }

  /**
   * Read the response stream up to `maxResponseBytes`: an over-cap
   * `Content-Length` rejects immediately; an under-reporting stream is cut
   * short and marked truncated rather than rejected.
   */
  private async readCapped(
    response: Response,
  ): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
        await response.body?.cancel()
        throw new WebError(
          `response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`,
          'WEB_FETCH_TOO_LARGE',
        )
      }
    }
    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }
    const chunks: Uint8Array[] = []
    let total = 0
    let truncatedByBytes = false
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = this.limits.maxResponseBytes - total
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncatedByBytes = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, truncatedByBytes }
  }
}
