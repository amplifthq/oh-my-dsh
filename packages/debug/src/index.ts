/**
 * Proposal-gated Debug Adapter Protocol sessions. `debug_control` lists
 * discovered adapters and prepares launch/attach proposals; only an approved
 * `proposal_control apply` spawns the adapter and the debuggee. Afterwards
 * breakpoints, stepping, stack and variable inspection, and expression
 * evaluation operate on the approved session. Disabled by default; enable
 * with `OMD_ENABLE_DEBUG=1`.
 * @module oh-my-dsh/debug
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  discoverAdapters,
  mergeLaunchArguments,
  type AdapterProbeHost,
  type CustomAdapterConfig,
  type DebugAdapter,
} from './adapters.js'
import { DapSession, type DapStatus, type DapTransport } from './session.js'

export const name = 'omd-debug'
export const inject = ['tools', 'fs', 'subprocess', 'proposals', 'systemPrompt']

export interface Config {
  requestTimeoutMs?: number
  launchTimeoutMs?: number
  stopWaitMs?: number
  maxOutputChars?: number
  maxSessions?: number
  adapters?: Record<string, CustomAdapterConfig>
}

export const Config: z<Config> = z.object({
  requestTimeoutMs: z.number().min(1_000).default(15_000),
  launchTimeoutMs: z.number().min(2_000).default(30_000),
  stopWaitMs: z.number().min(500).default(8_000),
  maxOutputChars: z.number().min(1_024).default(32_000),
  maxSessions: z.number().min(1).default(3),
  adapters: z
    .dict(
      z.object({
        command: z.string().required(),
        args: z.array(z.string()),
        description: z.string(),
        languages: z.array(z.string()),
        launchDefaults: z.any(),
        supportsAttach: z.boolean(),
      }),
    )
    .default({}),
})

interface ManagedSession {
  id: string
  adapterId: string
  request: 'launch' | 'attach'
  program?: string
  handle: SubprocessHandle
  session: DapSession
  stderrOffset: number
}

interface SourceBreakpoint {
  file: string
  line: number
  condition?: string
}

function jsonSafe(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new Error('debug_control requires an active agent session')
  return exec.agent
}

function transportFor(handle: SubprocessHandle): DapTransport {
  return {
    write: (data) => void handle.stdin?.write(data),
    onData: (handler) => void handle.stdout?.on('data', handler),
    onClose: (handler) =>
      void handle.done.then(
        () => handler(),
        () => handler(),
      ),
  }
}

function groupBreakpoints(
  breakpoints: readonly SourceBreakpoint[],
): Map<string, Array<{ line: number; condition?: string }>> {
  const byFile = new Map<string, Array<{ line: number; condition?: string }>>()
  for (const breakpoint of breakpoints) {
    if (!Number.isInteger(breakpoint.line) || breakpoint.line < 1) {
      throw new Error(`breakpoint line must be a positive integer, got ${breakpoint.line}`)
    }
    const entry = {
      line: breakpoint.line,
      ...(breakpoint.condition ? { condition: breakpoint.condition } : {}),
    }
    const existing = byFile.get(breakpoint.file)
    if (existing) existing.push(entry)
    else byFile.set(breakpoint.file, [entry])
  }
  return byFile
}

export function apply(ctx: Context, config: Config): void {
  const requestTimeoutMs = config.requestTimeoutMs ?? 15_000
  const launchTimeoutMs = config.launchTimeoutMs ?? 30_000
  const stopWaitMs = config.stopWaitMs ?? 8_000
  const maxOutputChars = config.maxOutputChars ?? 32_000
  const maxSessions = config.maxSessions ?? 3

  let sequence = 0
  const byAgent = new WeakMap<Agent, Map<string, ManagedSession>>()
  const live = new Set<ManagedSession>()
  let catalog: Promise<Record<string, DebugAdapter>> | undefined

  const probeHost: AdapterProbeHost = {
    resolveExecutable: (command) => ctx.subprocess.resolveExecutable(command),
    probeCommand: async (argv) => {
      try {
        const handle = ctx.subprocess.spawn({
          argv,
          cwd: process.cwd(),
          stdio: { stdin: 'ignore', stdout: { maxBytes: 4_096 }, stderr: { maxBytes: 4_096 } },
          graceMs: 1_000,
          signal: AbortSignal.timeout(10_000),
        })
        const outcome = await handle.done
        return outcome.exitCode === 0
      } catch {
        return false
      }
    },
  }

  function adapters(): Promise<Record<string, DebugAdapter>> {
    catalog ??= discoverAdapters(config.adapters ?? {}, probeHost)
    return catalog
  }

  function sessionsOf(agent: Agent): Map<string, ManagedSession> {
    let sessions = byAgent.get(agent)
    if (!sessions) {
      sessions = new Map()
      byAgent.set(agent, sessions)
    }
    return sessions
  }

  function sessionOf(agent: Agent, id: unknown): ManagedSession {
    if (typeof id !== 'string' || !id) throw new Error('this action requires a session id')
    const managed = sessionsOf(agent).get(id)
    if (!managed) throw new Error(`unknown debug session "${id}"`)
    return managed
  }

  async function teardown(managed: ManagedSession): Promise<void> {
    live.delete(managed)
    try {
      await managed.session.disconnect(1_500)
    } catch {
      // The adapter may already be unresponsive; tree termination follows.
    }
    managed.handle.terminate()
    await managed.handle.waitForExit(AbortSignal.timeout(3_000)).catch(() => false)
  }

  function disposeAgentSessions(agent: Agent): void {
    const sessions = byAgent.get(agent)
    if (!sessions) return
    byAgent.delete(agent)
    for (const managed of sessions.values()) void teardown(managed).catch(() => {})
  }

  ctx.on('agent/disposed', ({ agent }) => disposeAgentSessions(agent))
  ctx.effect(
    () => () => {
      for (const managed of [...live]) void teardown(managed).catch(() => {})
    },
    'omd-debug.sessions',
  )

  async function workspaceOf(agent: Agent, signal: AbortSignal | undefined) {
    const workspace = agent.session.header.cwd ?? process.cwd()
    return ctx.fs.resolve(workspace, { signal })
  }

  async function containedPath(
    path: string,
    agent: Agent,
    signal: AbortSignal | undefined,
    expected: 'file' | 'directory',
  ): Promise<string> {
    const workspaceTarget = await workspaceOf(agent, signal)
    const target = await ctx.fs.resolve(path, {
      cwd: agent.session.header.cwd ?? process.cwd(),
      signal,
    })
    if (!ctx.fs.contains(workspaceTarget, target)) {
      throw new Error(`"${path}" is outside the workspace; debug targets must stay inside it`)
    }
    const info = await ctx.fs.stat(target, signal)
    if (info?.type !== expected) throw new Error(`"${path}" is not an existing ${expected}`)
    return ctx.fs.processPath(target)
  }

  async function startSession(
    agent: Agent,
    adapter: DebugAdapter,
    request: 'launch' | 'attach',
    launchArguments: Record<string, unknown>,
    breakpoints: Map<string, Array<{ line: number; condition?: string }>>,
    program: string | undefined,
    waitForStopAfterStart: boolean,
    exec: ToolRunContext,
  ): Promise<{ id: string; status: DapStatus; breakpoints: unknown }> {
    const sessions = sessionsOf(agent)
    if (sessions.size >= maxSessions) {
      throw new Error(`at most ${maxSessions} debug sessions per agent; terminate one first`)
    }
    exec.signal.throwIfAborted()
    const workspaceTarget = await workspaceOf(agent, exec.signal)
    const handle = ctx.subprocess.spawn({
      argv: adapter.argv,
      cwd: ctx.fs.processPath(workspaceTarget),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64_000 } },
      graceMs: 2_000,
    })
    const session = new DapSession(transportFor(handle), { requestTimeoutMs, maxOutputChars })
    const managed: ManagedSession = {
      id: `dbg-${++sequence}`,
      adapterId: adapter.id,
      request,
      program,
      handle,
      session,
      stderrOffset: 0,
    }
    try {
      const started = await session.start(
        {
          request,
          arguments: launchArguments,
          breakpoints: [...breakpoints.entries()].map(([path, entries]) => ({
            path,
            breakpoints: entries,
          })),
        },
        launchTimeoutMs,
      )
      exec.signal.throwIfAborted()
      const status = waitForStopAfterStart
        ? await session.waitForStop(stopWaitMs)
        : await session.waitForStop(1_000)
      sessions.set(managed.id, managed)
      live.add(managed)
      return { id: managed.id, status, breakpoints: started.breakpoints }
    } catch (error) {
      const stderr = handle.collected.stderr?.readFrom(0).text.slice(-2_000) ?? ''
      await teardown(managed)
      const detail = stderr ? `; adapter stderr tail: ${stderr}` : ''
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`)
    }
  }

  ctx.systemPrompt.section({
    name: 'omd:debug',
    order: 115,
    text:
      'debug_control drives Debug Adapter Protocol sessions. prepare_launch and prepare_attach only return ' +
      'proposals; starting the adapter and debuggee requires proposal_control apply with user approval. ' +
      'On an approved session, set breakpoints, continue or step, then inspect stack, variables, and output; ' +
      'evaluate runs expressions inside the debuggee.',
  })

  ctx.tools.register(
    defineTool({
      name: 'debug_control',
      description:
        'Debug programs over the Debug Adapter Protocol. Actions: adapters, sessions, prepare_launch, ' +
        'prepare_attach (both return proposals that require proposal_control apply), breakpoints (replaces all ' +
        'breakpoints in each mentioned file), continue, next, step_in, step_out, pause, stack, variables, ' +
        'evaluate, output, terminate.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: [
            'adapters',
            'sessions',
            'prepare_launch',
            'prepare_attach',
            'breakpoints',
            'continue',
            'next',
            'step_in',
            'step_out',
            'pause',
            'stack',
            'variables',
            'evaluate',
            'output',
            'terminate',
          ],
          description: 'Operation to perform.',
        },
        adapter: {
          type: 'string',
          description: 'Adapter id for prepare_launch and prepare_attach.',
        },
        program: {
          type: 'string',
          description: 'Workspace-relative or absolute program path to launch.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Debuggee argv after the program.',
        },
        cwd: {
          type: 'string',
          description: 'Debuggee working directory; defaults to the workspace root.',
        },
        env: {
          type: 'object',
          additionalProperties: true,
          description: 'Extra environment variables for the debuggee.',
        },
        stop_on_entry: {
          type: 'boolean',
          description: 'Stop at the first instruction (default true).',
        },
        breakpoints: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              file: { type: 'string', required: true, description: 'Source file path.' },
              line: { type: 'number', required: true, description: '1-based line number.' },
              condition: {
                type: 'string',
                description: 'Optional breakpoint condition expression.',
              },
            },
          },
          description: 'Source breakpoints for prepare_launch or the breakpoints action.',
        },
        config: {
          type: 'object',
          additionalProperties: true,
          description: 'Adapter-specific launch/attach configuration merged in.',
        },
        session: {
          type: 'string',
          description: 'Debug session id returned by an applied proposal.',
        },
        thread: { type: 'number', description: 'Thread id; defaults to the stopped thread.' },
        frame: { type: 'number', description: 'Stack frame id from the stack action.' },
        ref: {
          type: 'number',
          description: 'variablesReference from a prior variables/evaluate result.',
        },
        expression: { type: 'string', description: 'Expression for evaluate.' },
        max_frames: { type: 'number', description: 'Maximum stack frames to return (default 20).' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args, exec) => {
        const agent = requireAgent(exec)
        const result = await executeAction(agent, args as Record<string, unknown>, exec)
        return JSON.stringify(result, null, 2)
      },
    }),
  )

  async function executeAction(
    agent: Agent,
    args: Record<string, unknown>,
    exec: ToolRunContext,
  ): Promise<unknown> {
    const action = args.action as string

    if (action === 'adapters') {
      const available = await adapters()
      return {
        action,
        adapters: Object.values(available).map((adapter) => ({
          id: adapter.id,
          description: adapter.description,
          languages: adapter.languages,
          command: adapter.argv.join(' '),
          supportsAttach: adapter.supportsAttach,
        })),
      }
    }

    if (action === 'sessions') {
      return {
        action,
        sessions: [...sessionsOf(agent).values()].map((managed) => ({
          id: managed.id,
          adapter: managed.adapterId,
          request: managed.request,
          program: managed.program,
          ...managed.session.status(),
        })),
      }
    }

    if (action === 'prepare_launch') return prepareLaunch(agent, args, exec)
    if (action === 'prepare_attach') return prepareAttach(agent, args, exec)

    const managed = sessionOf(agent, args.session)

    if (action === 'breakpoints') {
      const grouped = groupBreakpoints((args.breakpoints ?? []) as SourceBreakpoint[])
      if (!grouped.size) throw new Error('breakpoints requires a non-empty breakpoints array')
      const results: unknown[] = []
      for (const [file, entries] of grouped) {
        const path = await containedPath(file, agent, exec.signal, 'file')
        const result = await managed.session.request('setBreakpoints', {
          source: { path },
          breakpoints: entries,
          lines: entries.map((entry) => entry.line),
        })
        results.push({ file, result: jsonSafe(result) })
      }
      return { action, session: managed.id, files: results }
    }

    if (
      action === 'continue' ||
      action === 'next' ||
      action === 'step_in' ||
      action === 'step_out'
    ) {
      const command = {
        continue: 'continue',
        next: 'next',
        step_in: 'stepIn',
        step_out: 'stepOut',
      }[action]
      const threadId = (args.thread as number | undefined) ?? managed.session.stoppedThreadId()
      if (threadId === undefined) {
        throw new Error(
          `${action} requires a stopped thread; current state is ${managed.session.status().state}`,
        )
      }
      await managed.session.request(command, { threadId })
      const status = await managed.session.waitForStop(stopWaitMs)
      return { action, session: managed.id, ...status }
    }

    if (action === 'pause') {
      let threadId = args.thread as number | undefined
      if (threadId === undefined) {
        const threads = jsonSafe(await managed.session.request('threads')) as {
          threads?: Array<{ id?: number }>
        }
        threadId = threads.threads?.[0]?.id
      }
      if (threadId === undefined) throw new Error('pause could not determine a thread to pause')
      await managed.session.request('pause', { threadId })
      const status = await managed.session.waitForStop(stopWaitMs)
      return { action, session: managed.id, ...status }
    }

    if (action === 'stack') {
      const threadId = (args.thread as number | undefined) ?? managed.session.stoppedThreadId()
      if (threadId === undefined) throw new Error('stack requires a stopped thread')
      const raw = jsonSafe(
        await managed.session.request('stackTrace', {
          threadId,
          startFrame: 0,
          levels: Math.min(100, (args.max_frames as number | undefined) ?? 20),
        }),
      ) as { stackFrames?: Array<Record<string, unknown>>; totalFrames?: number }
      return {
        action,
        session: managed.id,
        totalFrames: raw.totalFrames,
        frames: (raw.stackFrames ?? []).map((frame) => ({
          id: frame.id,
          name: frame.name,
          source: (frame.source as { path?: string } | undefined)?.path,
          line: frame.line,
          column: frame.column,
        })),
      }
    }

    if (action === 'variables') {
      if (typeof args.ref === 'number') {
        const raw = jsonSafe(
          await managed.session.request('variables', {
            variablesReference: args.ref,
            count: 100,
          }),
        )
        return { action, session: managed.id, variables: raw }
      }
      if (typeof args.frame !== 'number') throw new Error('variables requires frame or ref')
      const scopes = jsonSafe(await managed.session.request('scopes', { frameId: args.frame })) as {
        scopes?: Array<{ name?: string; variablesReference?: number; expensive?: boolean }>
      }
      const result: unknown[] = []
      for (const scope of scopes.scopes ?? []) {
        if (scope.expensive || typeof scope.variablesReference !== 'number') {
          result.push({ scope: scope.name, skipped: true })
          continue
        }
        const raw = jsonSafe(
          await managed.session.request('variables', {
            variablesReference: scope.variablesReference,
            count: 50,
          }),
        )
        result.push({ scope: scope.name, variables: raw })
      }
      return { action, session: managed.id, scopes: result }
    }

    if (action === 'evaluate') {
      if (typeof args.expression !== 'string' || !args.expression) {
        throw new Error('evaluate requires expression')
      }
      const raw = jsonSafe(
        await managed.session.request('evaluate', {
          expression: args.expression,
          ...(typeof args.frame === 'number' ? { frameId: args.frame } : {}),
          context: 'repl',
        }),
      )
      return { action, session: managed.id, result: raw }
    }

    if (action === 'output') {
      const output = managed.session.readOutput()
      const stderrReader = managed.handle.collected.stderr
      let adapterStderr = ''
      if (stderrReader) {
        const read = stderrReader.readFrom(managed.stderrOffset)
        managed.stderrOffset = read.nextOffset
        adapterStderr = read.text
      }
      return {
        action,
        session: managed.id,
        output: output.text,
        droppedChars: output.droppedChars,
        adapterStderr,
        ...managed.session.status(),
      }
    }

    if (action === 'terminate') {
      sessionsOf(agent).delete(managed.id)
      await teardown(managed)
      return { action, session: managed.id, terminated: true }
    }

    throw new Error(`unknown debug_control action "${String(action)}"`)
  }

  async function prepareLaunch(
    agent: Agent,
    args: Record<string, unknown>,
    exec: ToolRunContext,
  ): Promise<unknown> {
    const available = await adapters()
    const adapter = available[args.adapter as string]
    if (!adapter) {
      throw new Error(`unknown adapter "${String(args.adapter)}"; run debug_control adapters first`)
    }
    if (typeof args.program !== 'string' || !args.program)
      throw new Error('prepare_launch requires program')
    if (sessionsOf(agent).size >= maxSessions) {
      throw new Error(`at most ${maxSessions} debug sessions per agent; terminate one first`)
    }

    const program = await containedPath(args.program, agent, exec.signal, 'file')
    const cwd =
      typeof args.cwd === 'string' && args.cwd
        ? await containedPath(args.cwd, agent, exec.signal, 'directory')
        : ctx.fs.processPath(await workspaceOf(agent, exec.signal))
    const debuggeeArgs = ((args.args ?? []) as unknown[]).map(String)
    const stopOnEntry = args.stop_on_entry !== false
    const env =
      args.env && typeof args.env === 'object'
        ? Object.fromEntries(
            Object.entries(args.env as Record<string, unknown>).map(([key, value]) => [
              key,
              String(value),
            ]),
          )
        : undefined

    const grouped = groupBreakpoints((args.breakpoints ?? []) as SourceBreakpoint[])
    const resolvedBreakpoints = new Map<string, Array<{ line: number; condition?: string }>>()
    for (const [file, entries] of grouped) {
      resolvedBreakpoints.set(await containedPath(file, agent, exec.signal, 'file'), entries)
    }

    const launchArguments = mergeLaunchArguments(
      adapter,
      (args.config ?? {}) as Record<string, unknown>,
      { program, args: debuggeeArgs, cwd, stopOnEntry, ...(env ? { env } : {}) },
    )

    const proposal = ctx.proposals.create(agent, {
      kind: 'debug-launch',
      title: `Launch ${args.program} under the ${adapter.id} debugger`,
      summary:
        `Start the ${adapter.id} debug adapter and launch ${program} with ` +
        `${debuggeeArgs.length} argument(s) in ${cwd}. The session allows breakpoints, stepping, and ` +
        'expression evaluation inside the debuggee process.',
      effects: [
        {
          type: 'spawn-debug-adapter',
          target: adapter.argv.join(' '),
          summary: `Start the ${adapter.id} debug adapter process`,
        },
        {
          type: 'launch-debuggee',
          target: program,
          summary: `Launch the program under the debugger in ${cwd}`,
          details: jsonSafe({
            launch: launchArguments,
            breakpoints: [...resolvedBreakpoints.keys()],
          }),
        },
      ],
      signal: exec.signal,
      commit: async (commitExec) => {
        const started = await startSession(
          agent,
          adapter,
          'launch',
          launchArguments,
          resolvedBreakpoints,
          program,
          stopOnEntry,
          commitExec,
        )
        return {
          summary: `Debug session ${started.id} launched (${started.status.state}).`,
          details: jsonSafe(started),
        }
      },
    })
    return { action: 'prepare_launch', proposal }
  }

  async function prepareAttach(
    agent: Agent,
    args: Record<string, unknown>,
    exec: ToolRunContext,
  ): Promise<unknown> {
    const available = await adapters()
    const adapter = available[args.adapter as string]
    if (!adapter) {
      throw new Error(`unknown adapter "${String(args.adapter)}"; run debug_control adapters first`)
    }
    if (!adapter.supportsAttach) throw new Error(`adapter "${adapter.id}" does not support attach`)
    const attachConfig = args.config
    if (!attachConfig || typeof attachConfig !== 'object' || !Object.keys(attachConfig).length) {
      throw new Error(
        'prepare_attach requires a non-empty config (for example { pid } or { connect: { host, port } })',
      )
    }
    if (sessionsOf(agent).size >= maxSessions) {
      throw new Error(`at most ${maxSessions} debug sessions per agent; terminate one first`)
    }
    const attachArguments = {
      ...adapter.launchDefaults,
      ...(attachConfig as Record<string, unknown>),
    }

    const proposal = ctx.proposals.create(agent, {
      kind: 'debug-attach',
      title: `Attach the ${adapter.id} debugger`,
      summary:
        `Start the ${adapter.id} debug adapter and attach it with the exact configuration shown in the ` +
        'effects. The session allows breakpoints, stepping, and expression evaluation inside the attached process.',
      effects: [
        {
          type: 'spawn-debug-adapter',
          target: adapter.argv.join(' '),
          summary: `Start the ${adapter.id} debug adapter process`,
        },
        {
          type: 'attach-debugger',
          target: JSON.stringify(attachConfig),
          summary: 'Attach the debugger to the process identified by this configuration',
          details: jsonSafe({ attach: attachArguments }),
        },
      ],
      signal: exec.signal,
      commit: async (commitExec) => {
        const started = await startSession(
          agent,
          adapter,
          'attach',
          attachArguments,
          new Map(),
          undefined,
          false,
          commitExec,
        )
        return {
          summary: `Debug session ${started.id} attached (${started.status.state}).`,
          details: jsonSafe(started),
        }
      },
    })
    return { action: 'prepare_attach', proposal }
  }
}
