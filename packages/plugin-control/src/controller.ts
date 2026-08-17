import {
  FiberState,
  type Context,
  type EffectMeta,
  type Fiber,
  type Inject,
  type Plugin,
} from '@deepseek-ai/cordis'

import {
  resolveInstalledOrgan,
  resolveOrganAvailability,
  type OrganIndexEntry,
  type OrganModuleResolver,
} from './catalog.js'

export type OrganImporter = (specifier: string) => Promise<unknown>

export interface ActiveOrganView {
  id: string
  instanceId: string
  module: string
  version: string
  fiberState: FiberStateName
  effectLabels: string[]
  config: Record<string, unknown>
}

export type LoadedOrgan = ActiveOrganView

type FiberStateName =
  'PENDING' | 'LOADING' | 'ACTIVE' | 'FAILED' | 'DISPOSED' | 'UNLOADING' | 'UNKNOWN'

interface ActiveOrganRecord {
  view: ActiveOrganView
  fiber: Fiber
}

interface LoadingOrganRecord {
  abort: AbortController
  fiber?: Fiber
  promise: Promise<LoadedOrgan>
}

export interface OrganControllerOptions {
  resolveModule?: OrganModuleResolver
  importModule?: OrganImporter
}

function defaultImportModule(specifier: string): Promise<unknown> {
  return import(specifier)
}

function stateName(state: FiberState): FiberStateName {
  switch (state) {
    case FiberState.PENDING:
      return 'PENDING'
    case FiberState.LOADING:
      return 'LOADING'
    case FiberState.ACTIVE:
      return 'ACTIVE'
    case FiberState.FAILED:
      return 'FAILED'
    case FiberState.DISPOSED:
      return 'DISPOSED'
    case FiberState.UNLOADING:
      return 'UNLOADING'
    default:
      return 'UNKNOWN'
  }
}

function flattenEffectLabels(effects: EffectMeta[]): string[] {
  const result: string[] = []
  const visit = (effect: EffectMeta) => {
    if (effect.label) result.push(effect.label)
    effect.children.forEach(visit)
  }
  effects.forEach(visit)
  return result
}

function normalizeStringSet(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return [...new Set(value)].sort()
  }
  if (field === 'inject' && value && typeof value === 'object') {
    return Object.keys(value).sort()
  }
  throw new Error(`imported organ manifest ${field} is not a string, string array, or inject map`)
}

