/**
 * Imports existing coding-agent configuration without copying or rewriting it:
 * always-on rules become one durable instruction message, compatible skills
 * join the dsh skill registry, and MCP server definitions mount the upstream
 * MCP bridge. Secrets stay in provider configuration and never enter prompts.
 * @module oh-my-dsh/discovery
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { symbols, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  Agent,
  AgentHandle,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import * as ClaudeHooks from '@deepseek-ai/dsh-hooks-claude-code'
import * as CodexHooks from '@deepseek-ai/dsh-hooks-codex'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { load as parseYaml } from 'js-yaml'
import { parse as parseToml } from 'smol-toml'
import type {
  McpControlRuntime,
  McpServerDefinition,
  McpServerSource,
} from '../../mcp-control/src/index.ts'

export const name = 'omd-discovery'
export const inject = ['agents', 'skills', 'tools', 'commands', 'shell', 'mcpControl']

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpControl: McpControlRuntime
  }
}

export interface Config {
  instructions?: boolean
  skills?: boolean
  mcp?: boolean
  hooks?: boolean
  commands?: boolean
  maxInstructionBytes?: number
}

export const Config: z<Config> = z.object({
  instructions: z.boolean().default(true),
  skills: z.boolean().default(true),
  mcp: z.boolean().default(true),
  hooks: z.boolean().default(true),
  commands: z.boolean().default(true),
  maxInstructionBytes: z.number().min(1024).default(65_536),
})

interface InstructionSource {
  path: string
  body: string
}

interface ForeignMcpServer {
  configPath?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
}

function safelyRead(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function gitRoot(start: string): string {
  let current = resolve(start)
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(start)
    current = parent
  }
}

function directoriesBetween(root: string, cwd: string): string[] {
  const output = [root]
  const suffix = relative(root, cwd)
  if (!suffix || suffix.startsWith('..')) return output
  let current = root
  for (const part of suffix.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    output.push(current)
  }
  return output
}

function stripMdcFrontmatter(content: string): { body: string; always: boolean } {
  if (!content.startsWith('---')) return { body: content.trim(), always: true }
  const end = content.indexOf('\n---', 3)
  if (end < 0) return { body: content.trim(), always: true }
  const raw = content.slice(3, end)
  let metadata: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>
    }
  } catch {
    return { body: '', always: false }
  }
  const body = content.slice(end + 4).trim()
  const scoped = typeof metadata.globs === 'string' && metadata.globs.trim().length > 0
  return {
    body,
    always: metadata.alwaysApply === true || (metadata.alwaysApply !== false && !scoped),
  }
}

function cursorRules(directory: string): InstructionSource[] {
  const root = join(directory, '.cursor', 'rules')
  if (!existsSync(root)) return []
  const output: InstructionSource[] = []
  const walk = (current: string, depth: number): void => {
    if (depth > 4 || output.length >= 128) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      if (!entry.isFile() || !entry.name.endsWith('.mdc')) continue
      const content = safelyRead(path)
      if (!content) continue
      const parsed = stripMdcFrontmatter(content)
      if (parsed.always && parsed.body) output.push({ path, body: parsed.body })
    }
  }
  walk(root, 0)
  return output
}

export function discoverInstructions(cwd: string, home = homedir()): InstructionSource[] {
  const root = gitRoot(cwd)
  const output: InstructionSource[] = []
  const add = (path: string, mdc = false): void => {
    const content = safelyRead(path)
    if (!content) return
    const parsed = mdc ? stripMdcFrontmatter(content) : { body: content.trim(), always: true }
    if (parsed.always && parsed.body) output.push({ path, body: parsed.body })
  }

  add(join(home, '.claude', 'CLAUDE.md'))
  add(join(home, '.codex', 'AGENTS.md'))
  output.push(...cursorRules(home))

  for (const directory of directoriesBetween(root, cwd)) {
    add(join(directory, '.cursorrules'))
    add(join(directory, '.github', 'copilot-instructions.md'))
    add(join(directory, '.codex', 'instructions.md'))
    output.push(...cursorRules(directory))
  }

  const seen = new Set<string>()
  return output.filter(({ body }) => {
    const key = body.trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function displayPath(path: string, cwd: string, home: string): string {
  if (path.startsWith(`${home}/`)) return `~/${relative(home, path)}`
  const local = relative(cwd, path)
  return local && !local.startsWith('..') ? local : path
}

export function renderInstructions(
  sources: InstructionSource[],
  cwd: string,
  maxBytes: number,
  home = homedir(),
): string {
  const selected: InstructionSource[] = []
  let bytes = 0
  for (const source of [...sources].reverse()) {
    const section = `Instructions from: ${displayPath(source.path, cwd, home)}\n\n${source.body}`
    const size = Buffer.byteLength(section)
    if (bytes + size > maxBytes) continue
    selected.push(source)
    bytes += size
  }
  if (!selected.length) return ''
  return [
    '<system-reminder>',
    'The following compatible coding-agent instructions are active. More specific files appear later and take precedence. They remain lower authority than system, developer, and direct user instructions.',
    '',
    ...selected
      .reverse()
      .flatMap((source) => [
        `Instructions from: ${displayPath(source.path, cwd, home)}`,
        '',
        source.body.replaceAll('</system-reminder>', '<\\/system-reminder>'),
        '',
      ]),
    '</system-reminder>',
  ].join('\n')
}

function normalizeServer(value: unknown, configPath?: string): ForeignMcpServer | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const command = typeof raw.command === 'string' ? raw.command : undefined
  const url = typeof raw.url === 'string' ? raw.url : undefined
  if (!command && !url) return undefined
  const strings = (input: unknown): Record<string, string> | undefined => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
    return Object.fromEntries(
      Object.entries(input).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  }
  return {
    configPath,
    command,
    url,
    args: Array.isArray(raw.args)
      ? raw.args.filter((item): item is string => typeof item === 'string')
      : undefined,
    env: strings(raw.env),
    headers: strings(raw.headers),
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    disabled: raw.disabled === true,
  }
}

function jsonServers(path: string): Record<string, ForeignMcpServer> {
  const content = safelyRead(path)
  if (!content) return {}
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    const container = parsed.mcpServers ?? parsed.servers
    if (!container || typeof container !== 'object' || Array.isArray(container)) return {}
    return Object.fromEntries(
      Object.entries(container)
        .map(([key, value]) => [key, normalizeServer(value, path)] as const)
        .filter((entry): entry is [string, ForeignMcpServer] => Boolean(entry[1])),
    )
  } catch {
    return {}
  }
}

function codexServers(path: string): Record<string, ForeignMcpServer> {
  const content = safelyRead(path)
  if (!content) return {}
  try {
    const parsed = parseToml(content) as Record<string, unknown>
    const container = parsed.mcp_servers
    if (!container || typeof container !== 'object' || Array.isArray(container)) return {}
    return Object.fromEntries(
      Object.entries(container)
        .map(([key, value]) => [key, normalizeServer(value, path)] as const)
        .filter((entry): entry is [string, ForeignMcpServer] => Boolean(entry[1])),
    )
  } catch {
    return {}
  }
}

function presetServers(home: string): Record<string, ForeignMcpServer> {
  const dshHome = resolve(process.env.DSH_HOME || join(home, '.dsh'))
  const content = safelyRead(join(dshHome, 'omd.json'))
  if (!content) return {}
  let enabled: string[] = []
  try {
    const parsed = JSON.parse(content) as { presets?: unknown }
    if (Array.isArray(parsed.presets)) {
      enabled = parsed.presets.filter((item): item is string => typeof item === 'string')
    }
  } catch {
    return {}
  }
  const output: Record<string, ForeignMcpServer> = {}
  if (enabled.includes('memory')) {
    output['omd-memory'] = {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory@2026.7.4'],
      env: { MEMORY_FILE_PATH: join(dshHome, 'memory.jsonl') },
    }
  }
  if (enabled.includes('context7')) {
    output['omd-context7'] = {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@4.0.2'],
    }
  }
  if (enabled.includes('playwright')) {
    output['omd-playwright'] = {
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.79'],
    }
  }
  return output
}

function userMcpServers(home: string): Record<string, ForeignMcpServer> {
  return {
    ...presetServers(home),
    ...jsonServers(join(home, '.claude.json')),
    ...jsonServers(join(home, '.cursor', 'mcp.json')),
    ...codexServers(join(home, '.codex', 'config.toml')),
  }
}

function projectMcpServers(cwd: string): Record<string, ForeignMcpServer> {
  const root = gitRoot(cwd)
  return {
    ...jsonServers(join(root, '.mcp.json')),
    ...jsonServers(join(root, '.claude', 'mcp.json')),
    ...jsonServers(join(root, '.cursor', 'mcp.json')),
    ...codexServers(join(root, '.codex', 'config.toml')),
  }
}

function hasProjectMcpConfig(cwd: string): boolean {
  const root = gitRoot(cwd)
  return [
    join(root, '.mcp.json'),
    join(root, '.claude', 'mcp.json'),
    join(root, '.cursor', 'mcp.json'),
    join(root, '.codex', 'config.toml'),
  ].some((path) => existsSync(path))
}

export function discoverMcpServers(
  cwd: string,
  home = homedir(),
): Record<string, ForeignMcpServer> {
  return { ...userMcpServers(home), ...projectMcpServers(cwd) }
}

function catalogDefinitions(
  servers: Record<string, ForeignMcpServer>,
  source: McpServerSource,
  cwd: string,
): McpServerDefinition[] {
  const definitions: McpServerDefinition[] = []
  for (const [serverName, server] of Object.entries(servers)) {
    if (server.disabled) continue
    if (server.command) {
      definitions.push({
        name: serverName,
        source,
        configPath: server.configPath,
        transport: 'stdio',
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: server.cwd ?? cwd,
      })
    } else if (server.url) {
      definitions.push({
        name: serverName,
        source,
        configPath: server.configPath,
        transport: 'streamable-http',
        url: server.url,
        headers: server.headers,
      })
    }
  }
  return definitions
}

export function discoverMcpCatalog(
  cwd: string,
  home = homedir(),
  trusted = isTrustedWorkspace(cwd, home),
): McpServerDefinition[] {
  const user = {
    ...jsonServers(join(home, '.claude.json')),
    ...jsonServers(join(home, '.cursor', 'mcp.json')),
    ...codexServers(join(home, '.codex', 'config.toml')),
  }
  const byName = new Map<string, McpServerDefinition>()
  for (const definition of catalogDefinitions(presetServers(home), 'preset', cwd)) {
    byName.set(definition.name, definition)
  }
  for (const definition of catalogDefinitions(user, 'user', cwd)) {
    byName.set(definition.name, definition)
  }
  if (trusted) {
    for (const definition of catalogDefinitions(projectMcpServers(cwd), 'project', cwd)) {
      byName.set(definition.name, definition)
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function normalizeMcpServerName(input: string): string {
  const normalized = input.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '')
  const base = normalized || 'imported'
  if (base === input && base.length <= 32) return base
  const hash = createHash('sha256').update(input).digest('hex').slice(0, 8)
  return `${base.slice(0, 23)}-${hash}`
}

function userSkillDirectories(home: string): string[] {
  const bundled = fileURLToPath(new URL('../../../../presets/skills', import.meta.url))
  return [
    bundled,
    join(home, '.claude', 'skills'),
    join(home, '.cursor', 'skills'),
    join(home, '.codex', 'skills'),
  ]
}

function projectSkillDirectories(cwd: string): string[] {
  const root = gitRoot(cwd)
  return [
    join(root, '.claude', 'skills'),
    join(root, '.cursor', 'skills'),
    join(root, '.codex', 'skills'),
  ]
}

interface ForeignCommand {
  name: string
  description: string
  body: string
  path: string
}

function commandFiles(directory: string): ForeignCommand[] {
  if (!existsSync(directory)) return []
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => {
      const path = join(directory, entry.name)
      const content = safelyRead(path)?.trim() ?? ''
      const rawName = basename(entry.name, '.md').toLowerCase()
      const commandName = rawName.replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '')
      const firstText = content
        .split('\n')
        .map((line) => line.replace(/^#+\s*/, '').trim())
        .find((line) => line && line !== '---')
      return {
        name: commandName,
        description: (firstText || `Imported command from ${entry.name}`).slice(0, 160),
        body: content,
        path,
      }
    })
    .filter((command) => command.name && command.body)
}

