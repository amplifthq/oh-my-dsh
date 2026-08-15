import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface RefactorJournalFile {
  path: string
  before: string
  after: string
}

export interface RefactorJournal {
  version: 1
  id: string
  cwd: string
  status: 'applying' | 'rollback-needed'
  files: RefactorJournalFile[]
}

export interface VersionedFileChange extends RefactorJournalFile {
  version: string
}

export interface RefactorApplyOperations {
  saveJournal(files: VersionedFileChange[], status: RefactorJournal['status']): void | Promise<void>
  clearJournal(): void | Promise<void>
  write(
    file: VersionedFileChange,
    content: string,
    expectedVersion: string,
    phase: 'apply' | 'rollback',
  ): string | Promise<string>
  afterWrite?(
    file: VersionedFileChange,
    version: string,
    phase: 'apply' | 'rollback',
  ): void | Promise<void>
}

export interface RefactorApplyResult {
  journalCleared: boolean
  warning?: string
}

function validateJournal(value: unknown): RefactorJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('refactor journal must be an object')
  }
  const raw = value as Record<string, unknown>
  if (
    raw.version !== 1 ||
    typeof raw.id !== 'string' ||
    typeof raw.cwd !== 'string' ||
    (raw.status !== 'applying' && raw.status !== 'rollback-needed') ||
    !Array.isArray(raw.files)
  ) {
    throw new Error('invalid refactor journal header')
  }
  const files = raw.files.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`invalid refactor journal file ${index}`)
    }
    const file = value as Record<string, unknown>
    if (
      typeof file.path !== 'string' ||
      typeof file.before !== 'string' ||
      typeof file.after !== 'string'
    ) {
      throw new Error(`invalid refactor journal file ${index}`)
    }
    return { path: file.path, before: file.before, after: file.after }
  })
  return {
    version: 1,
    id: raw.id,
    cwd: raw.cwd,
    status: raw.status,
    files,
  }
}

export function writeRefactorJournal(path: string, journal: RefactorJournal): void {
  const validated = validateJournal(journal)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}

export function readRefactorJournal(path: string): RefactorJournal {
  return validateJournal(JSON.parse(readFileSync(path, 'utf8')))
}

export function planJournalRecovery(
  journal: RefactorJournal,
  currentContents: Record<string, string>,
): Array<{ path: string; content: string }> {
  const recovery: Array<{ path: string; content: string }> = []
  for (const file of journal.files) {
    const current = currentContents[file.path]
    if (current === file.before) continue
    if (current !== file.after) {
      throw new Error(`${file.path} changed after the refactor; refusing recovery`)
    }
    recovery.push({ path: file.path, content: file.before })
  }
  return recovery
}

export async function applyWithRollback(
  files: VersionedFileChange[],
  operations: RefactorApplyOperations,
): Promise<RefactorApplyResult> {
  await operations.saveJournal(files, 'applying')
  const applied: Array<{ file: VersionedFileChange; version: string }> = []
  try {
    for (const file of files) {
      const version = await operations.write(file, file.after, file.version, 'apply')
      applied.push({ file, version })
      await operations.afterWrite?.(file, version, 'apply')
    }
  } catch (error) {
    const rollbackErrors: Error[] = []
    for (const { file, version } of [...applied].reverse()) {
      try {
        const rollbackVersion = await operations.write(file, file.before, version, 'rollback')
        await operations.afterWrite?.(file, rollbackVersion, 'rollback')
      } catch (rollbackError) {
        rollbackErrors.push(
          rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
        )
      }
    }
    if (rollbackErrors.length) {
      await operations.saveJournal(files, 'rollback-needed')
      throw new AggregateError(
        [error, ...rollbackErrors],
        `refactor apply failed and rollback is incomplete: ${String(error)}`,
      )
    }
    try {
      await operations.clearJournal()
    } catch (clearError) {
      throw new AggregateError(
        [error, clearError],
        `refactor apply failed, rollback succeeded, and journal cleanup failed: ${String(error)}`,
      )
    }
    throw error
  }
  try {
    await operations.clearJournal()
    return { journalCleared: true }
  } catch (error) {
    return {
      journalCleared: false,
      warning: error instanceof Error ? error.message : String(error),
    }
  }
}
