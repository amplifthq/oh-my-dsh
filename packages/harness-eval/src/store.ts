import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import {
  DIGEST_PATTERN,
  EVAL_STORE_DIR,
  GREP_DEFAULT_HITS,
  GREP_MAX_HITS,
  type CompareResult,
  type EvalArtifactRef,
  type GrepScope,
  type Intervention,
  type ScoreRecord,
  evalArtifactPath,
  parseScoreRecord,
  snapshotDigest,
  type SnapshotComposition,
} from './contract.js'
import { parseEvalTaskDocument, suiteDigest, taskDigest, type EvalTaskDocument } from './task.js'

export const INDEX_RETAIN = 2_000

export interface EvalRoots {
  dshHome: string
  workspace?: string
  bundledTasks: string
}

export interface SnapshotBlob {
  ref: string
  bytes: Buffer
}

export interface StoredSnapshot {
  composition: SnapshotComposition
  digest: string
  digestMatches: boolean
  patch?: Buffer
  files: SnapshotBlob[]
  dir: string
}

export interface EvidenceNode {
  id: string
  skill: string
  kind: string
  pass: boolean
  tool?: string
  evidence_ref?: string
}

export interface EvidenceTree {
  task_id: string
  suite_digest: string
  plan: EvalTaskDocument['plan']
  nodes: EvidenceNode[]
}

export interface StoredRun {
  run_id: string
  score: ScoreRecord
  tree: EvidenceTree
  traces: unknown[]
  meta: Record<string, unknown>
  intervention: Intervention | null
}

export function evalStoreRoot(roots: EvalRoots): string {
  return resolve(roots.dshHome, EVAL_STORE_DIR)
}

function storeRoot(roots: EvalRoots): string {
  return evalStoreRoot(roots)
}

async function refuseSymlink(path: string, label: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined)
  if (stat?.isSymbolicLink()) {
    throw new Error(`${label} ${path} is a symlink; refusing to write through it`)
  }
}

function assertInside(root: string, path: string, label: string): void {
  const rel = relative(resolve(root), resolve(path))
  if (rel.startsWith('..')) throw new Error(`${label} ${path} escapes ${root}`)
}

async function writeAtomic(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await refuseSymlink(path, 'eval file')
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: 0o644, flag: 'wx' })
    await rename(temp, path)
    await chmod(path, 0o644)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

export async function writeSnapshot(
  roots: EvalRoots,
  composition: SnapshotComposition,
  blobs: { patch?: Buffer; files: SnapshotBlob[] },
): Promise<{ digest: string; dir: string }> {
  const digest = snapshotDigest(composition)
  const dir = resolve(storeRoot(roots), 'snapshots', digest)
  assertInside(storeRoot(roots), dir, 'snapshot')
  await mkdir(dir, { recursive: true })
  await refuseSymlink(dir, 'snapshot directory')
  await writeAtomic(join(dir, 'snapshot.json'), `${JSON.stringify(composition, null, 2)}\n`)
  await writeAtomic(join(dir, 'patch.yml'), blobs.patch ?? Buffer.alloc(0))
  for (const file of blobs.files) {
    const name = Buffer.from(file.ref).toString('hex')
    await writeAtomic(join(dir, 'files', name), file.bytes)
  }
  return { digest, dir }
}

