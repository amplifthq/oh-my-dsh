/**
 * Debug Adapter Protocol wire framing: `Content-Length: N\r\n\r\n{json}`
 * messages over a byte stream, decoded incrementally. Pure and
 * transport-agnostic so framing is testable without processes.
 * @module oh-my-dsh/debug/protocol
 */

export interface DapProtocolMessage {
  seq: number
  type: string
  [key: string]: unknown
}

export interface DapRequestMessage extends DapProtocolMessage {
  type: 'request'
  command: string
  arguments?: unknown
}

export interface DapResponseMessage extends DapProtocolMessage {
  type: 'response'
  request_seq: number
  success: boolean
  command: string
  message?: string
  body?: unknown
}

export interface DapEventMessage extends DapProtocolMessage {
  type: 'event'
  event: string
  body?: unknown
}

export function encodeDapMessage(message: object): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii'),
    payload,
  ])
}

const HEADER_TERMINATOR = Buffer.from('\r\n\r\n', 'ascii')

export class DapDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private expectedLength: number | undefined

  constructor(private readonly maxMessageBytes = 16_000_000) {}

  push(chunk: Buffer): DapProtocolMessage[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const messages: DapProtocolMessage[] = []
    for (;;) {
      if (this.expectedLength === undefined) {
        const headerEnd = this.buffer.indexOf(HEADER_TERMINATOR)
        if (headerEnd === -1) {
          if (this.buffer.length > 16_384) throw new Error('DAP header exceeds 16 KiB')
          break
        }
        const header = this.buffer.subarray(0, headerEnd).toString('ascii')
        const match = /content-length:\s*(\d+)/i.exec(header)
        if (!match) throw new Error(`DAP header is missing Content-Length: ${JSON.stringify(header)}`)
        const length = Number(match[1])
        if (!Number.isSafeInteger(length) || length < 0 || length > this.maxMessageBytes) {
          throw new Error(`DAP message length ${length} exceeds the ${this.maxMessageBytes}-byte cap`)
        }
        this.expectedLength = length
        this.buffer = this.buffer.subarray(headerEnd + HEADER_TERMINATOR.length)
      }
      if (this.buffer.length < this.expectedLength) break
      const payload = this.buffer.subarray(0, this.expectedLength)
      this.buffer = this.buffer.subarray(this.expectedLength)
      this.expectedLength = undefined
      const parsed: unknown = JSON.parse(payload.toString('utf8'))
      if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
        throw new Error('DAP payload is not a protocol message')
      }
      messages.push(parsed as DapProtocolMessage)
    }
    return messages
  }
}
