/**
 * One live DAP session over an abstract byte transport. Owns request/response
 * correlation, the initialize → configure → launch/attach ordering that
 * adapters expect, stop/continue bookkeeping, bounded output capture, and
 * rejection of adapter-driven reverse requests such as runInTerminal.
 * @module oh-my-dsh/debug/session
 */

import {
  DapDecoder,
  encodeDapMessage,
  type DapEventMessage,
  type DapProtocolMessage,
  type DapRequestMessage,
  type DapResponseMessage,
} from './protocol.js'

export interface DapTransport {
  write(data: Buffer): void
  onData(handler: (chunk: Buffer) => void): void
  onClose(handler: () => void): void
}

export interface DapStoppedState {
  reason: string
  threadId?: number
  description?: string
  text?: string
  allThreadsStopped?: boolean
}

export interface DapOutputRead {
  text: string
  droppedChars: number
}

export type DapRunState = 'configuring' | 'running' | 'stopped' | 'exited'

export interface DapStatus {
  state: DapRunState
  stopped?: DapStoppedState
  exitCode?: number
  terminated: boolean
}

export interface DapStartPlan {
  /** DAP request that creates the debuggee: launch or attach. */
  request: 'launch' | 'attach'
  /** Complete adapter-specific launch/attach arguments. */
  arguments: Record<string, unknown>
  /** Source breakpoints applied during the configuration phase. */
  breakpoints: Array<{ path: string; breakpoints: Array<{ line: number; condition?: string }> }>
}

interface PendingRequest {
  command: string
  resolve(body: unknown): void
  reject(error: Error): void
}

function body(message: { body?: unknown }): Record<string, unknown> {
  return (message.body && typeof message.body === 'object' ? message.body : {}) as Record<string, unknown>
}

export class DapSessionError extends Error {}

export class DapSession {
  private seq = 0
  private readonly pending = new Map<number, PendingRequest>()
  private readonly decoder = new DapDecoder()
  private initializedListeners: Array<() => void> = []
  private stopListeners: Array<() => void> = []
  private sawInitialized = false
  private stopped: DapStoppedState | undefined
  private exitCode: number | undefined
  private terminated = false
  private closed = false
  private started = false
  private outputBuffer = ''
  private outputDropped = 0
  capabilities: Record<string, unknown> = {}

  constructor(
    private readonly transport: DapTransport,
    private readonly options: { requestTimeoutMs: number; maxOutputChars: number },
  ) {
    transport.onData((chunk) => this.onData(chunk))
    transport.onClose(() => this.onClose())
  }

  get ended(): boolean {
    return this.closed || this.terminated || this.exitCode !== undefined
  }

  status(): DapStatus {
    const state: DapRunState = !this.started
      ? 'configuring'
      : this.ended
        ? 'exited'
        : this.stopped
          ? 'stopped'
          : 'running'
    return {
      state,
      stopped: this.stopped ? { ...this.stopped } : undefined,
      exitCode: this.exitCode,
      terminated: this.terminated,
    }
  }

  stoppedThreadId(): number | undefined {
    return this.stopped?.threadId
  }

  readOutput(): DapOutputRead {
    const read = { text: this.outputBuffer, droppedChars: this.outputDropped }
    this.outputBuffer = ''
    this.outputDropped = 0
    return read
  }

