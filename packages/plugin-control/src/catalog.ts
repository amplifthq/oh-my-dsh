import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'

export type OrganSource = 'upstream' | 'oh-my-dsh'

export interface OrganManifest {
  name?: string
  provide: string[]
  inject: string[]
}

export interface OrganIndexEntry {
  id: string
  module: string
  version: string
  summary: string
  risk: string
  manifest: OrganManifest
  config?: Record<string, unknown>
  source: OrganSource
}

export interface ResolvedOrganPackage {
  packageJsonPath: string
}

export type OrganModuleResolver = (specifier: string) => ResolvedOrganPackage | undefined

export type OrganAvailability =
  | {
      status: 'available'
      installedVersion: string
      packageJsonPath: string
    }
  | {
      status: 'not-installed'
    }
  | {
      status: 'version-drift'
      expectedVersion: string
      installedVersion: string
      packageJsonPath: string
    }

export interface OrganView extends OrganIndexEntry {
  availability: OrganAvailability
  active: boolean
}

const ORGAN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const EXACT_SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const BARE_SPECIFIER_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:\/[a-z0-9][a-z0-9._-]*)*$/

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`organ ${field} must be a non-empty string`)
  }
  return value.trim()
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`organ manifest.${field} must be an array of non-empty strings`)
  }
  const result = value.map((item) => item.trim())
  if (new Set(result).size !== result.length) {
    throw new Error(`organ manifest.${field} must not contain duplicates`)
  }
  return result
}

function requireJsonObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`organ ${field} must be a JSON object`)
  }
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('not serializable')
    return JSON.parse(serialized) as Record<string, unknown>
  } catch {
    throw new Error(`organ ${field} must contain only JSON-serializable values`)
  }
}

function parseEntry(value: unknown, index: number): OrganIndexEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`organ index entry ${index} must be an object`)
  }
  const record = value as Record<string, unknown>
  const id = requireString(record.id, 'id')
  if (!ORGAN_ID_PATTERN.test(id)) {
    throw new Error(`organ id ${JSON.stringify(id)} is not a safe catalog id`)
  }
  const module = requireString(record.module, 'module')
  if (!BARE_SPECIFIER_PATTERN.test(module)) {
    throw new Error(`organ module ${JSON.stringify(module)} must be a bare package specifier`)
  }
  const version = requireString(record.version, 'version')
  const versionMatch = EXACT_SEMVER_PATTERN.exec(version)
  const invalidNumericPrerelease = versionMatch?.[1]
    ?.split('.')
    .some(
      (identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === '0',
    )
  if (!versionMatch || invalidNumericPrerelease) {
    throw new Error(`organ version ${JSON.stringify(version)} must be an exact semver pin`)
  }
  const summary = requireString(record.summary, 'summary')
  const risk = requireString(record.risk, 'risk')
  if (!record.manifest || typeof record.manifest !== 'object' || Array.isArray(record.manifest)) {
    throw new Error('organ manifest must be an object')
  }
  const manifestRecord = record.manifest as Record<string, unknown>
  const manifest: OrganManifest = {
    provide: requireStringArray(manifestRecord.provide, 'provide'),
    inject: requireStringArray(manifestRecord.inject, 'inject'),
  }
  if (manifestRecord.name !== undefined) {
    manifest.name = requireString(manifestRecord.name, 'manifest.name')
  }
  const source = requireString(record.source, 'source')
  if (source !== 'upstream' && source !== 'oh-my-dsh') {
    throw new Error(`organ source must be "upstream" or "oh-my-dsh"`)
  }
  const entry: OrganIndexEntry = {
    id,
    module,
    version,
    summary,
    risk,
    manifest,
    source,
  }
  if (record.config !== undefined) entry.config = requireJsonObject(record.config, 'config')
  return entry
}

export function parseOrganIndex(json: string | unknown): OrganIndexEntry[] {
  let value: unknown = json
  if (typeof json === 'string') {
    try {
      value = JSON.parse(json)
    } catch (error) {
      throw new Error(`organ index is not valid JSON: ${String(error)}`)
    }
  }
  if (!Array.isArray(value)) throw new Error('organ index must be an array')
  const entries = value.map(parseEntry)
  const ids = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`duplicate organ id ${JSON.stringify(entry.id)}`)
    ids.add(entry.id)
  }
  return entries
}

interface PackageJson {
  name?: unknown
  version?: unknown
}

function readPackageJson(path: string): PackageJson {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read organ package metadata at ${path}: ${String(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`organ package metadata at ${path} must be an object`)
  }
  return value as PackageJson
}

export function resolveOrganAvailability(
  entry: OrganIndexEntry,
  resolveModule: OrganModuleResolver = resolveInstalledOrgan,
): OrganAvailability {
  const resolved = resolveModule(entry.module)
  if (!resolved) return { status: 'not-installed' }
  const metadata = readPackageJson(resolved.packageJsonPath)
  if (typeof metadata.version !== 'string' || !metadata.version) {
    throw new Error(`organ package metadata at ${resolved.packageJsonPath} has no version`)
  }
  if (metadata.version !== entry.version) {
    return {
      status: 'version-drift',
      expectedVersion: entry.version,
      installedVersion: metadata.version,
      packageJsonPath: resolved.packageJsonPath,
    }
  }
  return {
    status: 'available',
    installedVersion: metadata.version,
    packageJsonPath: resolved.packageJsonPath,
  }
}

export function organView(
  entry: OrganIndexEntry,
  availability: OrganAvailability,
  active: boolean,
): OrganView {
  return structuredClone({ ...entry, availability, active })
}

function packageNameOf(specifier: string): string {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

const localRequire = createRequire(import.meta.url)

export function resolveInstalledOrgan(specifier: string): ResolvedOrganPackage | undefined {
  const packageName = packageNameOf(specifier)
  try {
    return { packageJsonPath: localRequire.resolve(`${packageName}/package.json`) }
  } catch {
    // Some packages do not export package.json. Resolving the entrypoint still
    // executes no module code; walk upward to matching package metadata.
  }
  let entrypoint: string
  try {
    entrypoint = localRequire.resolve(specifier)
  } catch {
    return undefined
  }
  let directory = dirname(entrypoint)
  const root = parse(directory).root
  while (directory !== root) {
    const packageJsonPath = join(directory, 'package.json')
    try {
      if (readPackageJson(packageJsonPath).name === packageName) return { packageJsonPath }
    } catch {
      // Keep looking; most ancestors do not contain package metadata.
    }
    directory = dirname(directory)
  }
  return undefined
}
