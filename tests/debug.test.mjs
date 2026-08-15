import assert from 'node:assert/strict'
import test from 'node:test'
import { DapDecoder, encodeDapMessage } from '../dist/packages/debug/src/protocol.js'
import { DapSession } from '../dist/packages/debug/src/session.js'
import { discoverAdapters, mergeLaunchArguments } from '../dist/packages/debug/src/adapters.js'

test('DAP framing round-trips across arbitrary chunk boundaries', () => {
  const first = encodeDapMessage({ seq: 1, type: 'request', command: 'initialize' })
  const second = encodeDapMessage({
    seq: 2,
    type: 'event',
    event: 'stopped',
    body: { reason: 'entry' },
  })
  const stream = Buffer.concat([first, second])
  const decoder = new DapDecoder()
  const messages = []
  for (let at = 0; at < stream.length; at += 3) {
    messages.push(...decoder.push(stream.subarray(at, at + 3)))
  }
  assert.equal(messages.length, 2)
  assert.equal(messages[0].command, 'initialize')
  assert.equal(messages[1].event, 'stopped')
})

test('DAP decoder rejects oversized and malformed frames', () => {
  const oversized = new DapDecoder(64)
  assert.throws(
    () => oversized.push(Buffer.from('Content-Length: 100000\r\n\r\n', 'ascii')),
    /exceeds the 64-byte cap/,
  )
  const malformed = new DapDecoder()
  assert.throws(
    () => malformed.push(Buffer.from('X-Nope: 1\r\n\r\n', 'ascii')),
    /missing Content-Length/,
  )
})

/**
 * In-memory scripted adapter. `script(request, respond, emit)` decides how to
 * answer each decoded request; writes from the session are delivered
 * synchronously, which also exercises re-entrancy safety.
 */
function scriptedTransport(script) {
  const decoder = new DapDecoder()
  const dataHandlers = []
  const closeHandlers = []
  let adapterSeq = 1000
  const deliver = (message) => {
    const encoded = encodeDapMessage(message)
    for (const handler of dataHandlers) handler(encoded)
  }
  const api = {
    received: [],
    respond: (request, body, success = true, message = undefined) =>
      deliver({
        seq: ++adapterSeq,
        type: 'response',
        request_seq: request.seq,
        success,
        command: request.command,
        ...(message ? { message } : {}),
        ...(body !== undefined ? { body } : {}),
      }),
    emit: (event, body) =>
      deliver({ seq: ++adapterSeq, type: 'event', event, ...(body !== undefined ? { body } : {}) }),
    sendRequest: (command, args) =>
      deliver({ seq: ++adapterSeq, type: 'request', command, arguments: args }),
    close: () => {
      for (const handler of closeHandlers) handler()
    },
  }
  const transport = {
    write: (data) => {
      for (const message of decoder.push(data)) {
        api.received.push(message)
        script(message, api)
      }
    },
    onData: (handler) => dataHandlers.push(handler),
    onClose: (handler) => closeHandlers.push(handler),
  }
  return { transport, api }
}

const sessionOptions = { requestTimeoutMs: 1_000, maxOutputChars: 200 }

test('start() follows initialize → initialized → breakpoints → configurationDone → launch', async () => {
  let pendingLaunch
  const order = []
  const { transport } = scriptedTransport((request, api) => {
    order.push(request.command)
    if (request.command === 'initialize') {
      api.respond(request, { supportsConfigurationDoneRequest: true })
      api.emit('initialized')
      return
    }
    if (request.command === 'launch') {
      pendingLaunch = request
      return
    }
    if (request.command === 'setBreakpoints') {
      api.respond(request, {
        breakpoints: request.arguments.breakpoints.map((b) => ({ verified: true, line: b.line })),
      })
      return
    }
    if (request.command === 'configurationDone') {
      api.respond(request, {})
      api.respond(pendingLaunch, {})
      api.emit('stopped', { reason: 'entry', threadId: 1 })
    }
  })
  const session = new DapSession(transport, sessionOptions)
  const started = await session.start(
    {
      request: 'launch',
      arguments: { program: '/w/main.py' },
      breakpoints: [{ path: '/w/main.py', breakpoints: [{ line: 3 }] }],
    },
    2_000,
  )
  assert.deepEqual(order, ['initialize', 'launch', 'setBreakpoints', 'configurationDone'])
  assert.deepEqual(started.breakpoints, [
    { path: '/w/main.py', verified: [{ verified: true, line: 3 }] },
  ])
  const status = session.status()
  assert.equal(status.state, 'stopped')
  assert.equal(status.stopped.reason, 'entry')
  assert.equal(session.stoppedThreadId(), 1)
})

test('continued events clear the stopped state and waitForStop resolves on the next stop', async () => {
  const { transport, api } = scriptedTransport((request, api) => api.respond(request, {}))
  const session = new DapSession(transport, sessionOptions)
  api.emit('stopped', { reason: 'breakpoint', threadId: 7 })
  assert.equal(session.status().state, 'configuring')
  api.emit('continued', {})
  assert.equal(session.stoppedThreadId(), undefined)
  const wait = session.waitForStop(1_000)
  api.emit('stopped', { reason: 'step', threadId: 7 })
  const status = await wait
  assert.equal(status.stopped.reason, 'step')
})