function commandsIn(directories: string[]): ForeignCommand[] {
  const byName = new Map<string, ForeignCommand>()
  for (const directory of directories) {
    for (const command of commandFiles(directory)) byName.set(command.name, command)
  }
  return [...byName.values()]
}

function userCommands(home: string): ForeignCommand[] {
  return commandsIn([
    join(home, '.claude', 'commands'),
    join(home, '.cursor', 'commands'),
    join(home, '.codex', 'prompts'),
  ])
}

function projectCommands(cwd: string): ForeignCommand[] {
  const root = gitRoot(cwd)
  return commandsIn([
    join(root, '.claude', 'commands'),
    join(root, '.cursor', 'commands'),
    join(root, '.codex', 'prompts'),
  ])
}

function userHookConfigPaths(home: string): {
  claude: string[]
  codex: string[]
} {
  return {
    claude: [join(home, '.claude', 'settings.json'), join(home, '.claude', 'hooks.json')].filter(
      existsSync,
    ),
    codex: [join(home, '.codex', 'hooks.json')].filter(existsSync),
  }
}

function projectHookConfigPaths(cwd: string): {
  claude: string[]
  codex: string[]
} {
  const root = gitRoot(cwd)
  return {
    claude: [join(root, '.claude', 'settings.json'), join(root, '.claude', 'hooks.json')].filter(
      existsSync,
    ),
    codex: [join(root, '.codex', 'hooks.json')].filter(existsSync),
  }
}

