/**
 * Session-persistent JavaScript and Python kernels. JavaScript persists values
 * in `state`; Python keeps its globals. Both expose a generic callback into the
 * same dsh tool registry (`await tool(name, args)` / `tool(name, args)`).
 * @module oh-my-dsh/kernel
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'

export const name = 'omd-kernel'
export const inject = ['tools', 'systemPrompt', 'approval', 'sandboxPolicy']

export interface Config {
  requireApproval?: boolean
  maxOutputChars?: number
}

export const Config: z<Config> = z.object({
  requireApproval: z.boolean().default(true),
  maxOutputChars: z.number().min(1024).default(32_000),
})

type Language = 'javascript' | 'python'

interface BridgeMessage {
  type: 'result' | 'tool'
  id: string
  output?: string
  value?: string
  error?: string
  name?: string
  args?: unknown
}

const JAVASCRIPT_BRIDGE = String.raw`
const readline = require('node:readline')
const state = Object.create(null)
const pending = new Map()
let toolSeq = 0
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
function tool(name, args = {}) {
  const id = 'tool-' + (++toolSeq)
  send({ type: 'tool', id, name, args })
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
async function evaluate(message) {
  const logs = []
  const capture = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level => [
    level,
    (...args) => logs.push(args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')),
  ]))
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const fn = new AsyncFunction('state', 'tool', 'console', '"use strict";\n' + message.code)
    const value = await fn(state, tool, capture)
    send({ type: 'result', id: message.id, output: logs.join('\n'), value: value === undefined ? '' : JSON.stringify(value) })
  } catch (error) {
    send({ type: 'result', id: message.id, output: logs.join('\n'), error: error && error.stack ? error.stack : String(error) })
  }
}
rl.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.type === 'eval') void evaluate(message)
  if (message.type === 'tool-result') {
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error))
    else waiter.resolve(message.value)
  }
})
`

const PYTHON_BRIDGE = String.raw`
import ast, contextlib, io, json, sys, traceback
scope = {"__name__": "__omd_kernel__"}
tool_seq = 0
def send(value):
    sys.__stdout__.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.__stdout__.flush()
def tool(name, args=None):
    global tool_seq
    tool_seq += 1
    call_id = "tool-" + str(tool_seq)
    send({"type": "tool", "id": call_id, "name": name, "args": args or {}})
    while True:
        line = sys.__stdin__.readline()
        if not line:
            raise RuntimeError("kernel host disconnected")
        message = json.loads(line)
        if message.get("type") == "tool-result" and message.get("id") == call_id:
            if message.get("error"):
                raise RuntimeError(message["error"])
            return message.get("value")
scope["tool"] = tool
def evaluate(message):
    output = io.StringIO()
    try:
        tree = ast.parse(message["code"], mode="exec")
        value = None
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                expression = ast.Expression(tree.body.pop().value)
                exec(compile(tree, "<omd-kernel>", "exec"), scope, scope)
                value = eval(compile(expression, "<omd-kernel>", "eval"), scope, scope)
            else:
                exec(compile(tree, "<omd-kernel>", "exec"), scope, scope)
        try:
            encoded = json.dumps(value, ensure_ascii=False)
        except TypeError:
            encoded = json.dumps(repr(value), ensure_ascii=False)
        send({"type": "result", "id": message["id"], "output": output.getvalue(), "value": encoded})
    except BaseException:
        send({"type": "result", "id": message["id"], "output": output.getvalue(), "error": traceback.format_exc()})
while True:
    line = sys.stdin.readline()
    if not line:
        break
    try:
        message = json.loads(line)
        if message.get("type") == "eval":
            evaluate(message)
    except BaseException:
        send({"type": "result", "id": "unknown", "error": traceback.format_exc()})
`

function resultError(result: ToolExecutionResult): string | undefined {
  if (!result.isError) return undefined
  return result.error.message
}

class PersistentKernel {
  private child: ChildProcessWithoutNullStreams
  private alive = true
  private requestSeq = 0
  private toolSeq = 0
  private pending:
    | {
        id: string
        resolve: (message: BridgeMessage) => void
        reject: (error: Error) => void
        exec: ToolRunContext
      }
    | undefined
  private stderr = ''

  constructor(
    readonly language: Language,
    private readonly ctx: Context,
    cwd: string,
    private readonly onTerminated: () => void,
  ) {
    const command = language === 'javascript' ? process.execPath : (process.env.OMD_PYTHON || 'python3')
    const args = language === 'javascript' ? ['-e', JAVASCRIPT_BRIDGE] : ['-u', '-c', PYTHON_BRIDGE]
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: language === 'javascript'
        ? {}
        : { PATH: process.env.PATH ?? '', PYTHONIOENCODING: 'utf-8' },
    })
    this.child.stdin.on('error', (error) => {
      this.alive = false
      this.fail(error)
      this.onTerminated()
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8_000)
    })
    this.child.on('error', (error) => {
      this.alive = false
      this.fail(error)
      this.onTerminated()
    })
    this.child.on('exit', (code, signal) => {
      this.alive = false
      this.fail(new Error(`${language} kernel exited (${signal ?? code ?? 'unknown'})${this.stderr ? `: ${this.stderr}` : ''}`))
      this.onTerminated()
    })
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      void this.onLine(line).catch((cause) => {
        if (!this.alive) return
        const error = cause instanceof Error ? cause : new Error(String(cause))
        this.alive = false
        this.fail(error)
        this.child.kill('SIGTERM')
        this.onTerminated()
      })
    })
  }

  private send(value: unknown): void {
    if (!this.alive) throw new Error(`${this.language} kernel is not running`)
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private fail(error: Error): void {
    this.pending?.reject(error)
    this.pending = undefined
  }

  private async onLine(line: string): Promise<void> {
    let message: BridgeMessage
    try {
      message = JSON.parse(line) as BridgeMessage
    } catch {
      return
    }
    const pending = this.pending
    if (!pending) return
    if (message.type === 'result' && message.id === pending.id) {
      this.pending = undefined
      pending.resolve(message)
      return
    }
    if (message.type !== 'tool' || !message.name) return
    const result = await this.ctx.tools.execute({
      callId: CallId(`${pending.exec.callId}:kernel:${++this.toolSeq}`),
      rootCallId: pending.exec.rootCallId,
      name: message.name,
      arguments: message.args ?? {},
      agent: pending.exec.agent,
      parent: pending.exec.token,
      signal: pending.exec.signal,
    })
    if (!this.alive || this.pending !== pending) return
    const error = resultError(result)
    this.send({
      type: 'tool-result',
      id: message.id,
      ...(error ? { error } : { value: result.value }),
    })
  }

  evaluate(code: string, exec: ToolRunContext): Promise<BridgeMessage> {
    if (!this.alive) return Promise.reject(new Error(`${this.language} kernel is not running`))
    if (this.pending) throw new Error(`${this.language} kernel is already running a cell`)
    const id = `eval-${++this.requestSeq}`
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.dispose()
        reject(new Error(`${this.language} kernel cell aborted`))
      }
      if (exec.signal.aborted) return abort()
      exec.signal.addEventListener('abort', abort, { once: true })
      this.pending = {
        id,
        exec,
        resolve: (message) => {
          exec.signal.removeEventListener('abort', abort)
          resolve(message)
        },
        reject: (error) => {
          exec.signal.removeEventListener('abort', abort)
          reject(error)
        },
      }
      this.send({ type: 'eval', id, code })
    })
  }

  dispose(): void {
    if (!this.alive) return
    this.alive = false
    this.child.kill('SIGTERM')
    this.fail(new Error(`${this.language} kernel reset`))
    this.onTerminated()
  }
}

function keyFor(agent: Agent | undefined): object {
  return agent ?? globalThis
}

export function apply(ctx: Context, config: Config): void {
  const kernels = new Map<object, Map<Language, PersistentKernel>>()

  const disposeAgent = (agent: object): void => {
    for (const kernel of kernels.get(agent)?.values() ?? []) kernel.dispose()
    kernels.delete(agent)
  }
  ctx.on('agent/disposed', ({ agent }) => disposeAgent(agent))
  ctx.effect(() => () => {
    for (const agent of kernels.keys()) disposeAgent(agent)
  })

  if (config.requireApproval !== false) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== 'kernel') return next()
      const policy = ctx.sandboxPolicy.resolve(
        exec.agent === undefined ? {} : { session: exec.agent.session },
      )
      if (policy.mode === 'danger-full-access') return next()
      return {
        kind: 'ask',
        reason: 'Persistent kernel code runs with host-user file and process access.',
      }
    })
  }

  ctx.systemPrompt.section({
    name: 'tool:kernel',
    order: 113,
    text: 'Use kernel for stateful analysis: JavaScript persists values under `state`, Python persists ordinary variables. A cell can call existing tools with `await tool(name, args)` in JavaScript or `tool(name, args)` in Python. Reset a kernel when stale state could affect correctness.',
  })

  ctx.tools.register(defineTool({
    name: 'kernel',
    description:
      'Run a cell in a session-persistent JavaScript or Python kernel. '
      + 'JavaScript state persists in `state`; Python globals persist. Both can call dsh tools.',
    parameters: {
      language: {
        type: 'string',
        required: true,
        enum: ['javascript', 'python'],
      },
      code: {
        type: 'string',
        description: 'Cell source. Required unless reset is true.',
      },
      reset: {
        type: 'boolean',
        description: 'Dispose this language kernel and clear its state.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 600_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const language = args.language as Language
      const owner = keyFor(exec.agent)
      let agentKernels = kernels.get(owner)
      if (!agentKernels) {
        agentKernels = new Map()
        kernels.set(owner, agentKernels)
      }
      if (args.reset) {
        agentKernels.get(language)?.dispose()
        agentKernels.delete(language)
        return `${language} kernel reset.`
      }
      if (!args.code?.trim()) throw new Error('kernel requires non-empty code unless reset is true')
      let kernel = agentKernels.get(language)
      if (!kernel) {
        let created: PersistentKernel
        created = new PersistentKernel(
          language,
          ctx,
          exec.agent?.session.header.cwd ?? process.cwd(),
          () => {
            if (agentKernels?.get(language) === created) agentKernels.delete(language)
          },
        )
        kernel = created
        agentKernels.set(language, kernel)
      }
      try {
        const result = await kernel.evaluate(args.code, exec)
        const text = [
          result.output?.trim(),
          result.value ? `=> ${result.value}` : '',
          result.error ? `Error:\n${result.error}` : '',
        ].filter(Boolean).join('\n')
        const limit = config.maxOutputChars ?? 32_000
        return text.length <= limit ? text : `${text.slice(0, limit)}\n[output truncated]`
      } catch (error) {
        kernel.dispose()
        agentKernels.delete(language)
        throw error
      }
    },
  }))
}