test('output events are buffered with a bounded tail', async () => {
  const { transport, api } = scriptedTransport(() => {})
  const session = new DapSession(transport, sessionOptions)
  api.emit('output', { category: 'stdout', output: 'x'.repeat(150) })
  api.emit('output', { category: 'stderr', output: 'boom\n' })
  api.emit('output', { category: 'telemetry', output: 'ignored' })
  api.emit('output', { category: 'stdout', output: 'y'.repeat(100) })
  const read = session.readOutput()
  assert.equal(read.text.length, 200)
  assert.ok(read.droppedChars > 0)
  assert.ok(read.text.endsWith('y'.repeat(100)))
  assert.match(read.text, /\[stderr\] boom/)
  const empty = session.readOutput()
  assert.equal(empty.text, '')
  assert.equal(empty.droppedChars, 0)
})

test('reverse requests such as runInTerminal are answered with a failure response', () => {
  const { transport, api } = scriptedTransport(() => {})
  void new DapSession(transport, sessionOptions)
  api.sendRequest('runInTerminal', { args: ['sh'] })
  const reply = api.received.find((message) => message.type === 'response')
  assert.ok(reply)
  assert.equal(reply.success, false)
  assert.equal(reply.command, 'runInTerminal')
  assert.match(reply.message, /does not support/)
})

test('unanswered requests time out and adapter close rejects pending requests', async () => {
  const { transport } = scriptedTransport(() => {})
  const session = new DapSession(transport, { requestTimeoutMs: 40, maxOutputChars: 200 })
  await assert.rejects(session.request('threads'), /timed out after 40ms/)

  const closing = scriptedTransport(() => {})
  const closingSession = new DapSession(closing.transport, sessionOptions)
  const pending = closingSession.request('threads')
  closing.api.close()
  await assert.rejects(pending, /connection closed/)
  assert.equal(closingSession.ended, true)
  await assert.rejects(closingSession.request('threads'), /connection is closed/)
})

test('exited and terminated events end the session and release stop waiters', async () => {
  const { transport, api } = scriptedTransport(() => {})
  const session = new DapSession(transport, sessionOptions)
  const wait = session.waitForStop(1_000)
  api.emit('exited', { exitCode: 3 })
  const status = await wait
  assert.equal(status.exitCode, 3)
  assert.equal(session.ended, true)
})

test('mergeLaunchArguments lets defaults and user config through but never the validated core', () => {
  const adapter = {
    id: 'debugpy',
    description: '',
    argv: ['python3', '-m', 'debugpy.adapter'],
    languages: ['python'],
    launchDefaults: { type: 'python', justMyCode: true },
    supportsAttach: true,
  }
  const merged = mergeLaunchArguments(
    adapter,
    { justMyCode: false, program: '/etc/passwd', cwd: '/', stopOnEntry: false },
    { program: '/w/main.py', args: ['--x'], cwd: '/w', stopOnEntry: true },
  )
  assert.equal(merged.type, 'python')
  assert.equal(merged.justMyCode, false)
  assert.equal(merged.program, '/w/main.py')
  assert.equal(merged.cwd, '/w')
  assert.equal(merged.stopOnEntry, true)
  assert.deepEqual(merged.args, ['--x'])
  assert.equal('env' in merged, false)
})

test('discoverAdapters keeps resolvable custom adapters and drops missing ones', async () => {
  const host = {
    resolveExecutable: async (command) => {
      if (command === 'my-dap') return '/opt/bin/my-dap'
      throw new Error(`not found: ${command}`)
    },
    probeCommand: async () => false,
  }
  const adapters = await discoverAdapters(
    {
      mine: { command: 'my-dap', args: ['--stdio'], languages: ['zig'] },
      ghost: { command: 'missing-dap' },
    },
    host,
  )
  assert.deepEqual(Object.keys(adapters), ['mine'])
  assert.deepEqual(adapters.mine.argv, ['/opt/bin/my-dap', '--stdio'])
  assert.equal(adapters.mine.supportsAttach, false)
})

test('discoverAdapters registers debugpy only when the import probe succeeds', async () => {
  const host = {
    resolveExecutable: async (command) => {
      if (command === 'python3') return '/usr/bin/python3'
      throw new Error(`not found: ${command}`)
    },
    probeCommand: async (argv) => argv.join(' ').includes('import debugpy'),
  }
  const adapters = await discoverAdapters({}, host)
  assert.ok(adapters.debugpy)
  assert.deepEqual(adapters.debugpy.argv, ['/usr/bin/python3', '-m', 'debugpy.adapter'])

  const withoutDebugpy = await discoverAdapters({}, { ...host, probeCommand: async () => false })
  assert.equal(withoutDebugpy.debugpy, undefined)
})