export function isTrustedWorkspace(cwd: string, home: string): boolean {
  const dshHome = resolve(process.env.DSH_HOME || join(home, '.dsh'))
  const content = safelyRead(join(dshHome, 'omd.json'))
  if (!content) return false
  try {
    const parsed = JSON.parse(content) as { trustedWorkspaces?: unknown }
    if (!Array.isArray(parsed.trustedWorkspaces)) return false
    const root = resolve(gitRoot(cwd))
    return parsed.trustedWorkspaces.some(
      (entry) => typeof entry === 'string' && resolve(entry) === root,
    )
  } catch {
    return false
  }
}

function mountHooks(
  scope: Context,
  paths: { claude: string[]; codex: string[] },
): PromiseLike<unknown>[] {
  return [
    ...paths.claude.map((configPath) => scope.plugin(ClaudeHooks, { configPath })),
    ...paths.codex.map((configPath) => scope.plugin(CodexHooks, { configPath })),
  ]
}

function registerCommands(
  scope: Context,
  commands: ForeignCommand[],
  workspace: string,
  home: string,
): void {
  for (const command of commands) {
    try {
      scope.commands.register({
        name: command.name,
        description: command.description,
        input: { hint: 'arguments' },
        handler: ({ agent, rawInput }) => {
          const args = rawInput.trim()
          const prompt = command.body.replaceAll('$ARGUMENTS', args).replaceAll('{{args}}', args)
          agent.followup(
            createUserMessage({
              content: [
                {
                  type: 'text',
                  text: [
                    '<imported-command>',
                    `Source: ${displayPath(command.path, workspace, home)}`,
                    '',
                    prompt,
                    '</imported-command>',
                  ].join('\n'),
                },
              ],
              source: { kind: 'plugin', plugin: name, form: 'instructions' },
            }),
          )
          return { kind: 'success', text: `Started /${command.name}.` }
        },
      })
    } catch {
      // A native or nearer-scoped dsh command wins a name collision.
    }
  }
}

