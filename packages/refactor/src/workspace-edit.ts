export type PositionEncoding = 'utf-8' | 'utf-16' | 'utf-32'

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface NormalizedTextEdit {
  range: LspRange
  newText: string
}

export interface NormalizedDocumentEdit {
  uri: string
  version: number | null
  edits: NormalizedTextEdit[]
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function position(value: unknown, label: string): LspPosition {
  const raw = record(value, label)
  if (!Number.isInteger(raw.line) || !Number.isInteger(raw.character)) {
    throw new Error(`${label} line and character must be integers`)
  }
  const line = raw.line as number
  const character = raw.character as number
  if (line < 0 || character < 0) {
    throw new Error(`${label} line and character must be non-negative`)
  }
  return { line, character }
}

function textEdit(value: unknown, label: string): NormalizedTextEdit {
  const raw = record(value, label)
  const range = record(raw.range, `${label}.range`)
  if (typeof raw.newText !== 'string') throw new Error(`${label}.newText must be a string`)
  return {
    range: {
      start: position(range.start, `${label}.range.start`),
      end: position(range.end, `${label}.range.end`),
    },
    newText: raw.newText,
  }
}

function edits(value: unknown, label: string): NormalizedTextEdit[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((item, index) => textEdit(item, `${label}[${index}]`))
}

function fileUri(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid file URI`)
  }
  if (url.protocol !== 'file:') throw new Error(`${label} must be a file URI`)
  return url.toString()
}

export function normalizeWorkspaceEdit(value: unknown): NormalizedDocumentEdit[] {
  const workspaceEdit = record(value, 'WorkspaceEdit')
  const hasChanges = workspaceEdit.changes !== undefined
  const hasDocumentChanges = workspaceEdit.documentChanges !== undefined
  if (hasChanges && hasDocumentChanges) {
    throw new Error('WorkspaceEdit must not contain both changes and documentChanges')
  }
  const output: NormalizedDocumentEdit[] = []
  if (hasChanges) {
    const changes = record(workspaceEdit.changes, 'WorkspaceEdit.changes')
    for (const [rawUri, rawEdits] of Object.entries(changes)) {
      output.push({
        uri: fileUri(rawUri, 'WorkspaceEdit change URI'),
        version: null,
        edits: edits(rawEdits, `WorkspaceEdit.changes[${JSON.stringify(rawUri)}]`),
      })
    }
  } else if (hasDocumentChanges) {
    if (!Array.isArray(workspaceEdit.documentChanges)) {
      throw new Error('WorkspaceEdit.documentChanges must be an array')
    }
    const seen = new Set<string>()
    for (const [index, item] of workspaceEdit.documentChanges.entries()) {
      const change = record(item, `WorkspaceEdit.documentChanges[${index}]`)
      if ('kind' in change || !('textDocument' in change)) {
        throw new Error('WorkspaceEdit resource operations are not supported')
      }
      const document = record(
        change.textDocument,
        `WorkspaceEdit.documentChanges[${index}].textDocument`,
      )
      const uri = fileUri(document.uri, `WorkspaceEdit.documentChanges[${index}].textDocument.uri`)
      if (seen.has(uri)) throw new Error(`duplicate textDocument edit for ${uri}`)
      seen.add(uri)
      const version = document.version
      if (version !== null && !Number.isInteger(version)) {
        throw new Error('WorkspaceEdit textDocument version must be an integer or null')
      }
      output.push({
        uri,
        version: version as number | null,
        edits: edits(change.edits, `WorkspaceEdit.documentChanges[${index}].edits`),
      })
    }
  }
  return output.sort((left, right) => left.uri.localeCompare(right.uri))
}

function lineStartOffsets(content: string): number[] {
  const offsets = [0]
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') offsets.push(index + 1)
  }
  return offsets
}

function jsOffsetForCharacter(line: string, character: number, encoding: PositionEncoding): number {
  if (encoding === 'utf-16') {
    if (character > line.length) throw new Error('LSP character is beyond the end of the line')
    if (
      character > 0 &&
      character < line.length &&
      /[\uD800-\uDBFF]/.test(line[character - 1] as string) &&
      /[\uDC00-\uDFFF]/.test(line[character] as string)
    ) {
      throw new Error('LSP UTF-16 character splits a surrogate pair')
    }
    return character
  }

  let units = 0
  let jsOffset = 0
  for (const codePoint of line) {
    if (units === character) return jsOffset
    const width = encoding === 'utf-8' ? Buffer.byteLength(codePoint, 'utf8') : 1
    if (units + width > character) {
      throw new Error(`LSP ${encoding} character splits a code point`)
    }
    units += width
    jsOffset += codePoint.length
  }
  if (units === character) return jsOffset
  throw new Error('LSP character is beyond the end of the line')
}

function absoluteOffset(
  content: string,
  starts: number[],
  position: LspPosition,
  encoding: PositionEncoding,
): number {
  const start = starts[position.line]
  if (start === undefined) throw new Error('LSP line is beyond the end of the document')
  const newline = content.indexOf('\n', start)
  const end = newline === -1 ? content.length : newline
  return start + jsOffsetForCharacter(content.slice(start, end), position.character, encoding)
}

export function convertPositionEncoding(
  content: string,
  position: LspPosition,
  from: PositionEncoding,
  to: PositionEncoding,
): LspPosition {
  if (from === to) return { ...position }
  const starts = lineStartOffsets(content)
  const lineStart = starts[position.line]
  if (lineStart === undefined) throw new Error('LSP line is beyond the end of the document')
  const absolute = absoluteOffset(content, starts, position, from)
  const prefix = content.slice(lineStart, absolute)
  const character =
    to === 'utf-16'
      ? prefix.length
      : to === 'utf-8'
        ? Buffer.byteLength(prefix, 'utf8')
        : [...prefix].length
  return { line: position.line, character }
}

export function applyTextEdits(
  content: string,
  textEdits: NormalizedTextEdit[],
  encoding: PositionEncoding,
): string {
  const starts = lineStartOffsets(content)
  const resolved = textEdits
    .map((edit) => {
      const start = absoluteOffset(content, starts, edit.range.start, encoding)
      const end = absoluteOffset(content, starts, edit.range.end, encoding)
      if (end < start) throw new Error('text edit range end precedes start')
      return { start, end, newText: edit.newText }
    })
    .sort((left, right) => left.start - right.start || left.end - right.end)

  for (let index = 1; index < resolved.length; index += 1) {
    const previous = resolved[index - 1] as (typeof resolved)[number]
    const current = resolved[index] as (typeof resolved)[number]
    if (
      current.start < previous.end ||
      (current.start === previous.start && current.end === previous.end)
    ) {
      throw new Error('WorkspaceEdit contains overlapping text edits')
    }
  }

  let output = content
  for (const edit of [...resolved].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  )) {
    output = `${output.slice(0, edit.start)}${edit.newText}${output.slice(edit.end)}`
  }
  return output
}
