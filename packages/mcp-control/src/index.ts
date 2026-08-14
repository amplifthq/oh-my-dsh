import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ProposalRuntime } from '../../proposals/src/index.ts'

export const name = 'omd-mcp-control'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpControl: McpControlRuntime
    proposals: ProposalRuntime
  }
}

export type McpServerSource = 'preset' | 'user' | 'project'

export interface StdioMcpServerDefinition {
  name: string
  source: McpServerSource
  configPath?: string
  transport: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd: string
}

export interface HttpMcpServerDefinition {
  name: string
  source: McpServerSource
  configPath?: string
  transport: 'streamable-http'
  url: string
  headers?: Record<string, string>
}

export type McpServerDefinition = StdioMcpServerDefinition | HttpMcpServerDefinition

export interface CachedMcpTool {
  name: string
  description: string
}

export interface McpCacheEntry {
  fingerprint: string
  tools: CachedMcpTool[]
}

export interface McpServerView {
  name: string
  source: McpServerSource
  transport: McpServerDefinition['transport']
  endpoint: string
  configPath?: string
  cwd?: string
  argumentCount?: number
  argumentPreview?: string[]
  environmentNames?: string[]
  headerNames?: string[]
  cachedTools?: CachedMcpTool[]
}

export interface McpCatalogView extends McpServerView {
  status: 'inactive' | 'active'
}

export type McpMetadataCache = Record<string, McpCacheEntry>

export interface McpFiberHandle {
  dispose(): void | Promise<void>
}

export interface ActiveMcpServer {
  fiber: McpFiberHandle
  tools: CachedMcpTool[]
}

interface McpCatalogState {
  definitions: Map<string, McpServerDefinition>
  active: Map<string, ActiveMcpServer>
}

interface RemovedActiveMcpServer extends ActiveMcpServer {
  name: string
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  )
}

export function fingerprintServer(definition: McpServerDefinition): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(definition)))
    .digest('hex')
}

function expandEnvironment(value: string): string {
  return value
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => process.env[key] ?? '')
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => process.env[key] ?? '')
}

function expandRecord(input: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input ?? {}).map(([key, value]) => [key, expandEnvironment(value)]),
  )
}

export function materializeMcpConfig(
  definition: McpServerDefinition,
  serverName: string,
): McpClient.Config {
  const common = {
    serverName,
    toolCallTimeoutMs: 60_000,
    failOnStartupError: true,
    reconnect: {
      enabled: true,
      initialDelayMs: 500,
      maxDelayMs: 30_000,
      maxAttempts: 10,
    },
  }
  if (definition.transport === 'stdio') {
    return {
      ...common,
      transport: 'stdio',
      command: expandEnvironment(definition.command),
      args: (definition.args ?? []).map(expandEnvironment),
      env: expandRecord(definition.env),
      cwd: expandEnvironment(definition.cwd),
    }
  }
  return {
    ...common,
    transport: 'streamable-http',
    url: expandEnvironment(definition.url),
    headers: expandRecord(definition.headers),
  }
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return '[invalid URL]'
  }
}