interface AgentRegistryApi {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
}

function withSetup<T extends { setup?: AgentSetup }>(options: T, configure: AgentSetup): T {
  const existing = options.setup
  return {
    ...options,
    setup: async (agentCtx) => {
      const commit = await existing?.(agentCtx)
      await configure(agentCtx)
      return commit
    },
  }
}

function installAgentSetup(ctx: Context, configure: AgentSetup): void {
  const traced = ctx.agents as AgentRegistryApi
  const service = ((traced as unknown as Record<PropertyKey, unknown>)[symbols.original] ??
    traced) as AgentRegistryApi
  const originalCreate = service.create
  const originalResume = service.resume
  const create = function (
    this: AgentRegistryApi,
    options: CreateAgentOptions,
  ): Promise<AgentHandle> {
    return originalCreate.call(this, withSetup(options, configure))
  }
  const resume = function (
    this: AgentRegistryApi,
    options: ResumeAgentOptions,
  ): Promise<AgentHandle> {
    return originalResume.call(this, withSetup(options, configure))
  }
  service.create = create
  service.resume = resume
  ctx.effect(
    () => () => {
      if (service.create === create) service.create = originalCreate
      if (service.resume === resume) service.resume = originalResume
    },
    'omd-discovery.agent-setup',
  )
}

