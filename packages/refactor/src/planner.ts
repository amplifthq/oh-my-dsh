import {
  applyTextEdits,
  type NormalizedDocumentEdit,
  type NormalizedTextEdit,
  type PositionEncoding,
} from './workspace-edit.js'

export interface RefactorDocumentState<TTarget = unknown> {
  target: TTarget
  path: string
  content: string
  version: string
}

export interface RefactorFilePlan<TTarget = unknown> {
  target: TTarget
  path: string
  before: string
  after: string
  version: string
  edits: NormalizedTextEdit[]
}

export type RefactorDocumentReader<TTarget> = (
  uri: string,
) => Promise<RefactorDocumentState<TTarget> | undefined>

export interface RefactorReadLimits {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
}

export class RefactorReadBudget {
  private readonly bytesByPath = new Map<string, number>()
  private totalBytes = 0

  constructor(private readonly limits: RefactorReadLimits) {}

  accept(path: string, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`invalid file size for ${path}`)
    }
    if (bytes > this.limits.maxFileBytes) {
      throw new Error(`${path} exceeds ${this.limits.maxFileBytes} bytes`)
    }
    const previous = this.bytesByPath.get(path)
    if (previous === undefined && this.bytesByPath.size >= this.limits.maxFiles) {
      throw new Error(`semantic refactor touches more than ${this.limits.maxFiles} files`)
    }
    const accounted = Math.max(previous ?? 0, bytes)
    const nextTotal = this.totalBytes - (previous ?? 0) + accounted
    if (nextTotal > this.limits.maxTotalBytes) {
      throw new Error(`semantic refactor input exceeds ${this.limits.maxTotalBytes} bytes`)
    }
    this.bytesByPath.set(path, accounted)
    this.totalBytes = nextTotal
  }
}

export function decodeRefactorText(bytes: Uint8Array, path: string): string {
  let content: string
  try {
    content = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes)
  } catch (error) {
    throw new Error(`${path} is not valid UTF-8 text`, { cause: error })
  }
  if (content.includes('\0')) throw new Error(`${path} is not text`)
  return content
}

export async function buildRefactorFilePlans<TTarget>(
  documents: NormalizedDocumentEdit[],
  encoding: PositionEncoding,
  read: RefactorDocumentReader<TTarget>,
): Promise<Array<RefactorFilePlan<TTarget>>> {
  const plans: Array<RefactorFilePlan<TTarget>> = []
  for (const document of documents) {
    const state = await read(document.uri)
    if (!state) throw new Error(`language server returned an unreadable document ${document.uri}`)
    const after = applyTextEdits(state.content, document.edits, encoding)
    if (after === state.content) continue
    plans.push({
      target: state.target,
      path: state.path,
      before: state.content,
      after,
      version: state.version,
      edits: structuredClone(document.edits),
    })
  }
  return plans
}