  request(command: string, args?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new DapSessionError('debug adapter connection is closed'))
    const seq = ++this.seq
    const message: DapRequestMessage = { seq, type: 'request', command }
    if (args !== undefined) message.arguments = args
    // Register the pending entry before writing so a transport that answers
    // synchronously (in-memory tests) still correlates the response.
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(seq)
        reject(new DapSessionError(`DAP ${command} timed out after ${timeoutMs ?? this.options.requestTimeoutMs}ms`))
      }, timeoutMs ?? this.options.requestTimeoutMs)
      this.pending.set(seq, {
        command,
        resolve: (value) => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
    })
    try {
      this.transport.write(encodeDapMessage(message))
    } catch (error) {
      this.pending.get(seq)?.reject(
        error instanceof Error ? error : new Error(String(error)),
      )
      this.pending.delete(seq)
    }
    return promise
  }

  /**
   * Run the standard startup sequence. The launch/attach response is
   * deliberately awaited only after `initialized` → breakpoints →
   * `configurationDone`, because adapters like debugpy answer launch only
   * once configuration finishes.
   */
  async start(plan: DapStartPlan, timeoutMs: number): Promise<{
    breakpoints: Array<{ path: string; verified: unknown }>
  }> {
    const deadline = new DapDeadline(timeoutMs)
    this.capabilities = ((await deadline.race(this.request('initialize', {
      clientID: 'oh-my-dsh',
      clientName: 'oh-my-dsh',
      adapterID: 'oh-my-dsh',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: false,
      locale: 'en',
    }, timeoutMs))) ?? {}) as Record<string, unknown>

    const startResponse = this.request(plan.request, plan.arguments, timeoutMs)
    startResponse.catch(() => {})
    await deadline.race(this.waitForInitialized())

    const breakpointResults: Array<{ path: string; verified: unknown }> = []
    for (const file of plan.breakpoints) {
      const result = body({
        body: await deadline.race(this.request('setBreakpoints', {
          source: { path: file.path },
          breakpoints: file.breakpoints,
          lines: file.breakpoints.map((breakpoint) => breakpoint.line),
        })),
      })
      breakpointResults.push({ path: file.path, verified: result.breakpoints ?? [] })
    }
    if (this.capabilities.supportsConfigurationDoneRequest !== false) {
      await deadline.race(this.request('configurationDone', {}).catch((error: unknown) => {
        if (this.capabilities.supportsConfigurationDoneRequest === true) throw error
      }))
    }
    await deadline.race(startResponse)
    this.started = true
    return { breakpoints: breakpointResults }
  }

  /** Resolve on the next stopped event, or immediately on end-of-session. */
  waitForStop(timeoutMs: number): Promise<DapStatus> {
    if (this.stopped || this.ended) return Promise.resolve(this.status())
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.stopListeners = this.stopListeners.filter((listener) => listener !== onStop)
        resolve(this.status())
      }, timeoutMs)
      timeout.unref?.()
      const onStop = () => {
        clearTimeout(timeout)
        resolve(this.status())
      }
      this.stopListeners.push(onStop)
    })
  }

  async disconnect(timeoutMs: number): Promise<void> {
    if (this.closed) return
    try {
      await this.request('disconnect', { terminateDebuggee: true }, timeoutMs)
    } catch {
      // The adapter may already be gone; process teardown owns the rest.
    }
  }

  private waitForInitialized(): Promise<void> {
    if (this.sawInitialized) return Promise.resolve()
    if (this.closed) return Promise.reject(new DapSessionError('debug adapter closed before initialization'))
    return new Promise((resolve) => this.initializedListeners.push(resolve))
  }

  private onData(chunk: Buffer): void {
    let messages: DapProtocolMessage[]
    try {
      messages = this.decoder.push(chunk)
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)))
      return
    }
    for (const message of messages) {
      if (message.type === 'response') this.onResponse(message as DapResponseMessage)
      else if (message.type === 'event') this.onEvent(message as DapEventMessage)
      else if (message.type === 'request') this.onReverseRequest(message as DapRequestMessage)
    }
  }

  private onResponse(response: DapResponseMessage): void {
    const pending = this.pending.get(response.request_seq)
    if (!pending) return
    this.pending.delete(response.request_seq)
    if (response.success) pending.resolve(response.body)
    else {
      pending.reject(new DapSessionError(
        `DAP ${pending.command} failed: ${response.message ?? 'unknown adapter error'}`,
      ))
    }
  }

  private onEvent(event: DapEventMessage): void {
    if (event.event === 'initialized') {
      this.sawInitialized = true
      const listeners = this.initializedListeners
      this.initializedListeners = []
      for (const listener of listeners) listener()
      return
    }
    if (event.event === 'stopped') {
      const data = body(event)
      this.stopped = {
        reason: typeof data.reason === 'string' ? data.reason : 'unknown',
        threadId: typeof data.threadId === 'number' ? data.threadId : undefined,
        description: typeof data.description === 'string' ? data.description : undefined,
        text: typeof data.text === 'string' ? data.text : undefined,
        allThreadsStopped: data.allThreadsStopped === true,
      }
      const listeners = this.stopListeners
      this.stopListeners = []
      for (const listener of listeners) listener()
      return
    }
    if (event.event === 'continued') {
      this.stopped = undefined
      return
    }
    if (event.event === 'exited') {
      const code = body(event).exitCode
      this.exitCode = typeof code === 'number' ? code : -1
      this.notifyEnd()
      return
    }
    if (event.event === 'terminated') {
      this.terminated = true
      this.notifyEnd()
      return
    }
    if (event.event === 'output') {
      const data = body(event)
      const category = typeof data.category === 'string' ? data.category : 'console'
      if (category === 'telemetry') return
      const text = typeof data.output === 'string' ? data.output : ''
      this.appendOutput(category === 'stdout' || category === 'console' ? text : `[${category}] ${text}`)
    }
  }

  private onReverseRequest(request: DapRequestMessage): void {
    const response: DapResponseMessage = {
      seq: ++this.seq,
      type: 'response',
      request_seq: request.seq,
      success: false,
      command: request.command,
      message: `oh-my-dsh does not support the ${request.command} reverse request`,
    }
    this.transport.write(encodeDapMessage(response))
  }

  private appendOutput(text: string): void {
    this.outputBuffer += text
    const excess = this.outputBuffer.length - this.options.maxOutputChars
    if (excess > 0) {
      this.outputBuffer = this.outputBuffer.slice(excess)
      this.outputDropped += excess
    }
  }

  private notifyEnd(): void {
    const listeners = this.stopListeners
    this.stopListeners = []
    for (const listener of listeners) listener()
  }

  private failAll(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const request of pending) request.reject(error)
  }

  private onClose(): void {
    if (this.closed) return
    this.closed = true
    this.failAll(new DapSessionError('debug adapter connection closed'))
    const listeners = this.initializedListeners
    this.initializedListeners = []
    for (const listener of listeners) listener()
    this.notifyEnd()
  }
}

class DapDeadline {
  private readonly expiresAt: number

  constructor(timeoutMs: number) {
    this.expiresAt = Date.now() + timeoutMs
  }

  async race<T>(operation: Promise<T>): Promise<T> {
    const remaining = this.expiresAt - Date.now()
    if (remaining <= 0) throw new DapSessionError('debug session startup deadline exceeded')
    let timeout: NodeJS.Timeout | undefined
    const expiry = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new DapSessionError('debug session startup deadline exceeded')),
        remaining,
      )
      timeout.unref?.()
    })
    try {
      return await Promise.race([operation, expiry])
    } finally {
      clearTimeout(timeout)
    }
  }
}
