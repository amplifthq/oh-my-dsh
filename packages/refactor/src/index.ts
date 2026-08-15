import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FsError, FsVersion, type FsTarget } from '@deepseek-ai/dsh-fs'
import { LspConnection } from '@deepseek-ai/dsh-lsp-stdio'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { ProposalRuntime } from '../../proposals/src/index.ts'
import {
  applyWithRollback,
  planJournalRecovery,
  readRefactorJournal,
  writeRefactorJournal,
  type RefactorJournal,
  type VersionedFileChange,
} from './journal.js'
import {
  answerLspServerRequest,
  executeOneShotDiagnostics,
  executeOneShotRename,
  raceWithAbort,
} from './lsp-client.js'
import {
  buildRefactorFilePlans,
  decodeRefactorText,
  RefactorReadBudget,
  type RefactorFilePlan,
} from './planner.js'
import { normalizeWorkspaceEdit } from './workspace-edit.js'

export const name = 'omd-refactor'

export interface Config {
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  maxDiagnosticsFiles?: number
  renameTimeoutMs?: number
  diagnosticsTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  maxFiles: z.number().min(1).default(100),
  maxFileBytes: z.number().min(1024).default(2_000_000),
  maxTotalBytes: z.number().min(1024).default(16_000_000),
  maxDiagnosticsFiles: z.number().min(1).default(20),
  renameTimeoutMs: z.number().min(1000).default(60_000),
  diagnosticsTimeoutMs: z.number().min(1000).default(15_000),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    refactors: RefactorRuntime
    proposals: ProposalRuntime
  }
}

export interface RefactorServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  extensionToLanguage: Record<string, string>
  initializationOptions?: unknown
  configuration?: unknown
  maxMessageBytes?: number
  maxStderrBytes?: number
  killGraceMs?: number
}

export interface RefactorServerRoute {
  id: string
  languageId: string
  config: RefactorServerConfig
}

function finalExtension(path: string): string {
  const filename = path.split(/[\\/]/).at(-1) ?? ''
  const index = filename.lastIndexOf('.')
  return index <= 0 ? '' : filename.slice(index).toLowerCase()
}

export class RefactorServerRegistry {
  private readonly routes = new Map<string, RefactorServerRoute>()

  register(id: string, config: RefactorServerConfig): () => void {
    if (!id.trim()) throw new Error('refactor server id must not be empty')
    const extensions = Object.keys(config.extensionToLanguage)
    if (!extensions.length) throw new Error(`refactor server "${id}" has no extensions`)
    for (const extension of extensions) {
      const normalized = extension.toLowerCase()
      if (!normalized.startsWith('.')) {
        throw new Error(`refactor extension "${extension}" must start with "."`)
      }
      const existing = this.routes.get(normalized)
      if (existing) {
        throw new Error(
          `refactor extension "${normalized}" is already registered by ${existing.id}`,
        )
      }
    }
    for (const [extension, languageId] of Object.entries(config.extensionToLanguage)) {
      this.routes.set(extension.toLowerCase(), {
        id,
        languageId,
        config: structuredClone(config),
      })
    }
    return () => {
      for (const extension of extensions) {
        const normalized = extension.toLowerCase()
        if (this.routes.get(normalized)?.id === id) this.routes.delete(normalized)
      }
    }
  }

  resolve(path: string): RefactorServerRoute | undefined {
    const route = this.routes.get(finalExtension(path))
    return route && structuredClone(route)
  }
}

class RefactorMutationPolicy {
  private readonly policy: SandboxPolicyService | undefined

  constructor(ctx: Context) {
    this.policy = ctx.fs.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy')
    if (ctx.fs.sandboxMode !== undefined && this.policy === undefined) {
      throw new Error('omd-refactor: confined filesystem requires ctx.sandboxPolicy')
    }
  }

  resolve(exec: ToolRunContext): SandboxExecutionPolicy | undefined {
    return this.policy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
  }

  mapError(error: unknown, policy: SandboxExecutionPolicy | undefined): unknown {
    if (!(error instanceof FsError) || error.code !== 'FS_SANDBOX_DENIED') return error
    return new FsError(
      sandboxDenialMarker((policy as SandboxExecutionPolicy).mode),
      'FS_SANDBOX_DENIED',
      { cause: error },
    )
  }
}

