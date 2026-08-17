import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { init as initModuleLexer, parse as parseModule } from 'es-module-lexer'

import { SLUG_PATTERN, detectSecretLikeContent } from '../../skill-forge/src/document.js'

export interface ForgedPluginManifest {
  name: string
  provide: string[]
  inject: string[]
}

export interface ForgedPluginInput {
  slug: string
  summary: string
  manifest: { name?: unknown; provide?: unknown; inject?: unknown }
  intendedEffects: string[]
  source: string
  config?: unknown
}

export interface ForgedPluginDocument {
  slug: string
  summary: string
  manifest: ForgedPluginManifest
  intendedEffects: string[]
  source: string
  config?: Record<string, unknown>
}

export interface PluginSourceReport {
  imports: string[]
  exportsApply: boolean
  exportsName: boolean
}

export const SUMMARY_MAX_CHARS = 500
export const INTENDED_EFFECT_MAX_CHARS = 200
export const MANIFEST_MAX_ENTRIES = 8
export const INTENDED_EFFECTS_MAX = 8
export const SOURCE_MAX_BYTES = 32 * 1024

/**
 * Static imports a forged plugin may declare. This exists for review clarity,
 * not sandboxing: in-process JavaScript cannot be confined, and a registered
 * tool's execute body can still reach globalThis, fetch, and process. The
 * whitelist guarantees every module dependency is visible at review time; it
 * does not restrict runtime reach.
 */
export const IMPORT_WHITELIST: readonly string[] = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools']

function requireSingleLine(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== 'string') throw new Error(`forged plugin ${field} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`forged plugin ${field} must not be empty`)
  if (trimmed.includes('\n')) throw new Error(`forged plugin ${field} must be a single line`)
  if (trimmed.length > maxChars) {
    throw new Error(
      `forged plugin ${field} must be at most ${maxChars} characters (got ${trimmed.length})`,
    )
  }
  return trimmed
}

function requireStringSet(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`forged plugin ${field} must be an array of non-empty strings`)
  }
  const result = value.map((item) => item.trim())
  if (new Set(result).size !== result.length) {
    throw new Error(`forged plugin ${field} must not contain duplicates`)
  }
  if (result.length > max) {
    throw new Error(
      `forged plugin ${field} must have at most ${max} entries (got ${result.length})`,
    )
  }
  return result
}

function requireJsonObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`forged plugin ${field} must be a JSON object`)
  }
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('not serializable')
    return JSON.parse(serialized) as Record<string, unknown>
  } catch {
    throw new Error(`forged plugin ${field} must contain only JSON-serializable values`)
  }
}

export function validateForgedPluginInput(input: ForgedPluginInput): ForgedPluginDocument {
  if (typeof input.slug !== 'string' || !SLUG_PATTERN.test(input.slug)) {
    throw new Error(
      'forged plugin slug must be 1-41 characters of lowercase letters, digits, and hyphens ' +
        `(got ${JSON.stringify(input.slug)})`,
    )
  }
  const summary = requireSingleLine(input.summary, 'summary', SUMMARY_MAX_CHARS)
  if (!input.manifest || typeof input.manifest !== 'object' || Array.isArray(input.manifest)) {
    throw new Error('forged plugin manifest must be an object')
  }
  const name = requireSingleLine(input.manifest.name, 'manifest.name', SUMMARY_MAX_CHARS)
  if (name !== input.slug) {
    throw new Error(
      `forged plugin manifest.name must equal the slug: expected ${JSON.stringify(input.slug)}, ` +
        `got ${JSON.stringify(name)}`,
    )
  }
  const manifest: ForgedPluginManifest = {
    name,
    provide: requireStringSet(input.manifest.provide, 'manifest.provide', MANIFEST_MAX_ENTRIES),
    inject: requireStringSet(input.manifest.inject, 'manifest.inject', MANIFEST_MAX_ENTRIES),
  }
  const intendedEffects = requireStringSet(
    input.intendedEffects,
    'intendedEffects',
    INTENDED_EFFECTS_MAX,
  ).map((effect) => requireSingleLine(effect, 'intendedEffects entry', INTENDED_EFFECT_MAX_CHARS))
  if (intendedEffects.length === 0) {
    throw new Error('forged plugin intendedEffects must declare at least one effect')
  }
  const source = validateSourceText(input.source)
  const document: ForgedPluginDocument = {
    slug: input.slug,
    summary,
    manifest,
    intendedEffects,
    source,
  }
  if (input.config !== undefined) document.config = requireJsonObject(input.config, 'config')
  return document
}

function validateSourceText(source: unknown): string {
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error('forged plugin source must be a non-empty string')
  }
  if (source.includes('\0')) throw new Error('forged plugin source must not contain NUL bytes')
  if (source.includes('\r')) {
    throw new Error('forged plugin source must use LF line endings (no carriage returns)')
  }
  const bytes = Buffer.byteLength(source, 'utf8')
  if (bytes > SOURCE_MAX_BYTES) {
    throw new Error(`forged plugin source must be at most ${SOURCE_MAX_BYTES} bytes (got ${bytes})`)
  }
  return source
}

export function pluginDigest(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

export function contentAddressedFilename(digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error('forged plugin digest must be a lowercase sha256 hex string')
  }
  return `source.${digest.slice(0, 12)}.mjs`
}

export interface CheckModuleSyntaxOptions {
  /** Test seam: swap the node executable used for `--check`. */
  execPath?: string
  timeoutMs?: number
}

/**
 * Authoritative ESM syntax gate: V8 parses the source via `node --check`
 * without executing a single statement. TypeScript 7's native compiler no
 * longer ships the JS parser API, so the engine that will later import the
 * module is also the one that validates it.
 */
export async function checkModuleSyntax(
  source: string,
  options: CheckModuleSyntaxOptions = {},
): Promise<void> {
  const execPath = options.execPath ?? process.execPath
  const timeoutMs = options.timeoutMs ?? 10_000
  const stderr = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
    const child = spawn(execPath, ['--check', '--input-type=module', '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`forged plugin syntax check timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stderr.on('data', (chunk: Buffer) => {
      if (chunks.reduce((sum, current) => sum + current.length, 0) < 8192) chunks.push(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, text: Buffer.concat(chunks).toString('utf8') })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(source)
  })
  if (stderr.code !== 0) {
    const detail = stderr.text.trim().split('\n').slice(0, 12).join('\n')
    throw new Error(`forged plugin source is not valid ESM:\n${detail}`)
  }
}

