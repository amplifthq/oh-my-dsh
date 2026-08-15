import {
  convertPositionEncoding,
  type LspPosition,
  type PositionEncoding,
} from './workspace-edit.js'

export interface JsonRpcConnection {
  request(method: string, params: unknown): Promise<unknown>
  notify(method: string, params: unknown): Promise<void>
}

export interface LspServerRequestContext {
  configuration: unknown
  workspaceFolders: Array<{ uri: string; name: string }>
}

export interface LspDocumentSnapshot {
  documentUri: string
  languageId: string
  content: string
}

export interface OneShotRenameRequest {
  processId: number
  workspaceUri: string
  documentUri: string
  languageId: string
  content: string
  additionalDocuments?: LspDocumentSnapshot[]
  position: LspPosition
  positionEncoding?: PositionEncoding
  newName: string
  initializationOptions?: unknown
}

export interface OneShotRenameResult {
  encoding: PositionEncoding
  workspaceEdit: unknown
}

export interface OneShotDiagnosticsRequest {
  processId: number
  workspaceUri: string
  documentUri: string
  languageId: string
  content: string
  initializationOptions?: unknown
}

export interface OneShotDiagnosticsResult {
  supported: boolean
  items: unknown[]
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted`),
    )
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted`))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function positionEncoding(initializeResult: unknown): PositionEncoding {
  const capabilities = object(object(initializeResult)?.capabilities)
  const encoding = capabilities?.positionEncoding
  if (encoding === undefined) return 'utf-16'
  if (encoding === 'utf-8' || encoding === 'utf-16' || encoding === 'utf-32') return encoding
  throw new Error(
    `language server selected unsupported position encoding ${JSON.stringify(encoding)}`,
  )
}

export async function answerLspServerRequest(
  method: string,
  params: unknown,
  context: LspServerRequestContext,
): Promise<unknown> {
  if (method === 'workspace/applyEdit') {
    throw new Error(
      'server-driven workspace edits are disabled; only returned proposal edits are accepted',
    )
  }
  if (method === 'workspace/configuration') {
    const items = object(params)?.items
    if (!Array.isArray(items)) return []
    return items.map(() => context.configuration)
  }
  if (method === 'workspace/workspaceFolders') {
    return structuredClone(context.workspaceFolders)
  }
  if (
    method === 'client/registerCapability' ||
    method === 'client/unregisterCapability' ||
    method === 'window/workDoneProgress/create'
  ) {
    return null
  }
  throw new Error(`server request is not supported: ${method}`)
}

export async function executeOneShotRename(
  connection: JsonRpcConnection,
  request: OneShotRenameRequest,
): Promise<OneShotRenameResult> {
  const documents: LspDocumentSnapshot[] = [
    {
      documentUri: request.documentUri,
      languageId: request.languageId,
      content: request.content,
    },
    ...(request.additionalDocuments ?? []),
  ]
  const documentUris = new Set(documents.map((document) => document.documentUri))
  if (documentUris.size !== documents.length) {
    throw new Error('rename document snapshots must have unique URIs')
  }
  const initializeResult = await connection.request('initialize', {
    processId: request.processId,
    clientInfo: { name: 'oh-my-dsh', version: '0.1' },
    rootUri: request.workspaceUri,
    workspaceFolders: [{ uri: request.workspaceUri, name: 'workspace' }],
    initializationOptions: request.initializationOptions ?? null,
    capabilities: {
      general: {
        positionEncodings: ['utf-8', 'utf-16', 'utf-32'],
      },
      workspace: {
        applyEdit: false,
        workspaceEdit: {
          documentChanges: true,
          normalizesLineEndings: true,
        },
        configuration: true,
        workspaceFolders: true,
      },
      textDocument: {
        rename: { prepareSupport: false },
      },
    },
  })
  const capabilities = object(object(initializeResult)?.capabilities)
  if (!capabilities?.renameProvider) {
    throw new Error('language server does not advertise rename support')
  }
  const encoding = positionEncoding(initializeResult)
  await connection.notify('initialized', {})
  const opened: string[] = []
  try {
    for (const document of documents) {
      await connection.notify('textDocument/didOpen', {
        textDocument: {
          uri: document.documentUri,
          languageId: document.languageId,
          version: 1,
          text: document.content,
        },
      })
      opened.push(document.documentUri)
    }
    const workspaceEdit = await connection.request('textDocument/rename', {
      textDocument: { uri: request.documentUri },
      position: convertPositionEncoding(
        request.content,
        request.position,
        request.positionEncoding ?? 'utf-16',
        encoding,
      ),
      newName: request.newName,
    })
    if (workspaceEdit === null || workspaceEdit === undefined) {
      throw new Error('language server returned no rename edits')
    }
    return { encoding, workspaceEdit }
  } finally {
    for (const uri of opened.reverse()) {
      await connection.notify('textDocument/didClose', {
        textDocument: { uri },
      })
    }
    await connection.request('shutdown', null)
    await connection.notify('exit', null)
  }
}

export async function executeOneShotDiagnostics(
  connection: JsonRpcConnection,
  request: OneShotDiagnosticsRequest,
): Promise<OneShotDiagnosticsResult> {
  const initializeResult = await connection.request('initialize', {
    processId: request.processId,
    clientInfo: { name: 'oh-my-dsh', version: '0.1' },
    rootUri: request.workspaceUri,
    workspaceFolders: [{ uri: request.workspaceUri, name: 'workspace' }],
    initializationOptions: request.initializationOptions ?? null,
    capabilities: {
      workspace: {
        applyEdit: false,
        configuration: true,
        workspaceFolders: true,
      },
      textDocument: {
        diagnostic: {
          dynamicRegistration: false,
          relatedDocumentSupport: true,
        },
      },
    },
  })
  const capabilities = object(object(initializeResult)?.capabilities)
  await connection.notify('initialized', {})
  let opened = false
  try {
    if (!capabilities?.diagnosticProvider) return { supported: false, items: [] }
    await connection.notify('textDocument/didOpen', {
      textDocument: {
        uri: request.documentUri,
        languageId: request.languageId,
        version: 1,
        text: request.content,
      },
    })
    opened = true
    const report = object(
      await connection.request('textDocument/diagnostic', {
        textDocument: { uri: request.documentUri },
      }),
    )
    return {
      supported: true,
      items: Array.isArray(report?.items) ? report.items : [],
    }
  } finally {
    if (opened) {
      await connection.notify('textDocument/didClose', {
        textDocument: { uri: request.documentUri },
      })
    }
    await connection.request('shutdown', null)
    await connection.notify('exit', null)
  }
}
