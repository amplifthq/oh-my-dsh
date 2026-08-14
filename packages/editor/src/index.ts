/**
 * Stale-safe editing by line-content anchors. A read returns `line:hash|text`;
 * mutations verify both the line number and hash against the current file
 * before a version-guarded atomic write.
 * @module oh-my-dsh/editor
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

export const name = 'omd-editor'
export const inject = ['tools', 'fs', 'systemPrompt']

export function lineHash(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 8)
}

export function renderAnchoredLines(content: string, offset = 1, limit = 200): string {
  const lines = content.split('\n')
  const start = Math.max(1, offset)
  const end = Math.min(lines.length, start + Math.max(1, limit) - 1)
  const rendered = lines
    .slice(start - 1, end)
    .map((line, index) => `${start + index}:${lineHash(line)}|${line}`)
  const footer = end < lines.length ? `\n[${lines.length - end} more lines; resume at offset ${end + 1}]` : ''
  return rendered.join('\n') + footer
}

interface ParsedAnchor {
  line: number
  hash: string
}

export function parseAnchor(anchor: string): ParsedAnchor {
  const match = /^([1-9]\d*):([a-f0-9]{8})$/.exec(anchor.trim())
  if (!match) throw new Error(`invalid anchor "${anchor}"; expected <line>:<8-hex-hash>`)
  return { line: Number(match[1]), hash: match[2] as string }
}

function verifyAnchor(lines: string[], anchor: string): number {
  const parsed = parseAnchor(anchor)
  const index = parsed.line - 1
  const line = lines[index]
  if (line === undefined) {
    throw new Error(`stale anchor ${anchor}: file now has only ${lines.length} lines`)
  }
  const actual = lineHash(line)
  if (actual !== parsed.hash) {
    throw new Error(`stale anchor ${anchor}: current line ${parsed.line} has hash ${actual}; read the file again`)
  }
  return index
}

export function replaceAnchoredRange(
  content: string,
  startAnchor: string,
  endAnchor: string,
  replacement: string,
  expectedAnchors: readonly string[],
): string {
  const lines = content.split('\n')
  const start = verifyAnchor(lines, startAnchor)
  const end = verifyAnchor(lines, endAnchor)
  if (end < start) throw new Error('end_anchor must not precede start_anchor')
  if (expectedAnchors.length !== end - start + 1) {
    throw new Error(`expected_anchors must cover every line in the range (${end - start + 1} anchors required)`)
  }
  expectedAnchors.forEach((anchor, offset) => {
    const parsed = parseAnchor(anchor)
    if (parsed.line !== start + offset + 1) {
      throw new Error('expected_anchors must be consecutive and ordered from start_anchor to end_anchor')
    }
    verifyAnchor(lines, anchor)
  })
  if (expectedAnchors[0] !== startAnchor || expectedAnchors.at(-1) !== endAnchor) {
    throw new Error('expected_anchors must begin with start_anchor and end with end_anchor')
  }
  const replacementLines = replacement === '' ? [] : replacement.split('\n')
  return [...lines.slice(0, start), ...replacementLines, ...lines.slice(end + 1)].join('\n')
}

export function insertAfterAnchor(content: string, anchor: string, text: string): string {
  const lines = content.split('\n')
  const index = verifyAnchor(lines, anchor)
  return [...lines.slice(0, index + 1), ...text.split('\n'), ...lines.slice(index + 1)].join('\n')
}

class MutationPolicy {
  private readonly policy: SandboxPolicyService | undefined

  constructor(ctx: Context) {
    this.policy = ctx.fs.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy')
    if (ctx.fs.sandboxMode !== undefined && this.policy === undefined) {
      throw new Error('omd-editor: confined filesystem requires ctx.sandboxPolicy')
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

async function targetFor(ctx: Context, filePath: string, exec: ToolRunContext): Promise<FsTarget> {
  if (!filePath.trim()) throw new Error('file_path must not be empty')
  return ctx.fs.resolve(filePath, {
    cwd: exec.agent?.session.header.cwd,
    signal: exec.signal,
  })
}

export function apply(ctx: Context): void {
  const policy = new MutationPolicy(ctx)

  ctx.systemPrompt.section({
    name: 'tool:hash-edit',
    order: 111,
    text: 'Prefer hash_edit for multi-line changes: read anchors immediately before editing, then replace the exact anchored range. A stale anchor is a safety signal; reread instead of guessing.',
  })

  ctx.tools.register(defineTool({
    name: 'hash_edit',
    description:
      'Read a text file with stale-safe line hashes, replace an inclusive anchored range, '
      + 'or insert after one anchored line. Anchors are returned by the read operation.',
    parameters: {
      operation: {
        type: 'string',
        required: true,
        enum: ['read', 'replace', 'insert_after'],
        description: 'Operation to perform.',
      },
      file_path: {
        type: 'string',
        required: true,
        description: 'Absolute path or path relative to the session workspace.',
      },
      offset: { type: 'integer', description: 'First one-based line for read (default 1).' },
      limit: { type: 'integer', description: 'Maximum lines for read (default 200, max 1000).' },
      start_anchor: { type: 'string', description: 'First line anchor from read, e.g. 12:a1b2c3d4.' },
      end_anchor: { type: 'string', description: 'Last line anchor from read; inclusive.' },
      expected_anchors: {
        type: 'array',
        items: { type: 'string' },
        description: 'Every consecutive line anchor in the replaced range, copied from the latest read.',
      },
      anchor: { type: 'string', description: 'Anchor used by insert_after.' },
      text: { type: 'string', description: 'Replacement or inserted text. Empty text deletes a range.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const target = await targetFor(ctx, args.file_path, exec)
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) {
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        throw new FsError(`file not found: ${target.displayPath}`, 'FS_NOT_FOUND')
      }
      if (info.type !== 'file') {
        throw new FsError(`not a regular file: ${target.displayPath}`, 'FS_NOT_REGULAR_FILE')
      }
      const before = await ctx.fs.readText(target, exec.signal)
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)

      if (args.operation === 'read') {
        const offset = args.offset ?? 1
        const limit = Math.min(args.limit ?? 200, 1000)
        if (!Number.isInteger(offset) || offset < 1) throw new Error('offset must be a positive integer')
        if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
        return renderAnchoredLines(before, offset, limit)
      }

      const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
      const expected: FsWriteIntent = intent === undefined
        ? { kind: 'replaceIfVersion', version: info.version }
        : { kind: 'replaceIfVersion', version: intent.version }
      let after: string
      if (args.operation === 'replace') {
        if (!args.start_anchor || !args.end_anchor || !args.expected_anchors) {
          throw new Error('replace requires start_anchor, end_anchor, and expected_anchors')
        }
        after = replaceAnchoredRange(
          before,
          args.start_anchor,
          args.end_anchor,
          args.text ?? '',
          args.expected_anchors,
        )
      } else {
        if (!args.anchor) throw new Error('insert_after requires anchor')
        if (args.text === undefined) throw new Error('insert_after requires text')
        after = insertAfterAnchor(before, args.anchor, args.text)
      }

      const sandboxPolicy = policy.resolve(exec)
      try {
        const outcome = await ctx.fs.writeText(target, after, expected, exec.signal, sandboxPolicy)
        ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      } catch (error) {
        throw policy.mapError(error, sandboxPolicy)
      }
      const changed = Math.max(1, Math.abs(after.split('\n').length - before.split('\n').length))
      return `Updated ${target.displayPath} (${changed} line delta unit${changed === 1 ? '' : 's'}).`
    },
  }))
}
