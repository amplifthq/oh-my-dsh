import { createHash, randomBytes } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  contentAddressedFilename,
  detectSecretLikeContent,
  IMPORT_WHITELIST,
  pluginDigest,
  SLUG_PATTERN,
  validateForgedPluginInput,
  type ForgedPluginDocument,
  type ForgedPluginManifest,
} from './document.js'

export type ForgedPluginScope = 'user' | 'project'

export interface ForgeRoots {
  dshHome: string
  workspace?: string
}

export interface ForgedPluginTarget {
  scope: ForgedPluginScope
  root: string
  directory: string
  metaPath: string
}

export interface ForgedPluginMeta {
  slug: string
  scope: ForgedPluginScope
  summary: string
  manifest: ForgedPluginManifest
  intendedEffects: string[]
  config?: Record<string, unknown>
  sourceFile: string
  digest: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface ForgedPluginState {
  meta: ForgedPluginMeta
  /** SHA-256 of the raw plugin.json bytes; the stale guard for the next write. */
  metaDigest: string
  /** Present when the referenced source file exists and is readable. */
  source?: string
  /** True only when the source file exists and hashes to meta.digest. */
  digestMatches: boolean
}

export type ForgedPluginSummary =
  | {
      scope: ForgedPluginScope
      slug: string
      status: 'ok'
      meta: ForgedPluginMeta
      digestMatches: boolean
    }
  | { scope: ForgedPluginScope; slug: string; status: 'invalid'; reason: string }

export interface ForgedPluginWritePlan {
  action: 'create' | 'update'
  document: ForgedPluginDocument
  meta: ForgedPluginMeta
  metaContent: string
  sourceFile: string
  digest: string
  warnings: string[]
}

const SOURCE_FILE_PATTERN = /^source\.[0-9a-f]{12}\.mjs$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

export function metaDigestOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function resolveForgedPluginTarget(
  scope: ForgedPluginScope,
  slug: string,
  roots: ForgeRoots,
): ForgedPluginTarget {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`forged plugin slug ${JSON.stringify(slug)} is not a safe directory name`)
  }
  let root: string
  if (scope === 'user') {
    root = resolve(roots.dshHome, 'forged-plugins')
  } else if (scope === 'project') {
    if (!roots.workspace) {
      throw new Error('project scope requires a session workspace; use user scope instead')
    }
    root = resolve(roots.workspace, '.dsh', 'forged-plugins')
  } else {
    throw new Error(`unknown forged plugin scope ${JSON.stringify(scope)}`)
  }
  const directory = join(root, slug)
  const target: ForgedPluginTarget = {
    scope,
    root,
    directory,
    metaPath: join(directory, 'plugin.json'),
  }
  assertLexicallyContained(target)
  return target
}

function assertLexicallyContained(target: ForgedPluginTarget): void {
  const rel = relative(target.root, target.directory)
  if (rel !== basename(target.directory) || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `forged plugin directory ${target.directory} escapes the forge root ${target.root}`,
    )
  }
  if (relative(target.directory, target.metaPath) !== 'plugin.json') {
    throw new Error(`forged plugin metadata ${target.metaPath} escapes ${target.directory}`)
  }
}

async function refuseSymlink(path: string, label: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined)
  if (stat?.isSymbolicLink()) {
    throw new Error(`forged plugin ${label} ${path} is a symlink; refusing to write through it`)
  }
}

async function assertSafeTarget(target: ForgedPluginTarget, sourceFile: string): Promise<void> {
  assertLexicallyContained(target)
  if (!SOURCE_FILE_PATTERN.test(sourceFile)) {
    throw new Error(
      `forged plugin source filename ${JSON.stringify(sourceFile)} is not content-addressed`,
    )
  }
  const directoryStat = await lstat(target.directory).catch(() => undefined)
  if (directoryStat?.isSymbolicLink()) {
    throw new Error(
      `forged plugin directory ${target.directory} is a symlink; refusing to write through it`,
    )
  }
  if (directoryStat && !directoryStat.isDirectory()) {
    throw new Error(`forged plugin directory ${target.directory} exists but is not a directory`)
  }
  await refuseSymlink(target.metaPath, 'metadata file')
  await refuseSymlink(join(target.directory, sourceFile), 'source file')
  // With symlinked segments rejected above, an existing directory must realpath
  // into the (realpathed) root — guards case-mapped or mount-crossing parents.
  const realRoot = await realpath(target.root).catch(() => undefined)
  if (realRoot && directoryStat) {
    const realDirectory = await realpath(target.directory)
    if (realDirectory !== join(realRoot, basename(target.directory))) {
      throw new Error(
        `forged plugin directory ${target.directory} does not resolve inside ${target.root}`,
      )
    }
  }
}