export function apply(ctx: Context, config: Config): void {
  const launchCwd = process.cwd()
  const home = homedir()
  const configured = new WeakSet<object>()

  if (config.skills !== false) {
    ctx.plugin(SkillFilesystem, {
      providerName: 'omd-discovered-user',
      includeDefaultRoots: false,
      customSkillDirs: userSkillDirectories(home),
      watch: true,
    })
  }
  if (config.hooks !== false) mountHooks(ctx, userHookConfigPaths(home))
  if (config.commands !== false) registerCommands(ctx, userCommands(home), home, home)

  const configureAgent = async (agentCtx: Context): Promise<void> => {
    const scoped = scopeOf(agentCtx)
    if (!scoped || typeof scoped !== 'object' || !('session' in scoped)) {
      throw new Error('oh-my-dsh: agent setup did not receive an agent-scoped context')
    }
    const agent = scoped as Agent
    const workspace = agent.session.header.cwd ?? launchCwd

    if (config.instructions !== false) {
      const alreadyLoaded = agent.session.events.some(
        (event) =>
          event.type === 'user/message' &&
          event.data.source.kind === 'plugin' &&
          event.data.source.plugin === name,
      )
      if (!alreadyLoaded) {
        const sources = discoverInstructions(workspace, home)
        const text = renderInstructions(
          sources,
          workspace,
          config.maxInstructionBytes ?? 65_536,
          home,
        )
        if (text) {
          agent.inject(
            createUserMessage({
              content: [{ type: 'text', text }],
              source: { kind: 'plugin', plugin: name, form: 'instructions' },
            }),
          )
        }
      }
    }

    if (config.commands !== false) {
      registerCommands(agent.ctx, projectCommands(workspace), workspace, home)
    }

    const trusted = isTrustedWorkspace(workspace, home)
    await agentCtx.mcpControl.configure(
      agent,
      config.mcp === false ? [] : discoverMcpCatalog(workspace, home, trusted),
    )
    if (!trusted) {
      const projectHooks = projectHookConfigPaths(workspace)
      const hasExecutableConfig =
        (config.mcp !== false && hasProjectMcpConfig(workspace)) ||
        (config.hooks !== false && projectHooks.claude.length + projectHooks.codex.length > 0) ||
        (config.skills !== false &&
          projectSkillDirectories(workspace).some((directory) => existsSync(directory)))
      if (hasExecutableConfig) {
        console.warn(
          `oh-my-dsh: skipped imported project integrations in untrusted workspace ${gitRoot(workspace)}; run "omd trust add ${JSON.stringify(gitRoot(workspace))}" to enable them.`,
        )
      }
      configured.add(agent)
      return
    }

    const fibers: PromiseLike<unknown>[] = []
    if (config.skills !== false) {
      fibers.push(
        agentCtx.plugin(SkillFilesystem, {
          providerName: 'omd-discovered-project',
          includeDefaultRoots: false,
          customSkillDirs: projectSkillDirectories(workspace),
          watch: true,
        }),
      )
    }
    if (config.hooks !== false) {
      fibers.push(...mountHooks(agentCtx, projectHookConfigPaths(workspace)))
    }
    await Promise.all(fibers)
    configured.add(agent)
  }

  installAgentSetup(ctx, configureAgent)
  ctx.on('agent/created', ({ agent }) => {
    if (configured.has(agent)) return
    void configureAgent(agent.ctx).catch((error) => {
      ctx.logger.warn(`oh-my-dsh: late agent discovery failed: ${String(error)}`)
    })
  })
}