export async function readSnapshot(
  roots: EvalRoots,
  digest: string,
): Promise<StoredSnapshot | undefined> {
  if (!DIGEST_PATTERN.test(digest)) throw new Error('snapshot digest must be a 64-char SHA-256')
  const dir = resolve(storeRoot(roots), 'snapshots', digest)
  let raw: string
  try {
    raw = await readFile(join(dir, 'snapshot.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const composition = JSON.parse(raw) as SnapshotComposition
  const recomputed = snapshotDigest(composition)
  const files: SnapshotBlob[] = []
  const fileDir = join(dir, 'files')
  const names = await readdir(fileDir).catch(() => [])
  for (const name of names) {
    const bytes = await readFile(join(fileDir, name))
    files.push({ ref: Buffer.from(name, 'hex').toString('utf8'), bytes })
  }
  const patch = await readFile(join(dir, 'patch.yml')).catch(() => Buffer.alloc(0))
  return {
    composition,
    digest,
    digestMatches: recomputed === digest,
    patch: patch.length ? patch : undefined,
    files,
    dir,
  }
}

export async function writeRun(
  roots: EvalRoots,
  input: {
    task_id: string
    snapshot_digest: string
    suite_digest: string
    intervention: Intervention | null
    score: Omit<ScoreRecord, 'run_id'>
    tree: EvidenceTree
    traces: unknown[]
    meta: Record<string, unknown>
  },
): Promise<{ run_id: string }> {
  const run_id = `run-${randomBytes(6).toString('hex')}`
  const dir = resolve(storeRoot(roots), 'runs', run_id)
  assertInside(storeRoot(roots), dir, 'run')
  await mkdir(dir, { recursive: true })
  await refuseSymlink(dir, 'run directory')
  const score = parseScoreRecord({ ...input.score, run_id })
  await writeAtomic(
    join(dir, 'meta.json'),
    `${JSON.stringify({ ...input.meta, run_id, task_id: input.task_id }, null, 2)}\n`,
  )
  await writeAtomic(join(dir, 'score.json'), `${JSON.stringify(score, null, 2)}\n`)
  await writeAtomic(
    join(dir, 'intervention.json'),
    `${JSON.stringify(input.intervention, null, 2)}\n`,
  )
  await writeAtomic(join(dir, 'assertions.json'), `${JSON.stringify(input.tree, null, 2)}\n`)
  await writeAtomic(
    join(dir, 'trace.jsonl'),
    input.traces.map((row) => JSON.stringify(row)).join('\n') + (input.traces.length ? '\n' : ''),
  )
  await appendIndex(roots, {
    run_id,
    task_id: input.task_id,
    snapshot_digest: input.snapshot_digest,
    suite_digest: input.suite_digest,
    pass: score.pass,
  })
  return { run_id }
}

export async function readRun(roots: EvalRoots, run_id: string): Promise<StoredRun | undefined> {
  const dir = resolve(storeRoot(roots), 'runs', run_id)
  let raw: string
  try {
    raw = await readFile(join(dir, 'score.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const score = parseScoreRecord(JSON.parse(raw))
  const tree = JSON.parse(await readFile(join(dir, 'assertions.json'), 'utf8')) as EvidenceTree
  const traces = (await readFile(join(dir, 'trace.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Record<string, unknown>
  const intervention = JSON.parse(
    await readFile(join(dir, 'intervention.json'), 'utf8'),
  ) as Intervention | null
  return { run_id, score, tree, traces, meta, intervention }
}

export async function listRuns(
  roots: EvalRoots,
  filter: { task_id?: string; snapshot_digest?: string } = {},
): Promise<StoredRun['score'][]> {
  const rows = await readIndex(roots)
  const scores: StoredRun['score'][] = []
  for (const row of rows) {
    if (filter.task_id && row.task_id !== filter.task_id) continue
    if (filter.snapshot_digest && row.snapshot_digest !== filter.snapshot_digest) continue
    const run = await readRun(roots, row.run_id)
    if (run) scores.push(run.score)
  }
  return scores
}

export async function writeCompare(
  roots: EvalRoots,
  digest: string,
  result: unknown,
): Promise<void> {
  const path = resolve(storeRoot(roots), 'compares', digest, 'compare.json')
  assertInside(storeRoot(roots), path, 'compare')
  await writeAtomic(path, `${JSON.stringify(result, null, 2)}\n`)
}

export async function listCompares(roots: EvalRoots): Promise<CompareResult[]> {
  const dir = resolve(storeRoot(roots), 'compares')
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const results: CompareResult[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      results.push(
        JSON.parse(await readFile(join(dir, entry.name, 'compare.json'), 'utf8')) as CompareResult,
      )
    } catch {
      // Skip unreadable compare packets; inventory is best-effort.
    }
  }
  return results
}

export async function appendIndex(roots: EvalRoots, row: Record<string, unknown>): Promise<void> {
  const path = resolve(storeRoot(roots), 'index.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await refuseSymlink(path, 'index')
  const line = `${JSON.stringify(row)}\n`
  const { appendFile } = await import('node:fs/promises')
  await appendFile(path, line, { encoding: 'utf8', mode: 0o644 })
  const content = await readFile(path, 'utf8')
  const lines = content.split('\n').filter((item) => item.trim())
  if (lines.length <= INDEX_RETAIN + 500) return
  await writeAtomic(path, `${lines.slice(-INDEX_RETAIN).join('\n')}\n`)
}

export async function readIndex(roots: EvalRoots): Promise<
  {
    run_id: string
    task_id: string
    snapshot_digest: string
    suite_digest?: string
    pass?: boolean
  }[]
> {
  const path = resolve(storeRoot(roots), 'index.jsonl')
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return content
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

export async function resolveTask(
  roots: EvalRoots,
  taskId: string,
): Promise<{ document: EvalTaskDocument; dir: string } | undefined> {
  const dirs = [join(roots.bundledTasks, taskId)]
  if (roots.workspace) dirs.push(join(roots.workspace, '.dsh', 'eval', 'tasks', taskId))
  dirs.push(join(storeRoot(roots), 'tasks', taskId))
  for (const dir of dirs) {
    try {
      const document = parseEvalTaskDocument(
        JSON.parse(await readFile(join(dir, 'task.json'), 'utf8')),
      )
      if (document.id !== taskId) continue
      return { document, dir }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  return undefined
}

export async function listTasks(roots: EvalRoots): Promise<EvalTaskDocument[]> {
  const ids = new Set<string>()
  for (const root of [roots.bundledTasks]) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) ids.add(entry.name)
    }
  }
  const documents: EvalTaskDocument[] = []
  for (const id of [...ids].sort()) {
    const resolved = await resolveTask(roots, id)
    if (resolved) documents.push(resolved.document)
  }
  return documents
}

export async function bundledSuiteDigest(roots: EvalRoots): Promise<string> {
  const tasks = await listTasks(roots)
  const entries = []
  for (const document of tasks) {
    const resolved = await resolveTask(roots, document.id)
    if (!resolved) continue
    entries.push({ id: document.id, task_digest: await taskDigest(resolved.dir, document) })
  }
  return suiteDigest(entries)
}

export async function showArtifact(
  roots: EvalRoots,
  artifact: EvalArtifactRef,
  max_bytes: number,
): Promise<{ content: string; truncated: boolean; path: string }> {
  const rel = evalArtifactPath(artifact)
  let path = resolve(roots.dshHome, rel)
  if (artifact.kind === 'task') {
    const resolved = await resolveTask(roots, artifact.id)
    if (resolved) path = join(resolved.dir, 'task.json')
  }
  const bytes = await readFile(path)
  const truncated = bytes.length > max_bytes
  return {
    content: bytes.subarray(0, max_bytes).toString('utf8'),
    truncated,
    path: rel,
  }
}

export async function grepEvalStore(
  roots: EvalRoots,
  query: string,
  scope: GrepScope,
  limit = GREP_DEFAULT_HITS,
): Promise<{ ref: string; path: string; line: string }[]> {
  const hits: { ref: string; path: string; line: string }[] = []
  const root = storeRoot(roots)
  const max = Math.min(limit, GREP_MAX_HITS)
  const walk = async (dir: string, kind: GrepScope | 'all') => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (hits.length >= max) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path, kind)
      else if (entry.isFile()) {
        if (scope !== 'all') {
          if (scope === 'traces' && !path.endsWith('trace.jsonl')) continue
          if (scope === 'scores' && !path.endsWith('score.json')) continue
          if (scope === 'assertions' && !path.endsWith('assertions.json')) continue
          if (
            scope === 'snapshots' &&
            !path.includes(`${sep}snapshots${sep}`) &&
            !path.endsWith('snapshot.json')
          )
            continue
          if (scope === 'tasks' && !path.endsWith('task.json')) continue
        }
        const text = await readFile(path, 'utf8')
        for (const line of text.split('\n')) {
          if (line.includes(query)) {
            hits.push({
              ref: relative(root, path).split(/[\\/]/).join('/'),
              path: relative(root, path).split(/[\\/]/).join('/'),
              line: line.slice(0, 240),
            })
            if (hits.length >= max) return
          }
        }
      }
    }
  }
  await walk(root, scope)
  for (const task of await listTasks(roots)) {
    if (hits.length >= max) break
    const resolved = await resolveTask(roots, task.id)
    if (!resolved) continue
    const text = await readFile(join(resolved.dir, 'task.json'), 'utf8')
    if (text.includes(query) && (scope === 'all' || scope === 'tasks')) {
      hits.push({ ref: `task:${task.id}`, path: `tasks/${task.id}/task.json`, line: task.summary })
    }
  }
  return hits
}