function argumentPreview(args: string[]): string[] {
  let redactNext: 'value' | 'environment' | undefined
  const sensitiveName = (value: string) =>
    /(?:^|[_-])(?:api[_-]?key|token|secret|password|passwd|credential|authorization|cookie)(?:$|[_-])/i
      .test(value)
  const redactEnvironment = (value: string) => {
    const assignment = value.match(/^([A-Za-z_][A-Za-z0-9_]*)=.+$/)
    return assignment ? `${assignment[1]}=[redacted]` : '[redacted]'
  }
  return args.map((argument) => {
    if (redactNext) {
      const mode = redactNext
      redactNext = undefined
      return mode === 'environment' ? redactEnvironment(argument) : '[redacted]'
    }
    const shortHeader = argument.match(/^(-H)=?.+$/)
    if (shortHeader) return `${shortHeader[1]}[redacted]`
    const longHeader = argument.match(/^(--(?:http-|request-)?headers?)=.+$/i)
    if (longHeader) return `${longHeader[1]}=[redacted]`
    if (/^(?:-H|--(?:http-|request-)?headers?)$/i.test(argument)) {
      redactNext = 'value'
      return argument
    }
    if (/^(?:-e|--env|--environment|--env-var)$/i.test(argument)) {
      redactNext = 'environment'
      return argument
    }
    if (/^--(?:env|environment|env-var)=/i.test(argument)) {
      const [flag, ...value] = argument.split('=')
      return `${flag}=${redactEnvironment(value.join('='))}`
    }
    const environment = argument.match(/^([A-Za-z_][A-Za-z0-9_]*)=.+$/)
    if (environment && sensitiveName(environment[1])) {
      return `${environment[1]}=[redacted]`
    }
    if (/^(?:authorization|proxy-authorization|cookie|set-cookie)\s*:/i.test(argument)) {
      return '[redacted]'
    }
    if (/^--?[^=]*(?:token|secret|password|passwd|api[-_]?key|authorization|credential|cookie|header)[^=]*$/i.test(argument)) {
      redactNext = 'value'
      return argument
    }
    const assignment = argument.match(/^((?:--?)[^=]*(?:token|secret|password|passwd|api[-_]?key|authorization|credential|cookie|header)[^=]*=).+$/i)
    if (assignment) return `${assignment[1]}[redacted]`
    if (/^bearer\s+/i.test(argument)) return '[redacted]'
    if (/["'](?:api[_-]?key|token|secret|password|credential|authorization|cookie)["']\s*[:=]/i.test(argument)) {
      return '[redacted]'
    }
    if (/^https?:\/\//i.test(argument)) return redactUrl(argument)
    return argument
  })
}

export function redactedServerView(definition: McpServerDefinition): McpServerView {
  if (definition.transport === 'stdio') {
    return {
      name: definition.name,
      source: definition.source,
      configPath: definition.configPath,
      transport: definition.transport,
      endpoint: definition.command,
      cwd: definition.cwd,
      argumentCount: definition.args?.length ?? 0,
      argumentPreview: argumentPreview(definition.args ?? []),
      environmentNames: Object.keys(definition.env ?? {}).sort(),
    }
  }
  return {
    name: definition.name,
    source: definition.source,
    configPath: definition.configPath,
    transport: definition.transport,
    endpoint: redactUrl(definition.url),
    headerNames: Object.keys(definition.headers ?? {}).sort(),
  }
}

export function validCachedTools(
  entry: McpCacheEntry | undefined,
  fingerprint: string,
): CachedMcpTool[] {
  return entry?.fingerprint === fingerprint ? structuredClone(entry.tools) : []
}

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function scoreEntry(entry: McpServerView, query: string): number {
  const queryTokens = tokens(query)
  if (!queryTokens.length) return 1
  const nameTokens = tokens(entry.name)
  const toolNames = (entry.cachedTools ?? []).flatMap((tool) => tokens(tool.name))
  const descriptions = (entry.cachedTools ?? []).flatMap((tool) => tokens(tool.description))
  return queryTokens.reduce((score, token) => {
    if (nameTokens.includes(token)) return score + 8
    if (toolNames.includes(token)) return score + 6
    if (descriptions.includes(token)) return score + 3
    if (nameTokens.some((candidate) => candidate.startsWith(token))) return score + 2
    if (toolNames.some((candidate) => candidate.startsWith(token))) return score + 1
    return score
  }, 0)
}

export function searchCatalog<T extends McpServerView>(entries: T[], query: string): T[] {
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
    .map(({ entry }) => entry)
}

export function readMcpCache(path: string): McpMetadataCache {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const output: McpMetadataCache = {}
    for (const [name, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const entry = value as { fingerprint?: unknown; tools?: unknown }
      if (typeof entry.fingerprint !== 'string' || !Array.isArray(entry.tools)) continue
      const tools = entry.tools
        .filter((tool): tool is { name: string; description: string } =>
          Boolean(tool)
          && typeof tool === 'object'
          && typeof (tool as { name?: unknown }).name === 'string'
          && typeof (tool as { description?: unknown }).description === 'string')
        .map((tool) => ({ name: tool.name, description: tool.description }))
      output[name] = { fingerprint: entry.fingerprint, tools }
    }
    return output
  } catch {
    return {}
  }
}

export function writeMcpCache(path: string, cache: McpMetadataCache): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}

export interface McpCacheUpdateOptions {
  timeoutMs?: number
  retryMs?: number
  staleMs?: number
}

export async function updateMcpCache(
  path: string,
  entries: McpMetadataCache,
  options: McpCacheUpdateOptions = {},
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  const lockPath = `${path}.lock`
  const timeoutMs = options.timeoutMs ?? 2_000
  const retryMs = options.retryMs ?? 25
  const staleMs = options.staleMs ?? 30_000
  const deadline = Date.now() + timeoutMs
  let descriptor: number | undefined
  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          rmSync(lockPath, { force: true })
          continue
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw statError
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for MCP metadata cache lock: ${path}`)
      }
      await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())))
    }
  }
  try {
    writeMcpCache(path, {
      ...readMcpCache(path),
      ...entries,
    })
  } finally {
    closeSync(descriptor)
    rmSync(lockPath, { force: true })
  }
}

export class McpCatalogStore {
  private readonly states = new WeakMap<object, McpCatalogState>()

  constructor(private readonly cache: McpMetadataCache = {}) {}

  configure(owner: object, definitions: McpServerDefinition[]): RemovedActiveMcpServer[] {
    const existing = this.states.get(owner)
    const active = existing?.active ?? new Map<string, ActiveMcpServer>()
    const nextDefinitions = new Map(
      definitions.map((definition) => [definition.name, structuredClone(definition)]),
    )
    const removed: RemovedActiveMcpServer[] = []
    for (const [name, value] of active) {
      const previous = existing?.definitions.get(name)
      const next = nextDefinitions.get(name)
      if (
        !previous
        || !next
        || fingerprintServer(previous) !== fingerprintServer(next)
      ) {
        active.delete(name)
        removed.push({ name, ...value })
      }
    }
    this.states.set(owner, {
      definitions: nextDefinitions,
      active,
    })
    return removed
  }

  list(owner: object): McpCatalogView[] {
    const state = this.states.get(owner)
    if (!state) return []
    return [...state.definitions.values()]
      .map((definition) => {
        const view = redactedServerView(definition)
        const active = state.active.get(definition.name)
        const fingerprint = fingerprintServer(definition)
        return {
          ...view,
          status: active ? 'active' as const : 'inactive' as const,
          cachedTools: active?.tools ?? validCachedTools(this.cache[definition.name], fingerprint),
        }
      })
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  definition(owner: object, name: string): McpServerDefinition | undefined {
    const definition = this.states.get(owner)?.definitions.get(name)
    return definition && structuredClone(definition)
  }

  active(owner: object, name: string): ActiveMcpServer | undefined {
    return this.states.get(owner)?.active.get(name)
  }

  activate(
    owner: object,
    name: string,
    fiber: McpFiberHandle,
    tools: CachedMcpTool[],
  ): void {
    const state = this.requireState(owner)
    if (!state.definitions.has(name)) throw new Error(`unknown MCP server "${name}"`)
    if (state.active.has(name)) throw new Error(`MCP server "${name}" is already active`)
    const copiedTools = structuredClone(tools)
    state.active.set(name, { fiber, tools: copiedTools })
    const definition = state.definitions.get(name) as McpServerDefinition
    this.cache[name] = {
      fingerprint: fingerprintServer(definition),
      tools: copiedTools,
    }
  }

  deactivate(owner: object, name: string): ActiveMcpServer | undefined {
    const state = this.states.get(owner)
    const active = state?.active.get(name)
    if (active) state?.active.delete(name)
    return active
  }

  cacheEntry(name: string): McpCacheEntry | undefined {
    const entry = this.cache[name]
    return entry && structuredClone(entry)
  }

  private requireState(owner: object): McpCatalogState {
    const state = this.states.get(owner)
    if (!state) throw new Error('MCP catalog is not configured for this agent')
    return state
  }
}

export interface LoadedMcpServer {
  fiber: McpFiberHandle
  tools: CachedMcpTool[]
}

export interface AwaitableMcpFiber extends McpFiberHandle, PromiseLike<unknown> {}

export async function settleLoadedMcpFiber(
  fiber: AwaitableMcpFiber,
  inspectTools: () => CachedMcpTool[] | Promise<CachedMcpTool[]>,
  signal?: AbortSignal,
): Promise<LoadedMcpServer> {
  let abortDisposal: Promise<void> | undefined
  const onAbort = () => {
    abortDisposal = Promise.resolve(fiber.dispose())
    void abortDisposal.catch(() => undefined)
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await fiber
    signal?.throwIfAborted()
    return { fiber, tools: await inspectTools() }
  } catch (error) {
    try {
      await (abortDisposal ?? fiber.dispose())
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], 'MCP startup cleanup failed')
    }
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

export type McpServerLoader = (
  owner: object,
  definition: McpServerDefinition,
  namespace: string,
  signal?: AbortSignal,
) => Promise<LoadedMcpServer>

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('MCP activation aborted')
}

function awaitLoadedServer(
  loading: Promise<LoadedMcpServer>,
  signal: AbortSignal | undefined,
  onCleanupError: (error: unknown) => void,
): Promise<LoadedMcpServer> {
  if (!signal) return loading
  return (async () => {
    let aborted = signal.aborted
    const onAbort = () => {
      aborted = true
    }
    if (!aborted) signal.addEventListener('abort', onAbort, { once: true })
    try {
      const loaded = await loading
      if (!aborted && !signal.aborted) return loaded
      try {
        await loaded.fiber.dispose()
      } catch (error) {
        onCleanupError(error)
      }
      throw abortReason(signal)
    } catch (error) {
      if (!aborted && !signal.aborted) throw error
      if (error !== signal.reason) onCleanupError(error)
      throw abortReason(signal)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  })()
}

export function mcpServerNamespace(ownerId: string, serverName: string): string {
  const normalized = serverName.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'server'
  const ownerHash = createHash('sha256').update(ownerId).digest('hex').slice(0, 6)
  const serverHash = createHash('sha256').update(serverName).digest('hex').slice(0, 6)
  const prefix = `omd-${ownerHash}-`
  const suffix = `-${serverHash}`
  return `${prefix}${normalized.slice(0, 32 - prefix.length - suffix.length)}${suffix}`
}

export class McpActivationController {
  private readonly tracked = new Map<McpFiberHandle, { owner: object; name: string }>()

  constructor(
    private readonly store: McpCatalogStore,
    private readonly load: McpServerLoader,
    private readonly onCleanupError: (error: unknown) => void = () => {},
  ) {}

  async configure(owner: object, definitions: McpServerDefinition[]): Promise<void> {
    const removed = this.store.configure(owner, definitions)
    const failures: unknown[] = []
    for (const active of removed) {
      try {
        await active.fiber.dispose()
      } catch (error) {
        failures.push(error)
      } finally {
        this.tracked.delete(active.fiber)
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, 'failed to dispose replaced MCP servers')
    }
  }

  async activate(
    owner: object,
    ownerId: string,
    serverName: string,
    expectedFingerprint: string,
    signal?: AbortSignal,
  ): Promise<LoadedMcpServer> {
    signal?.throwIfAborted()
    const definition = this.store.definition(owner, serverName)
    if (!definition) throw new Error(`unknown MCP server "${serverName}"`)
    if (fingerprintServer(definition) !== expectedFingerprint) {
      throw new Error(`MCP server "${serverName}" changed since approval`)
    }
    if (this.store.active(owner, serverName)) {
      throw new Error(`MCP server "${serverName}" is already active`)
    }
    let loaded: LoadedMcpServer | undefined
    try {
      loaded = await awaitLoadedServer(
        this.load(owner, definition, mcpServerNamespace(ownerId, serverName), signal),
        signal,
        this.onCleanupError,
      )
      signal?.throwIfAborted()
      const current = this.store.definition(owner, serverName)
      if (!current || fingerprintServer(current) !== expectedFingerprint) {
        throw new Error(`MCP server "${serverName}" changed since approval`)
      }
      this.store.activate(owner, serverName, loaded.fiber, loaded.tools)
      this.tracked.set(loaded.fiber, { owner, name: serverName })
      return loaded
    } catch (error) {
      if (loaded && !this.tracked.has(loaded.fiber)) {
        try {
          await loaded.fiber.dispose()
        } catch (disposeError) {
          throw new AggregateError(
            [error, disposeError],
            `MCP server "${serverName}" failed activation and cleanup`,
          )
        }
      }
      throw error
    }
  }

  async deactivate(owner: object, serverName: string): Promise<boolean> {
    const active = this.store.active(owner, serverName)
    if (!active) return false
    await active.fiber.dispose()
    this.store.deactivate(owner, serverName)
    this.tracked.delete(active.fiber)
    return true
  }

  async disposeOwner(owner: object): Promise<void> {
    const failures: unknown[] = []
    for (const [fiber, state] of [...this.tracked]) {
      if (state.owner !== owner) continue
      try {
        await fiber.dispose()
      } catch (error) {
        failures.push(error)
      } finally {
        if (this.store.active(owner, state.name)?.fiber === fiber) {
          this.store.deactivate(owner, state.name)
        }
        this.tracked.delete(fiber)
      }
    }
    if (failures.length) throw new AggregateError(failures, 'failed to dispose agent MCP servers')
  }

  async disposeAll(): Promise<void> {
    const failures: unknown[] = []
    for (const [fiber, state] of [...this.tracked]) {
      try {
        await fiber.dispose()
      } catch (error) {
        failures.push(error)
      } finally {
        if (this.store.active(state.owner, state.name)?.fiber === fiber) {
          this.store.deactivate(state.owner, state.name)
        }
        this.tracked.delete(fiber)
      }
    }
    if (failures.length) throw new AggregateError(failures, 'failed to dispose active MCP servers')
  }
}

function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new Error('mcp_control requires an active agent session')
  return exec.agent
}

function jsonSafe(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export class McpControlRuntime extends Service {
  static inject = ['tools', 'proposals', 'commands', 'systemPrompt']

  private readonly cachePath: string
  private readonly store: McpCatalogStore
  private readonly controller: McpActivationController
  private readonly lifecycle = new AbortController()
  private readonly owners = new WeakSet<Agent>()

  constructor(ctx: Context) {
    super(ctx, 'mcpControl')
    const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
    this.cachePath = join(dshHome, 'omd', 'mcp-cache.json')
    this.store = new McpCatalogStore(readMcpCache(this.cachePath))
    this.controller = new McpActivationController(
      this.store,
      (owner, definition, namespace, signal) =>
        this.loadServer(owner as Agent, definition, namespace, signal),
      (error) => ctx.logger.error(`oh-my-dsh: late MCP cleanup failed: ${String(error)}`),
    )
    ctx.effect(
      () => async () => {
        this.lifecycle.abort(new Error('omd-mcp-control unloaded'))
        await this.controller.disposeAll()
      },
      'omd-mcp-control.lifecycle',
    )

    ctx.systemPrompt.section({
      name: 'omd:mcp-control',
      order: 110,
      text: 'Imported MCP servers are inert. Use mcp_control list or search to inspect the catalog. Use prepare_activate to create an exact activation proposal; only proposal_control apply starts the server and exposes its tools. Deactivate servers when no longer needed.',
    })

    ctx.commands.register({
      name: 'omd-mcp',
      description: 'List inert and active MCP servers managed by oh-my-dsh.',
      input: { hint: 'optional search query' },
      recordInput: false,
      handler: ({ agent, rawInput }) => {
        const query = rawInput.trim()
        const entries = query ? searchCatalog(this.list(agent), query) : this.list(agent)
        return {
          kind: 'success',
          text: entries.length
            ? entries.map((entry) =>
              `${entry.name} [${entry.status}] ${entry.source} ${entry.transport} ${entry.endpoint}`).join('\n')
            : 'No matching MCP servers.',
        }
      },
    })

    ctx.tools.register(defineTool({
      name: 'mcp_control',
      description: 'List or search inert MCP servers, or prepare an approval-gated activation/deactivation proposal.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'search', 'prepare_activate', 'prepare_deactivate'],
          description: 'Catalog or proposal operation.',
        },
        query: {
          type: 'string',
          description: 'Search text for server names and cached tool metadata.',
        },
        server_name: {
          type: 'string',
          description: 'Catalog server name for activation or deactivation.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args, exec) => {
        const agent = requireAgent(exec)
        if (args.action === 'list') {
          return JSON.stringify({ servers: this.list(agent) }, null, 2)
        }
        if (args.action === 'search') {
          if (!args.query?.trim()) throw new Error('search requires query')
          return JSON.stringify({ servers: searchCatalog(this.list(agent), args.query) }, null, 2)
        }
        if (!args.server_name) throw new Error(`${args.action} requires server_name`)
        const view = this.list(agent).find((entry) => entry.name === args.server_name)
        if (!view) throw new Error(`unknown MCP server "${args.server_name}"`)
        if (args.action === 'prepare_activate') {
          if (view.status === 'active') throw new Error(`MCP server "${view.name}" is already active`)
          const approvedDefinition = this.store.definition(agent, view.name)
          if (!approvedDefinition) throw new Error(`unknown MCP server "${view.name}"`)
          const approvedFingerprint = fingerprintServer(approvedDefinition)
          const proposal = ctx.proposals.create(agent, {
            kind: 'mcp-activate',
            title: `Activate MCP server ${view.name}`,
            summary: `Start one ${view.transport} MCP server for this agent session and expose its discovered tools.`,
            effects: [{
              type: 'mcp-server-activation',
              target: view.name,
              summary: `Start ${view.endpoint}; expose tools only to session ${String(agent.id)}.`,
              details: jsonSafe(view),
            }],
            signal: this.lifecycle.signal,
            commit: async (commitExec) => {
              const activationSignal = AbortSignal.any([
                commitExec.signal,
                this.lifecycle.signal,
              ])
              const loaded = await this.controller.activate(
                agent,
                String(agent.id),
                view.name,
                approvedFingerprint,
                activationSignal,
              )
              try {
                const cacheEntry = this.store.cacheEntry(view.name)
                if (cacheEntry) {
                  await updateMcpCache(this.cachePath, { [view.name]: cacheEntry })
                }
              } catch (error) {
                this.ctx.logger.warn(`oh-my-dsh: could not update MCP metadata cache: ${String(error)}`)
              }
              return {
                summary: `Activated MCP server ${view.name} with ${loaded.tools.length} tool(s).`,
                details: jsonSafe({ server: view.name, tools: loaded.tools }),
              }
            },
          })
          return JSON.stringify({ proposal }, null, 2)
        }
        if (view.status !== 'active') throw new Error(`MCP server "${view.name}" is not active`)
        const proposal = ctx.proposals.create(agent, {
          kind: 'mcp-deactivate',
          title: `Deactivate MCP server ${view.name}`,
          summary: 'Disconnect the server and remove its tools from this agent session.',
          effects: [{
            type: 'mcp-server-deactivation',
            target: view.name,
            summary: `Disconnect ${view.endpoint} and unregister its tools.`,
            details: jsonSafe(view),
          }],
          signal: this.lifecycle.signal,
          commit: async () => ({
            summary: await this.controller.deactivate(agent, view.name)
              ? `Deactivated MCP server ${view.name}.`
              : `MCP server ${view.name} was already inactive.`,
          }),
        })
        return JSON.stringify({ proposal }, null, 2)
      },
    }))
  }

  configure(agent: Agent, definitions: McpServerDefinition[]): Promise<void> {
    if (!this.owners.has(agent)) {
      this.owners.add(agent)
      agent.ctx.effect(
        () => async () => {
          await this.controller.disposeOwner(agent)
        },
        `omd-mcp-control.owner.${String(agent.id)}`,
      )
    }
    return this.controller.configure(agent, definitions)
  }

  list(agent: Agent): McpCatalogView[] {
    return this.store.list(agent)
  }

  private async loadServer(
    agent: Agent,
    definition: McpServerDefinition,
    namespace: string,
    signal?: AbortSignal,
  ): Promise<LoadedMcpServer> {
    const fiber = agent.ctx.plugin(McpClient, materializeMcpConfig(definition, namespace))
    const prefix = `mcp__${namespace}__`
    return settleLoadedMcpFiber(
      fiber,
      () => agent.ctx.tools.schemas(agent)
        .filter((schema) => schema.name.startsWith(prefix))
        .map((schema) => ({
          name: schema.name.slice(prefix.length),
          description: schema.description,
        })),
      signal,
    )
  }
}

export default McpControlRuntime