/**
 * Static structure scan. Runs the authoritative syntax gate, then extracts
 * every import and export with es-module-lexer — no plugin code executes.
 * Rejections here are hard: they block the proposal from being created.
 */
export async function scanPluginSource(
  source: string,
  options: CheckModuleSyntaxOptions = {},
): Promise<PluginSourceReport> {
  validateSourceText(source)
  await checkModuleSyntax(source, options)
  await initModuleLexer
  const [imports, exports] = parseModule(source)
  const staticImports: string[] = []
  for (const record of imports) {
    if (record.d === -2) continue // import.meta carries no dependency
    if (record.d >= 0) {
      throw new Error(
        'forged plugin source must not use dynamic import(); every dependency must be a ' +
          'static import so it is visible at review time',
      )
    }
    const specifier = record.n
    if (specifier === undefined) {
      throw new Error(
        'forged plugin source contains an import whose specifier cannot be resolved statically',
      )
    }
    if (!IMPORT_WHITELIST.includes(specifier)) {
      throw new Error(
        `forged plugin import ${JSON.stringify(specifier)} is not in the reviewed whitelist ` +
          `(${IMPORT_WHITELIST.join(', ')})`,
      )
    }
    staticImports.push(specifier)
  }
  // Conservative token check: in ESM `require` is undefined anyway, but reject
  // the token outright (even in strings or comments) so reviewed source cannot
  // even allude to a CommonJS escape hatch. False positives only ever block.
  if (/\brequire\b/.test(source)) {
    throw new Error('forged plugin source must not reference require; use static ESM imports')
  }
  const exportNames = new Set(exports.map((record) => record.n))
  const exportsName = exportNames.has('name')
  const exportsApply = exportNames.has('apply') || exportNames.has('default')
  if (!exportsName) {
    throw new Error('forged plugin source must export a top-level `name` matching the manifest')
  }
  if (!exportsApply) {
    throw new Error('forged plugin source must export an `apply` function (named or default)')
  }
  return { imports: [...new Set(staticImports)].sort(), exportsApply, exportsName }
}

export { SLUG_PATTERN, detectSecretLikeContent }