function sameSet(actual: string[], expected: string[]): boolean {
  const left = [...actual].sort()
  const right = [...expected].sort()
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function pluginFromModule(value: unknown): Plugin {
  if (typeof value === 'function') return value as Plugin
  if (value && typeof value === 'object') {
    const namespace = value as Record<string, unknown>
    if (typeof namespace.apply === 'function') return namespace as unknown as Plugin
    if (typeof namespace.default === 'function') return namespace.default as Plugin
    if (
      namespace.default &&
      typeof namespace.default === 'object' &&
      typeof (namespace.default as Record<string, unknown>).apply === 'function'
    ) {
      return namespace.default as Plugin
    }
  }
  throw new Error('imported organ does not export a Cordis function, class, or { apply } plugin')
}

function verifyManifest(entry: OrganIndexEntry, plugin: Plugin): void {
  const metadata = plugin as Plugin & {
    name?: string
    provide?: string | string[]
    inject?: Inject
  }
  if (entry.manifest.name !== undefined && metadata.name !== entry.manifest.name) {
    throw new Error(
      `organ manifest name mismatch: reviewed ${JSON.stringify(entry.manifest.name)}, ` +
        `imported ${JSON.stringify(metadata.name)}`,
    )
  }
  const provide = normalizeStringSet(metadata.provide, 'provide')
  if (!sameSet(provide, entry.manifest.provide)) {
    throw new Error(
      `organ manifest provide mismatch: reviewed ${JSON.stringify(entry.manifest.provide)}, ` +
        `imported ${JSON.stringify(provide)}`,
    )
  }
  const inject = normalizeStringSet(metadata.inject, 'inject')
  if (!sameSet(inject, entry.manifest.inject)) {
    throw new Error(
      `organ manifest inject mismatch: reviewed ${JSON.stringify(entry.manifest.inject)}, ` +
        `imported ${JSON.stringify(inject)}`,
    )
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('organ load aborted')
}

export class OrganController {
  private readonly resolveModule: OrganModuleResolver
  private readonly importModule: OrganImporter
  private readonly byOwner = new WeakMap<object, Map<string, ActiveOrganRecord>>()
  private readonly loadingByOwner = new WeakMap<object, Map<string, LoadingOrganRecord>>()
  private readonly disposedOwners = new WeakSet<object>()
  private sequence = 0

  constructor(options: OrganControllerOptions = {}) {
    this.resolveModule = options.resolveModule ?? resolveInstalledOrgan
    this.importModule = options.importModule ?? defaultImportModule
  }

  async load(
    owner: object,
    ownerCtx: Context,
    entry: OrganIndexEntry,
    config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LoadedOrgan> {
    throwIfAborted(signal)
    if (this.disposedOwners.has(owner)) {
      throw new Error('cannot load an organ for a disposed owner')
    }
    const records = this.records(owner)
    if (records.has(entry.id)) throw new Error(`organ "${entry.id}" is already active`)
    const loading = this.loading(owner)
    if (loading.has(entry.id)) throw new Error(`organ "${entry.id}" is already loading`)
    const abort = new AbortController()
    const loadSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    const operation = {
      abort,
      promise: undefined as unknown as Promise<LoadedOrgan>,
    } as LoadingOrganRecord
    operation.promise = this.performLoad(owner, ownerCtx, entry, config, loadSignal, operation)
    loading.set(entry.id, operation)
    try {
      return await operation.promise
    } finally {
      if (loading.get(entry.id) === operation) loading.delete(entry.id)
    }
  }

  private async performLoad(
    owner: object,
    ownerCtx: Context,
    entry: OrganIndexEntry,
    config: Record<string, unknown>,
    signal: AbortSignal,
    operation: LoadingOrganRecord,
  ): Promise<LoadedOrgan> {
    let fiber: Fiber | undefined
    try {
      const availability = resolveOrganAvailability(entry, this.resolveModule)
      if (availability.status === 'not-installed') {
        throw new Error(
          `organ "${entry.id}" is not installed; v1 never installs packages at runtime`,
        )
      }
      if (availability.status === 'version-drift') {
        throw new Error(
          `organ "${entry.id}" version drift: reviewed ${availability.expectedVersion}, ` +
            `installed ${availability.installedVersion}`,
        )
      }
      throwIfAborted(signal)
      const imported = await this.importModule(entry.module)
      throwIfAborted(signal)
      const plugin = pluginFromModule(imported)
      verifyManifest(entry, plugin)
      fiber = ownerCtx.plugin(plugin, structuredClone(config))
      operation.fiber = fiber
      await fiber.await()
      throwIfAborted(signal)
      if (fiber.state !== FiberState.ACTIVE) {
        throw new Error(
          `organ "${entry.id}" did not become active (Cordis state ${stateName(fiber.state)})`,
        )
      }
      const view: ActiveOrganView = {
        id: entry.id,
        instanceId: `organ-instance-${++this.sequence}`,
        module: entry.module,
        version: entry.version,
        fiberState: stateName(fiber.state),
        effectLabels: flattenEffectLabels(fiber.getEffects()),
        config: structuredClone(config),
      }
      this.records(owner).set(entry.id, { view, fiber })
      return structuredClone(view)
    } catch (error) {
      if (fiber) {
        try {
          await fiber.dispose()
        } catch (disposeError) {
          throw new AggregateError(
            [error, disposeError],
            `organ "${entry.id}" failed and its fiber cleanup also failed`,
          )
        }
      }
      throw error
    }
  }

  list(owner: object): ActiveOrganView[] {
    return [...(this.byOwner.get(owner)?.values() ?? [])].map(({ view, fiber }) => ({
      ...structuredClone(view),
      fiberState: stateName(fiber.state),
      effectLabels: flattenEffectLabels(fiber.getEffects()),
    }))
  }

  async unload(owner: object, id: string, expectedInstanceId?: string): Promise<boolean> {
    const records = this.byOwner.get(owner)
    const record = records?.get(id)
    if (!record) return false
    if (expectedInstanceId !== undefined && record.view.instanceId !== expectedInstanceId) {
      throw new Error(
        `organ "${id}" changed since approval: reviewed instance ${expectedInstanceId}, ` +
          `active instance ${record.view.instanceId}`,
      )
    }
    try {
      await record.fiber.dispose()
      if (record.fiber.state !== FiberState.DISPOSED) {
        throw new Error(
          `organ "${id}" did not dispose cleanly (Cordis state ${stateName(record.fiber.state)})`,
        )
      }
      return true
    } finally {
      if (record.fiber.state === FiberState.DISPOSED) records?.delete(id)
    }
  }

  async disposeOwner(owner: object): Promise<void> {
    this.disposedOwners.add(owner)
    let firstError: unknown
    const loading = [...(this.loadingByOwner.get(owner)?.values() ?? [])]
    for (const operation of loading) operation.abort.abort(new Error('organ owner disposed'))
    for (const operation of loading) {
      if (!operation.fiber) continue
      try {
        await operation.fiber.dispose()
      } catch (error) {
        firstError ??= error
      }
    }
    await Promise.allSettled(loading.map((operation) => operation.promise))
    for (const operation of loading) {
      if (!operation.fiber || operation.fiber.state === FiberState.DISPOSED) continue
      try {
        await operation.fiber.dispose()
      } catch (error) {
        firstError ??= error
      }
    }
    const ids = [...(this.byOwner.get(owner)?.keys() ?? [])]
    for (const id of ids) {
      try {
        await this.unload(owner, id)
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) throw firstError
  }

  private records(owner: object): Map<string, ActiveOrganRecord> {
    let records = this.byOwner.get(owner)
    if (!records) {
      records = new Map()
      this.byOwner.set(owner, records)
    }
    return records
  }

  private loading(owner: object): Map<string, LoadingOrganRecord> {
    let loading = this.loadingByOwner.get(owner)
    if (!loading) {
      loading = new Map()
      this.loadingByOwner.set(owner, loading)
    }
    return loading
  }
}