export function parseForgedPluginMeta(content: string, scope: ForgedPluginScope): ForgedPluginMeta {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new Error(`plugin.json is not valid JSON: ${String(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('plugin.json must be a JSON object')
  }
  const record = value as Record<string, unknown>
  if (record.scope !== scope) {
    throw new Error(`plugin.json scope ${JSON.stringify(record.scope)} does not match ${scope}`)
  }
  if (typeof record.sourceFile !== 'string' || !SOURCE_FILE_PATTERN.test(record.sourceFile)) {
    throw new Error('plugin.json sourceFile must be a content-addressed source filename')
  }
  if (typeof record.digest !== 'string' || !DIGEST_PATTERN.test(record.digest)) {
    throw new Error('plugin.json digest must be a lowercase sha256 hex string')
  }
  if (!record.sourceFile.includes(record.digest.slice(0, 12))) {
    throw new Error('plugin.json sourceFile does not match its digest')
  }
  if (
    typeof record.revision !== 'number' ||
    !Number.isInteger(record.revision) ||
    record.revision < 1
  ) {
    throw new Error('plugin.json revision must be a positive integer')
  }
  if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') {
    throw new Error('plugin.json createdAt and updatedAt must be ISO timestamp strings')
  }
  const document = validateForgedPluginInput({
    slug: record.slug as string,
    summary: record.summary as string,
    manifest: (record.manifest ?? {}) as ForgedPluginMeta['manifest'],
    intendedEffects: record.intendedEffects as string[],
    // The stored source is validated separately; satisfy the shape check here.
    source: 'export {}\n',
    config: record.config,
  })
  const meta: ForgedPluginMeta = {
    slug: document.slug,
    scope,
    summary: document.summary,
    manifest: document.manifest,
    intendedEffects: document.intendedEffects,
    sourceFile: record.sourceFile,
    digest: record.digest,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
  if (document.config !== undefined) meta.config = document.config
  return meta
}

export function renderForgedPluginMeta(meta: ForgedPluginMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`
}

export async function readForgedPlugin(
  target: ForgedPluginTarget,
): Promise<ForgedPluginState | undefined> {
  let content: string
  try {
    content = await readFile(target.metaPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const meta = parseForgedPluginMeta(content, target.scope)
  if (meta.slug !== basename(target.directory)) {
    throw new Error(
      `plugin.json slug ${JSON.stringify(meta.slug)} does not match its directory ` +
        `${JSON.stringify(basename(target.directory))}`,
    )
  }
  const state: ForgedPluginState = {
    meta,
    metaDigest: metaDigestOf(content),
    digestMatches: false,
  }
  try {
    const source = await readFile(join(target.directory, meta.sourceFile), 'utf8')
    state.source = source
    state.digestMatches = pluginDigest(source) === meta.digest
  } catch {
    // Missing or unreadable source: digestMatches stays false.
  }
  return state
}

export function planForgedPluginWrite(
  document: ForgedPluginDocument,
  scope: ForgedPluginScope,
  existing?: ForgedPluginState,
  now: () => Date = () => new Date(),
): ForgedPluginWritePlan {
  const digest = pluginDigest(document.source)
  if (existing && existing.meta.digest === digest) {
    throw new Error(
      `forged plugin "${document.slug}" already stores identical source (revision ` +
        `${existing.meta.revision}); revise the source or load the existing revision instead`,
    )
  }
  const timestamp = now().toISOString()
  const meta: ForgedPluginMeta = {
    slug: document.slug,
    scope,
    summary: document.summary,
    manifest: document.manifest,
    intendedEffects: document.intendedEffects,
    sourceFile: contentAddressedFilename(digest),
    digest,
    revision: existing ? existing.meta.revision + 1 : 1,
    createdAt: existing ? existing.meta.createdAt : timestamp,
    updatedAt: timestamp,
  }
  if (document.config !== undefined) meta.config = document.config
  return {
    action: existing ? 'update' : 'create',
    document,
    meta,
    metaContent: renderForgedPluginMeta(meta),
    sourceFile: meta.sourceFile,
    digest,
    warnings: detectSecretLikeContent(document.source),
  }
}

export interface CommitForgedPluginWriteOptions {
  /** Test seam: swap the final rename to inject failures. */
  renameFile?: typeof rename
}

export async function commitForgedPluginWrite(
  target: ForgedPluginTarget,
  plan: ForgedPluginWritePlan,
  expectedMetaDigest?: string,
  options: CommitForgedPluginWriteOptions = {},
): Promise<void> {
  await assertSafeTarget(target, plan.sourceFile)
  let existingMeta: string | undefined
  try {
    existingMeta = await readFile(target.metaPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (expectedMetaDigest === undefined) {
    if (existingMeta !== undefined) {
      throw new Error(
        `forged plugin ${target.metaPath} appeared after the proposal was prepared; ` +
          'prepare a fresh proposal against the current content',
      )
    }
  } else if (existingMeta === undefined) {
    throw new Error(
      `forged plugin ${target.metaPath} disappeared after the proposal was prepared; ` +
        'prepare a fresh proposal',
    )
  } else if (metaDigestOf(existingMeta) !== expectedMetaDigest) {
    throw new Error(
      `forged plugin ${target.metaPath} changed after the proposal was prepared; ` +
        'prepare a fresh proposal against the current content',
    )
  }
  const previousSourceFile = existingMeta
    ? parseForgedPluginMeta(existingMeta, target.scope).sourceFile
    : undefined
  await mkdir(target.directory, { recursive: true })
  const sourcePath = join(target.directory, plan.sourceFile)
  try {
    await writeFile(sourcePath, plan.document.source, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // Content-addressed name already present: identical prefix must mean
    // identical content, otherwise someone planted a colliding file.
    const present = await readFile(sourcePath, 'utf8')
    if (pluginDigest(present) !== plan.digest) {
      throw new Error(
        `forged plugin source ${sourcePath} exists with different content; remove it and retry`,
      )
    }
  }
  const temp = join(target.directory, `.plugin.json.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, plan.metaContent, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
    await (options.renameFile ?? rename)(temp, target.metaPath)
  } catch (error) {
    await unlink(temp).catch(() => {})
    // A failed metadata swap must not leave a source file that no metadata
    // references (first write) — updates keep the previous consistent pair.
    if (!existingMeta) await unlink(sourcePath).catch(() => {})
    throw error
  }
  await chmod(target.metaPath, 0o644)
  if (previousSourceFile && previousSourceFile !== plan.sourceFile) {
    await unlink(join(target.directory, previousSourceFile)).catch(() => {})
  }
}

export async function listForgedPlugins(roots: ForgeRoots): Promise<ForgedPluginSummary[]> {
  const scopes: ForgedPluginScope[] = roots.workspace ? ['project', 'user'] : ['user']
  const summaries: ForgedPluginSummary[] = []
  for (const scope of scopes) {
    let root: string
    try {
      root = resolveForgedPluginTarget(scope, 'probe', roots).root
    } catch {
      continue
    }
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      continue
    }
    for (const slug of entries.sort()) {
      if (!SLUG_PATTERN.test(slug)) continue
      try {
        const state = await readForgedPlugin(resolveForgedPluginTarget(scope, slug, roots))
        if (!state) continue
        summaries.push({
          scope,
          slug,
          status: 'ok',
          meta: state.meta,
          digestMatches: state.digestMatches,
        })
      } catch (error) {
        summaries.push({
          scope,
          slug,
          status: 'invalid',
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return summaries
}

export function forgedSourceFileUrl(target: ForgedPluginTarget, meta: ForgedPluginMeta): string {
  return pathToFileURL(join(target.directory, meta.sourceFile)).href
}

const localRequire = createRequire(import.meta.url)

export type PackageDirResolver = (packageName: string) => string

function defaultResolvePackageDir(packageName: string): string {
  return dirname(localRequire.resolve(`${packageName}/package.json`))
}

/**
 * Bare specifiers do not resolve from an arbitrary user directory, so link the
 * whitelisted packages into `<forge root>/node_modules`, pointing at exactly
 * the copies the harness itself resolved. The forged source stays byte-for-byte
 * what was reviewed; resolution uses Node's ordinary upward walk.
 */
export async function ensureImportResolution(
  root: string,
  packages: readonly string[] = IMPORT_WHITELIST,
  resolvePackageDir: PackageDirResolver = defaultResolvePackageDir,
): Promise<void> {
  for (const packageName of packages) {
    const packageDir = resolvePackageDir(packageName)
    const linkPath = join(root, 'node_modules', ...packageName.split('/'))
    const current = await readlink(linkPath).catch(() => undefined)
    if (current === packageDir) continue
    await mkdir(dirname(linkPath), { recursive: true })
    await rm(linkPath, { recursive: true, force: true })
    try {
      await symlink(packageDir, linkPath, 'junction')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if ((await readlink(linkPath).catch(() => undefined)) !== packageDir) throw error
    }
  }
}