interface RuntimeFilePlan extends RefactorFilePlan<FsTarget> {}

function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new Error('semantic_refactor requires an active agent session')
  return exec.agent
}

function jsonSafe(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function sameVersion(left: string, right: string): boolean {
  return left === right
}

export class RefactorRuntime extends Service {
  static inject = ['tools', 'fs', 'subprocess', 'proposals', 'systemPrompt']
  static Config = Config

  private readonly registry = new RefactorServerRegistry()
  private readonly mutationPolicy: RefactorMutationPolicy
  private readonly journalDirectory: string
  private readonly lifecycle = new AbortController()
  private readonly config: Required<Config>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'refactors')
    this.mutationPolicy = new RefactorMutationPolicy(ctx)
    this.config = {
      maxFiles: config.maxFiles ?? 100,
      maxFileBytes: config.maxFileBytes ?? 2_000_000,
      maxTotalBytes: config.maxTotalBytes ?? 16_000_000,
      maxDiagnosticsFiles: config.maxDiagnosticsFiles ?? 20,
      renameTimeoutMs: config.renameTimeoutMs ?? 60_000,
      diagnosticsTimeoutMs: config.diagnosticsTimeoutMs ?? 15_000,
    }
    const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
    this.journalDirectory = join(dshHome, 'omd', 'refactors')
    ctx.effect(
      () => () => this.lifecycle.abort(new Error('omd-refactor unloaded')),
      'omd-refactor.lifecycle',
    )

    ctx.systemPrompt.section({
      name: 'omd:semantic-refactor',
      order: 112,
      text: 'Use semantic_refactor prepare_rename for cross-file symbol renames. It returns an exact, version-guarded proposal. Inspect every effect and apply it only through proposal_control. If a prior transaction reports incomplete rollback, inspect list_recovery and prepare a recovery proposal before editing those files.',
    })

    ctx.tools.register(
      defineTool({
        name: 'semantic_refactor',
        description:
          'Prepare a recoverable LSP symbol rename, list incomplete recovery journals, or prepare a guarded recovery proposal.',
        parameters: {
          action: {
            type: 'string',
            required: true,
            enum: ['prepare_rename', 'list_recovery', 'prepare_recovery'],
            description: 'Refactor operation.',
          },
          file_path: {
            type: 'string',
            description: 'Symbol file path, absolute or relative to the session workspace.',
          },
          line: {
            type: 'integer',
            description: 'One-based symbol line for prepare_rename.',
          },
          column: {
            type: 'integer',
            description: 'One-based UTF position column for prepare_rename.',
          },
          new_name: {
            type: 'string',
            description: 'New symbol name for prepare_rename.',
          },
          journal_id: {
            type: 'string',
            description: 'Recovery journal id returned by list_recovery.',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args, exec) => {
          const agent = requireAgent(exec)
          if (args.action === 'list_recovery') {
            return JSON.stringify({ journals: this.listRecovery(agent) }, null, 2)
          }
          if (args.action === 'prepare_recovery') {
            if (!args.journal_id) throw new Error('prepare_recovery requires journal_id')
            return JSON.stringify(
              {
                proposal: await this.prepareRecovery(agent, args.journal_id, exec),
              },
              null,
              2,
            )
          }
          if (
            !args.file_path ||
            !Number.isInteger(args.line) ||
            (args.line as number) < 1 ||
            !Number.isInteger(args.column) ||
            (args.column as number) < 1 ||
            !args.new_name?.trim()
          ) {
            throw new Error(
              'prepare_rename requires file_path, positive line/column, and non-empty new_name',
            )
          }
          return JSON.stringify(
            {
              proposal: await this.prepareRename(
                agent,
                args.file_path,
                args.line as number,
                args.column as number,
                args.new_name,
                exec,
              ),
            },
            null,
            2,
          )
        },
      }),
    )
  }

  registerServer(id: string, config: RefactorServerConfig): () => void {
    return this.registry.register(id, config)
  }

  private async prepareRename(
    agent: Agent,
    filePath: string,
    line: number,
    column: number,
    newName: string,
    exec: ToolRunContext,
  ) {
    const prepareSignal = AbortSignal.any([
      exec.signal,
      this.lifecycle.signal,
      AbortSignal.timeout(this.config.renameTimeoutMs),
    ])
    const guardedExec = { ...exec, signal: prepareSignal }
    const cwd = resolve(agent.session.header.cwd ?? process.cwd())
    const workspaceTarget = await this.ctx.fs.resolve(cwd, { signal: prepareSignal })
    const sourceTarget = await this.ctx.fs.resolve(filePath, { cwd, signal: prepareSignal })
    if (!this.ctx.fs.contains(workspaceTarget, sourceTarget)) {
      throw new Error('semantic refactors are limited to the session workspace')
    }
    const budget = new RefactorReadBudget({
      maxFiles: this.config.maxFiles,
      maxFileBytes: this.config.maxFileBytes,
      maxTotalBytes: this.config.maxTotalBytes,
    })
    const source = await this.readFile(sourceTarget, guardedExec, budget)
    const sourceContent = source.content
    const route = this.registry.resolve(sourceTarget.displayPath)
    if (!route) throw new Error(`no semantic refactor server for ${sourceTarget.displayPath}`)
    const workspaceUri = this.ctx.fs.fileUrl(workspaceTarget)
    const documentUri = this.ctx.fs.fileUrl(sourceTarget)
    const discoveryResult = await this.withConnection(
      route.config,
      this.ctx.fs.processPath(workspaceTarget),
      workspaceUri,
      (connection) =>
        executeOneShotRename(connection, {
          processId: process.pid,
          workspaceUri,
          documentUri,
          languageId: route.languageId,
          content: sourceContent,
          position: { line: line - 1, character: column - 1 },
          newName,
          initializationOptions: route.config.initializationOptions,
        }),
      prepareSignal,
    )
    const discoveryDocuments = normalizeWorkspaceEdit(discoveryResult.workspaceEdit)
    if (!discoveryDocuments.length) {
      throw new Error('language server rename produced no text changes')
    }
    if (discoveryDocuments.length > this.config.maxFiles) {
      throw new Error(`semantic refactor touches more than ${this.config.maxFiles} files`)
    }
    const sourceUri = new URL(documentUri).toString()
    const snapshots = new Map<
      string,
      {
        target: FsTarget
        path: string
        content: string
        version: string
        languageId: string
      }
    >()
    snapshots.set(sourceUri, {
      target: sourceTarget,
      path: sourceTarget.displayPath,
      content: sourceContent,
      version: String(source.info.version),
      languageId: route.languageId,
    })
    for (const document of discoveryDocuments) {
      if (document.uri === sourceUri) continue
      const snapshot = await this.readWorkspaceDocument(
        document.uri,
        workspaceTarget,
        cwd,
        guardedExec,
        budget,
      )
      snapshots.set(document.uri, {
        ...snapshot,
        languageId: this.registry.resolve(snapshot.path)?.languageId ?? route.languageId,
      })
    }
    const result = await this.withConnection(
      route.config,
      this.ctx.fs.processPath(workspaceTarget),
      workspaceUri,
      (connection) =>
        executeOneShotRename(connection, {
          processId: process.pid,
          workspaceUri,
          documentUri,
          languageId: route.languageId,
          content: sourceContent,
          additionalDocuments: [...snapshots.entries()]
            .filter(([uri]) => uri !== sourceUri)
            .map(([uri, snapshot]) => ({
              documentUri: uri,
              languageId: snapshot.languageId,
              content: snapshot.content,
            })),
          position: { line: line - 1, character: column - 1 },
          newName,
          initializationOptions: route.config.initializationOptions,
        }),
      prepareSignal,
    )
    const documents = normalizeWorkspaceEdit(result.workspaceEdit)
    if (documents.length > this.config.maxFiles) {
      throw new Error(`semantic refactor touches more than ${this.config.maxFiles} files`)
    }
    for (const document of documents) {
      if (!snapshots.has(document.uri)) {
        throw new Error(
          `language server rename target set changed after snapshotting: ${document.uri}`,
        )
      }
      if (document.version !== null && document.version !== 1) {
        throw new Error(
          `language server returned unexpected open-document version ${document.version}`,
        )
      }
    }
    const plans = (await buildRefactorFilePlans(documents, result.encoding, async (uri) => {
      const snapshot = snapshots.get(uri)
      if (!snapshot) throw new Error(`missing refactor snapshot for ${uri}`)
      return snapshot
    })) as RuntimeFilePlan[]
    if (!plans.length) throw new Error('language server rename produced no text changes')

    const refactorId = `refactor-${randomUUID()}`
    const journalPath = this.journalPath(refactorId)
    return this.ctx.proposals.create(agent, {
      kind: 'lsp-refactor',
      title: `Rename symbol to ${newName}`,
      summary: `Apply ${plans.reduce((sum, plan) => sum + plan.edits.length, 0)} semantic edit(s) across ${plans.length} file(s), then request diagnostics.`,
      effects: plans.map((plan) => ({
        type: 'lsp-workspace-edit',
        target: plan.path,
        summary: `${plan.edits.length} edit(s); before ${shortHash(plan.before)}, after ${shortHash(plan.after)}.`,
        details: jsonSafe({
          edits: plan.edits,
          beforeHash: shortHash(plan.before),
          afterHash: shortHash(plan.after),
        }),
      })),
      signal: this.lifecycle.signal,
      commit: async (commitExec) => {
        const commitSignal = AbortSignal.any([commitExec.signal, this.lifecycle.signal])
        const guardedCommit = { ...commitExec, signal: commitSignal }
        await this.preflight(plans, guardedCommit)
        const applyResult = await this.applyPlans(
          plans,
          cwd,
          journalPath,
          refactorId,
          guardedCommit,
        )
        const diagnostics = await this.verifyDiagnostics(plans, workspaceTarget)
        return {
          summary: `Applied semantic rename across ${plans.length} file(s).`,
          details: jsonSafe({
            refactorId,
            diagnostics,
            journalCleanupWarning: applyResult.warning,
          }),
        }
      },
    })
  }

  private async readWorkspaceDocument(
    uri: string,
    workspaceTarget: FsTarget,
    cwd: string,
    exec: ToolRunContext,
    budget: RefactorReadBudget,
  ) {
    let path: string
    try {
      path = fileURLToPath(uri)
    } catch {
      throw new Error(`language server returned unsupported document URI ${uri}`)
    }
    const target = await this.ctx.fs.resolve(path, { cwd, signal: exec.signal })
    if (!this.ctx.fs.contains(workspaceTarget, target)) {
      throw new Error(`language server edit escapes the workspace: ${target.displayPath}`)
    }
    const state = await this.readFile(target, exec, budget)
    return {
      target,
      path: target.displayPath,
      content: state.content,
      version: String(state.info.version),
    }
  }

  private async readFile(target: FsTarget, exec: ToolRunContext, budget: RefactorReadBudget) {
    const info = await this.requireFile(target, exec)
    if (info.size !== undefined) budget.accept(target.displayPath, info.size)
    const bytes = await this.ctx.fs.readBytes(target, exec.signal, this.config.maxFileBytes)
    budget.accept(target.displayPath, bytes.byteLength)
    let content: string
    try {
      content = decodeRefactorText(bytes, target.displayPath)
    } catch (error) {
      throw new FsError(`file is not valid UTF-8 text: ${target.displayPath}`, 'FS_NOT_TEXT', {
        cause: error,
      })
    }
    this.ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    return { info, content }
  }

  private async requireFile(target: FsTarget, exec: ToolRunContext) {
    const info = await this.ctx.fs.stat(target, exec.signal)
    if (!info) throw new FsError(`file not found: ${target.displayPath}`, 'FS_NOT_FOUND')
    if (info.type !== 'file') {
      throw new FsError(`not a regular file: ${target.displayPath}`, 'FS_NOT_REGULAR_FILE')
    }
    return info
  }

  private async preflight(plans: RuntimeFilePlan[], exec: ToolRunContext): Promise<void> {
    const budget = new RefactorReadBudget({
      maxFiles: this.config.maxFiles,
      maxFileBytes: this.config.maxFileBytes,
      maxTotalBytes: this.config.maxTotalBytes,
    })
    for (const plan of plans) {
      const state = await this.readFile(plan.target, exec, budget)
      if (!sameVersion(String(state.info.version), plan.version) || state.content !== plan.before) {
        throw new FsError(
          `stale refactor plan for ${plan.path}; prepare the rename again`,
          'FS_STALE_VERSION',
        )
      }
    }
  }

  private async applyPlans(
    plans: RuntimeFilePlan[],
    cwd: string,
    journalPath: string,
    refactorId: string,
    exec: ToolRunContext,
  ): ReturnType<typeof applyWithRollback> {
    const sandboxPolicy = this.mutationPolicy.resolve(exec)
    const versioned: VersionedFileChange[] = plans.map((plan) => ({
      path: plan.path,
      before: plan.before,
      after: plan.after,
      version: plan.version,
    }))
    const targets = new Map(plans.map((plan) => [plan.path, plan.target]))
    try {
      return await applyWithRollback(versioned, {
        saveJournal: (_files, status) =>
          writeRefactorJournal(journalPath, {
            version: 1,
            id: refactorId,
            cwd,
            status,
            files: versioned.map(({ path, before, after }) => ({ path, before, after })),
          }),
        clearJournal: () => rmSync(journalPath, { force: true }),
        write: async (file, content, expectedVersion, phase) => {
          const target = targets.get(file.path)
          if (!target) throw new Error(`missing refactor target ${file.path}`)
          const outcome = await this.ctx.fs.writeText(
            target,
            content,
            { kind: 'replaceIfVersion', version: FsVersion(expectedVersion) },
            phase === 'apply' ? exec.signal : undefined,
            sandboxPolicy,
          )
          return String(outcome.version)
        },
        afterWrite: (file, version) => {
          const target = targets.get(file.path)
          if (!target) throw new Error(`missing refactor target ${file.path}`)
          this.ctx.emit(
            'fs/observed',
            target,
            {
              kind: 'present',
              version: FsVersion(version),
            },
            exec,
          )
        },
      })
    } catch (error) {
      throw this.mutationPolicy.mapError(error, sandboxPolicy)
    }
  }

  private listRecovery(agent: Agent) {
    const cwd = resolve(agent.session.header.cwd ?? process.cwd())
    if (!existsSync(this.journalDirectory)) return []
    return readdirSync(this.journalDirectory)
      .filter((entry) => entry.endsWith('.json'))
      .flatMap((entry) => {
        try {
          const journal = readRefactorJournal(join(this.journalDirectory, entry))
          if (resolve(journal.cwd) !== cwd) return []
          return [
            {
              id: journal.id,
              status: journal.status,
              files: journal.files.map((file) => file.path),
            },
          ]
        } catch {
          return []
        }
      })
  }

  private async prepareRecovery(agent: Agent, journalId: string, exec: ToolRunContext) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(journalId)) throw new Error('invalid journal_id')
    const path = this.journalPath(journalId)
    const journal = readRefactorJournal(path)
    const cwd = resolve(agent.session.header.cwd ?? process.cwd())
    if (resolve(journal.cwd) !== cwd)
      throw new Error('recovery journal belongs to another workspace')
    const workspaceTarget = await this.ctx.fs.resolve(cwd, { signal: exec.signal })
    const currentContents: Record<string, string> = {}
    const states = new Map<string, { target: FsTarget; version: string }>()
    const budget = new RefactorReadBudget({
      maxFiles: this.config.maxFiles,
      maxFileBytes: this.config.maxFileBytes,
      maxTotalBytes: this.config.maxTotalBytes,
    })
    for (const file of journal.files) {
      const target = await this.ctx.fs.resolve(file.path, { cwd, signal: exec.signal })
      if (!this.ctx.fs.contains(workspaceTarget, target)) {
        throw new Error(`recovery target escapes the workspace: ${target.displayPath}`)
      }
      const state = await this.readFile(target, exec, budget)
      currentContents[file.path] = state.content
      states.set(file.path, { target, version: String(state.info.version) })
    }
    const recovery = planJournalRecovery(journal, currentContents)
    if (!recovery.length) {
      rmSync(path, { force: true })
      throw new Error('journal files are already restored; removed the stale journal')
    }
    const recoveryId = `recovery-${randomUUID()}`
    return this.ctx.proposals.create(agent, {
      kind: 'lsp-recovery',
      title: `Recover refactor ${journal.id}`,
      summary: `Restore ${recovery.length} file(s) that still exactly match the interrupted refactor output.`,
      effects: recovery.map((item) => ({
        type: 'lsp-recovery',
        target: item.path,
        summary: `Restore original content ${shortHash(item.content)}.`,
      })),
      signal: this.lifecycle.signal,
      commit: async (commitExec) => {
        const plans: RuntimeFilePlan[] = recovery.map((item) => {
          const state = states.get(item.path) as { target: FsTarget; version: string }
          return {
            target: state.target,
            path: item.path,
            before: currentContents[item.path] as string,
            after: item.content,
            version: state.version,
            edits: [],
          }
        })
        const commitSignal = AbortSignal.any([commitExec.signal, this.lifecycle.signal])
        const guardedCommit = { ...commitExec, signal: commitSignal }
        await this.preflight(plans, guardedCommit)
        const applyResult = await this.applyPlans(
          plans,
          cwd,
          this.journalPath(recoveryId),
          recoveryId,
          guardedCommit,
        )
        const warnings = applyResult.warning ? [applyResult.warning] : []
        try {
          rmSync(path, { force: true })
        } catch (error) {
          warnings.push(`could not remove source recovery journal: ${String(error)}`)
        }
        return {
          summary: `Recovered ${recovery.length} file(s) from ${journal.id}.`,
          details: warnings.length ? jsonSafe({ journalCleanupWarnings: warnings }) : undefined,
        }
      },
    })
  }

  private journalPath(id: string): string {
    return join(this.journalDirectory, `${basename(id)}.json`)
  }

  private createConnection(
    config: RefactorServerConfig,
    cwd: string,
    workspaceUri: string,
  ): LspConnection {
    return new LspConnection(
      {
        command: config.command,
        args: config.args ?? [],
        cwd,
        env: config.env ?? {},
        maxMessageBytes: config.maxMessageBytes ?? 16_000_000,
        maxStderrBytes: config.maxStderrBytes ?? 1_000_000,
        killGraceMs: config.killGraceMs ?? 2_000,
        configuration: config.configuration ?? null,
      },
      (spec) => this.ctx.subprocess.spawn(spec),
      (method, params) =>
        answerLspServerRequest(method, params, {
          configuration: config.configuration ?? null,
          workspaceFolders: [
            {
              uri: workspaceUri,
              name: basename(cwd) || 'workspace',
            },
          ],
        }),
    )
  }

  private async withConnection<T>(
    config: RefactorServerConfig,
    cwd: string,
    workspaceUri: string,
    operation: (connection: LspConnection) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted()
    const connection = this.createConnection(config, cwd, workspaceUri)
    try {
      return await raceWithAbort(operation(connection), signal, 'LSP operation')
    } finally {
      const closed = await connection.waitForProcessTreeExit(AbortSignal.timeout(5_000))
      if (!closed) {
        connection.terminate()
        await connection.waitForProcessTreeExit(AbortSignal.timeout(5_000))
      }
    }
  }

  private async verifyDiagnostics(
    plans: RuntimeFilePlan[],
    workspaceTarget: FsTarget,
  ): Promise<JsonValue> {
    const workspaceUri = this.ctx.fs.fileUrl(workspaceTarget)
    const signal = AbortSignal.any([
      this.lifecycle.signal,
      AbortSignal.timeout(this.config.diagnosticsTimeoutMs),
    ])
    const selected = plans.slice(0, this.config.maxDiagnosticsFiles)
    const files: JsonValue[] = []
    for (const plan of selected) {
      if (signal.aborted) {
        files.push({ path: plan.path, supported: false, error: 'diagnostics deadline reached' })
        continue
      }
      const route = this.registry.resolve(plan.path)
      if (!route) {
        files.push({ path: plan.path, supported: false, error: 'no language server route' })
        continue
      }
      try {
        const result = await this.withConnection(
          route.config,
          this.ctx.fs.processPath(workspaceTarget),
          workspaceUri,
          (connection) =>
            executeOneShotDiagnostics(connection, {
              processId: process.pid,
              workspaceUri,
              documentUri: this.ctx.fs.fileUrl(plan.target),
              languageId: route.languageId,
              content: plan.after,
              initializationOptions: route.config.initializationOptions,
            }),
          signal,
        )
        files.push({
          path: plan.path,
          supported: result.supported,
          count: result.items.length,
          items: jsonSafe(result.items.slice(0, 50)),
        })
      } catch (error) {
        files.push({
          path: plan.path,
          supported: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return {
      files,
      skipped: Math.max(0, plans.length - selected.length),
    }
  }
}

export default RefactorRuntime
