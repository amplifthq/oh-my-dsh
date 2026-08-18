/**
 * Locked eval_control action surface.
 *
 * Meta-Harness: scores, snapshots, and traces live as files the agent retrieves
 * with show — never a compressed narrative of the run.
 * Experience Faithfulness: compare mode=ablate is a causal with/without on one
 * skill or plugin; identical machine assertions mean the asset was ignored.
 *
 * Reward is assertions + tokens/duration. Assistant text is not a score field.
 * This module does not apply proposals, write the catalog, or mount plugins.
 */

import { createHash } from 'node:crypto'

import { capabilityRef, parseCapabilityRef } from '../../capability-discovery/src/catalog.js'

export const EVAL_CONTROL_ACTIONS = ['snapshot', 'run', 'compare', 'show'] as const

export type EvalControlAction = (typeof EVAL_CONTROL_ACTIONS)[number]

export const EVAL_CONTROL_DESCRIPTION =
  'Score a frozen harness snapshot with machine assertions. ' +
  'Call snapshot before run (run never infers the live session). ' +
  'Artifacts are files under $DSH_HOME/omd/eval; use show (optional query) instead of asking for a summary. ' +
  'compare mode=diff is the promotion gate (regress if any passing assertion flips). ' +
  'compare mode=ablate is the faithfulness intervention: same snapshot, one skill or plugin removed; ' +
  'unchanged assertions mean the asset was not causally used. ' +
  'Scores never read assistant text, LLM-as-judge, or self-report. ' +
  'eval_control does not apply proposals, write presets/plugins.json, or mount plugins. ' +
  'Four actions only: snapshot, run, compare, show.'

export const INTERVENTION_KINDS = ['skill', 'plugin'] as const
export const COMPARE_MODES = ['diff', 'ablate'] as const
export const GREP_SCOPES = ['tasks', 'snapshots', 'scores', 'traces', 'assertions', 'all'] as const
export const SHOW_FILES = [
  'manifest',
  'score',
  'trace',
  'intervention',
  'assertions',
  'meta',
] as const

export type InterventionKind = (typeof INTERVENTION_KINDS)[number]
export type CompareMode = (typeof COMPARE_MODES)[number]
export type GrepScope = (typeof GREP_SCOPES)[number]
export type ShowFile = (typeof SHOW_FILES)[number]

export const EVAL_STORE_DIR = 'omd/eval'
export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/
export const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/

export const SHOW_DEFAULT_BYTES = 16_384
export const SHOW_MAX_BYTES = 65_536
export const GREP_QUERY_MAX_CHARS = 512
export const GREP_DEFAULT_HITS = 20
export const GREP_MAX_HITS = 50

export const SCORE_FORBIDDEN_KEYS = [
  'judge',
  'rationale',
  'assistant_text',
  'self_report',
  'verdict',
  'llm_judge',
  'narrative',
] as const

const FORBIDDEN_ACTIONS = [
  'apply',
  'judge',
  'suggest',
  'promote',
  'export',
  'train',
  'optimize',
  'tasks',
  'runs',
  'score',
  'grep',
] as const

const REQUEST_FIELDS = [
  'action',
  'task_id',
  'snapshot_digest',
  'run_id',
  'ref',
  'file',
  'query',
  'in',
  'mode',
  'baseline',
  'candidate',
  'target',
  'intervention',
  'max_bytes',
] as const

export interface Intervention {
  op: 'ablate'
  target: string
}

export interface SnapshotComponent {
  ref: string
  digest: string
  revision?: number
}

export interface SnapshotComposition {
  skills: SnapshotComponent[]
  plugins: SnapshotComponent[]
  patch_digest: string
}

export interface AssertionResult {
  id: string
  pass: boolean
}

export interface ScoreTokens {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
  reasoning?: number
}

export interface ScoreRecord {
  task_id: string
  run_id: string
  snapshot_digest: string
  condition_digest: string
  suite_digest: string
  intervention: Intervention | null
  pass: boolean
  assertions: AssertionResult[]
  tokens: ScoreTokens
  duration_ms: number
  error?: string
}

export interface AssertionDelta {
  id: string
  baseline: boolean
  candidate: boolean
}

export interface CompareResult {
  mode: CompareMode
  task_id: string
  baseline_run: string
  candidate_run: string
  baseline_ref: string
  candidate_ref: string
  regress: boolean
  improve: boolean
  assertion_deltas: AssertionDelta[]
  cost_shifted: boolean
  tokens_delta: { input: number; output: number }
  faithful?: boolean
  ignored?: boolean
}

export interface EvalFilePointer {
  kind:
    | 'task'
    | 'snapshot'
    | 'score'
    | 'trace'
    | 'intervention'
    | 'assertions'
    | 'meta'
    | 'compare'
    | 'index'
  ref: string
  path: string
}

export interface EvalNextAction {
  tool: string
  action: string
  args?: Record<string, unknown>
  instruction: string
}

export interface EvalControlEnvelope<T> {
  action: EvalControlAction
  refs: string[]
  files: EvalFilePointer[]
  next: EvalNextAction[]
  data: T
}

export type EvalArtifactKind = 'task' | 'snapshot' | 'run' | 'compare' | 'index'

export interface EvalArtifactRef {
  kind: EvalArtifactKind
  id: string
  file?: ShowFile
  ref: string
}

export type ParsedEvalControlRequest =
  | { action: 'snapshot' }
  | {
      action: 'run'
      task_id: string
      snapshot_digest: string
      intervention: Intervention | null
    }
  | {
      action: 'compare'
      mode: 'diff'
      task_id: string
      baseline: string
      candidate: string
    }
  | {
      action: 'compare'
      mode: 'ablate'
      task_id: string
      snapshot_digest: string
      intervention: Intervention
    }
  | {
      action: 'show'
      artifact?: EvalArtifactRef
      query?: string
      in: GrepScope
      max_bytes: number
      task_id?: string
      snapshot_digest?: string
    }

export const EVAL_CONTROL_PARAMETERS = {
  action: {
    type: 'string',
    required: true,
    enum: [...EVAL_CONTROL_ACTIONS],
    description:
      'snapshot captures composition; run requires snapshot_digest and writes score files; ' +
      'compare is diff or ablate; show reads refs (index:tasks, run:…, task:…) and optional query.',
  },
  task_id: {
    type: 'string',
    description: 'Frozen eval task slug (lowercase, digits, hyphens, ≤ 41 chars).',
  },
  snapshot_digest: {
    type: 'string',
    description: '64-char lowercase SHA-256 of the snapshot composition. Required for run.',
  },
  run_id: {
    type: 'string',
    description: 'Existing run directory name for score or inventory filters.',
  },
  ref: {
    type: 'string',
    description:
      'Eval artifact ref: task:<id>, snapshot:<digest>, run:<id>, run:<id>/<file>, compare:<digest>.',
  },
  file: {
    type: 'string',
    enum: [...SHOW_FILES],
    description: 'File inside a run/snapshot/task. Overrides a suffix on ref only when they match.',
  },
  query: {
    type: 'string',
    description: `Substring to grep across the eval store (≤ ${GREP_QUERY_MAX_CHARS} chars).`,
  },
  in: {
    type: 'string',
    enum: [...GREP_SCOPES],
    description: 'grep scope. Default all. Does not search assistant text as a score.',
  },
  mode: {
    type: 'string',
    enum: [...COMPARE_MODES],
    description:
      'diff = promotion gate between two runs; ablate = with/without one skill or plugin.',
  },
  baseline: {
    type: 'string',
    description: 'compare mode=diff: intact or earlier run_id. Never "current".',
  },
  candidate: {
    type: 'string',
    description: 'compare mode=diff: new snapshot run_id.',
  },
  target: {
    type: 'string',
    description:
      'capability_search ref to ablate (skill:… or plugin:…, including plugin:forged/<scope>/<slug>).',
  },
  intervention: {
    type: 'object',
    additionalProperties: true,
    description:
      'run/compare ablate: { "op": "ablate", "target": "<capability ref>" }. Only ablate.',
  },
  max_bytes: {
    type: 'number',
    description: `show byte cap (default ${SHOW_DEFAULT_BYTES}, max ${SHOW_MAX_BYTES}).`,
  },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function evalSha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function evalCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => evalCanonical(item)).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${evalCanonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`eval_control ${field} is required`)
  }
  return value.trim()
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`eval_control ${field} must be a string`)
  const trimmed = value.trim()
  return trimmed || undefined
}

function requireTaskId(value: unknown): string {
  const taskId = requireString(value, 'task_id')
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(
      'eval_control task_id must be 1-41 characters of lowercase letters, digits, and hyphens',
    )
  }
  return taskId
}

function requireRunId(value: unknown, field = 'run_id'): string {
  const runId = requireString(value, field)
  if (runId === 'current') throw new Error(`eval_control ${field} cannot be "current"`)
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `eval_control ${field} must be 1-63 characters of lowercase letters, digits, and hyphens`,
    )
  }
  return runId
}

function requireDigest(value: unknown, field: string): string {
  const digest = requireString(value, field)
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`eval_control ${field} must be a 64-character lowercase SHA-256 hex digest`)
  }
  return digest
}

export function normalizeInterventionTarget(ref: string): string {
  const { kind, id } = parseCapabilityRef(ref.trim())
  if (kind !== 'skill' && kind !== 'plugin') {
    throw new Error(
      `eval intervention target must be a skill or plugin ref (got ${kind}). ` +
        'Ablate the asset, not a tool or command derived from it.',
    )
  }
  if (!id.trim()) throw new Error('eval intervention target id must be non-empty')
  return capabilityRef(kind, id)
}

export function parseIntervention(value: unknown): Intervention {
  if (!isRecord(value)) throw new Error('eval_control intervention must be an object')
  const extra = Object.keys(value).filter((key) => key !== 'op' && key !== 'target')
  if (extra.length) {
    throw new Error(`eval_control intervention has unknown fields: ${extra.join(', ')}`)
  }
  if (value.op !== 'ablate') {
    throw new Error(
      'eval_control intervention.op must be "ablate" (adding an asset is a new snapshot)',
    )
  }
  return {
    op: 'ablate',
    target: normalizeInterventionTarget(requireString(value.target, 'intervention.target')),
  }
}

export function snapshotDigest(composition: SnapshotComposition): string {
  const skills = [...composition.skills]
    .map((item) => ({
      ref: normalizeInterventionTarget(item.ref),
      digest: requireDigest(item.digest, 'skill digest'),
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref))
  const plugins = [...composition.plugins]
    .map((item) => ({
      ref: normalizeInterventionTarget(item.ref),
      digest: requireDigest(item.digest, 'plugin digest'),
      ...(item.revision === undefined ? {} : { revision: item.revision }),
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref))
  if (!DIGEST_PATTERN.test(composition.patch_digest) && composition.patch_digest !== '') {
    throw new Error('snapshot patch_digest must be empty or a 64-character SHA-256 hex digest')
  }
  return evalSha256Hex(
    evalCanonical({
      skills,
      plugins,
      patch_digest: composition.patch_digest,
    }),
  )
}

export function conditionDigest(snapshot: string, intervention: Intervention | null): string {
  const digest = requireDigest(snapshot, 'snapshot_digest')
  if (!intervention) return digest
  return evalSha256Hex(`${digest}\nablate\n${normalizeInterventionTarget(intervention.target)}`)
}

export function evalRootRel(): string {
  return EVAL_STORE_DIR
}

export function evalArtifactPath(artifact: EvalArtifactRef): string {
  if (artifact.kind === 'task') {
    const file =
      artifact.file && artifact.file !== 'manifest' ? `${artifact.file}.json` : 'task.json'
    if (artifact.file === 'trace') throw new Error('tasks do not have a trace file')
    return `${EVAL_STORE_DIR}/tasks/${artifact.id}/${file}`
  }
  if (artifact.kind === 'snapshot') {
    return `${EVAL_STORE_DIR}/snapshots/${artifact.id}/snapshot.json`
  }
  if (artifact.kind === 'compare') {
    return `${EVAL_STORE_DIR}/compares/${artifact.id}/compare.json`
  }
  if (artifact.kind === 'index') {
    if (artifact.id === 'tasks') return `${EVAL_STORE_DIR}/tasks`
    if (artifact.id === 'snapshots') return `${EVAL_STORE_DIR}/snapshots`
    return `${EVAL_STORE_DIR}/index.jsonl`
  }
  const file = artifact.file ?? 'meta'
  const names: Record<ShowFile, string> = {
    manifest: 'meta.json',
    meta: 'meta.json',
    score: 'score.json',
    trace: 'trace.jsonl',
    intervention: 'intervention.json',
    assertions: 'assertions.json',
  }
  return `${EVAL_STORE_DIR}/runs/${artifact.id}/${names[file]}`
}

function pointerKind(artifact: EvalArtifactRef): EvalFilePointer['kind'] {
  if (artifact.kind === 'task') return 'task'
  if (artifact.kind === 'snapshot') return 'snapshot'
  if (artifact.kind === 'compare') return 'compare'
  if (artifact.kind === 'index') return 'index'
  const file = artifact.file ?? 'meta'
  if (file === 'manifest' || file === 'meta') return 'meta'
  return file
}

export function runFilePointers(runId: string): EvalFilePointer[] {
  const id = requireRunId(runId)
  const files: ShowFile[] = ['meta', 'score', 'intervention', 'assertions', 'trace']
  return files.map((file) => {
    const artifact: EvalArtifactRef = { kind: 'run', id, file, ref: `run:${id}/${file}` }
    return {
      kind: pointerKind(artifact),
      ref: artifact.ref,
      path: evalArtifactPath(artifact),
    }
  })
}

export function parseEvalArtifactRef(ref: string, file?: ShowFile): EvalArtifactRef {
  const trimmed = requireString(ref, 'ref')
  const slash = trimmed.indexOf('/')
  const head = slash === -1 ? trimmed : trimmed.slice(0, slash)
  const suffix = slash === -1 ? undefined : trimmed.slice(slash + 1)
  const colon = head.indexOf(':')
  if (colon <= 0) throw new Error(`invalid eval ref ${JSON.stringify(ref)}`)
  const kind = head.slice(0, colon)
  const id = head.slice(colon + 1)
  if (
    kind !== 'task' &&
    kind !== 'snapshot' &&
    kind !== 'run' &&
    kind !== 'compare' &&
    kind !== 'index'
  ) {
    throw new Error(`invalid eval ref kind ${JSON.stringify(kind)}`)
  }
  let parsedFile: ShowFile | undefined
  if (suffix) {
    const mapped = suffix.replace(/\.(json|jsonl)$/, '')
    if (mapped === 'snapshot' || mapped === 'task' || mapped === 'compare') parsedFile = 'manifest'
    else if ((SHOW_FILES as readonly string[]).includes(mapped)) parsedFile = mapped as ShowFile
    else throw new Error(`invalid eval ref file ${JSON.stringify(suffix)}`)
  }
  if (file && parsedFile && file !== parsedFile) {
    throw new Error(`eval_control ref file ${parsedFile} does not match file=${file}`)
  }
  const resolved = file ?? parsedFile
  if (kind === 'task') {
    if (!TASK_ID_PATTERN.test(id)) throw new Error(`invalid task ref ${JSON.stringify(ref)}`)
    return { kind, id, file: resolved, ref: resolved ? `task:${id}/${resolved}` : `task:${id}` }
  }
  if (kind === 'snapshot') {
    if (!DIGEST_PATTERN.test(id)) throw new Error(`invalid snapshot ref ${JSON.stringify(ref)}`)
    return { kind, id, file: resolved, ref: `snapshot:${id}` }
  }
  if (kind === 'index') {
    if (id !== 'tasks' && id !== 'runs' && id !== 'snapshots') {
      throw new Error(`invalid index ref ${JSON.stringify(ref)}`)
    }
    return { kind, id, file: resolved, ref: `index:${id}` }
  }
  if (kind === 'compare') {
    if (!DIGEST_PATTERN.test(id)) throw new Error(`invalid compare ref ${JSON.stringify(ref)}`)
    return { kind, id, file: resolved, ref: `compare:${id}` }
  }
  if (!RUN_ID_PATTERN.test(id)) throw new Error(`invalid run ref ${JSON.stringify(ref)}`)
  return {
    kind,
    id,
    file: resolved,
    ref: resolved ? `run:${id}/${resolved}` : `run:${id}`,
  }
}

function rejectForbiddenScoreKeys(record: Record<string, unknown>, path = 'score'): void {
  for (const key of SCORE_FORBIDDEN_KEYS) {
    if (Object.hasOwn(record, key)) {
      throw new Error(`${path} must not include ${key}; scores are machine assertions only`)
    }
  }
}

function requireInt(value: unknown, field: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`${field} must be an integer ≥ ${min}`)
  }
  return value
}

export function parseScoreRecord(value: unknown): ScoreRecord {
  if (!isRecord(value)) throw new Error('score must be an object')
  rejectForbiddenScoreKeys(value)
  const extra = Object.keys(value).filter(
    (key) =>
      ![
        'task_id',
        'run_id',
        'snapshot_digest',
        'condition_digest',
        'suite_digest',
        'intervention',
        'pass',
        'assertions',
        'tokens',
        'duration_ms',
        'error',
      ].includes(key),
  )
  if (extra.length) throw new Error(`score has unknown fields: ${extra.join(', ')}`)
  const assertionsRaw = value.assertions
  if (!Array.isArray(assertionsRaw) || assertionsRaw.length === 0) {
    throw new Error('score.assertions must be a non-empty array')
  }
  const assertions = assertionsRaw.map((item, index) => {
    if (!isRecord(item)) throw new Error(`score.assertions[${index}] must be an object`)
    rejectForbiddenScoreKeys(item, `score.assertions[${index}]`)
    const id = requireString(item.id, `score.assertions[${index}].id`)
    if (typeof item.pass !== 'boolean')
      throw new Error(`score.assertions[${index}].pass must be boolean`)
    return { id, pass: item.pass }
  })
  if (new Set(assertions.map((item) => item.id)).size !== assertions.length) {
    throw new Error('score.assertions ids must be unique')
  }
  if (typeof value.pass !== 'boolean') throw new Error('score.pass must be boolean')
  const derived = assertions.every((item) => item.pass)
  if (value.pass !== derived) {
    throw new Error('score.pass must equal the conjunction of score.assertions')
  }
  if (!isRecord(value.tokens)) throw new Error('score.tokens must be an object')
  rejectForbiddenScoreKeys(value.tokens, 'score.tokens')
  const tokens: ScoreTokens = {
    input: requireInt(value.tokens.input, 'score.tokens.input'),
    output: requireInt(value.tokens.output, 'score.tokens.output'),
  }
  for (const field of ['cache_read', 'cache_write', 'reasoning'] as const) {
    if (value.tokens[field] !== undefined) {
      tokens[field] = requireInt(value.tokens[field], `score.tokens.${field}`)
    }
  }
  let intervention: Intervention | null = null
  if (value.intervention !== null && value.intervention !== undefined) {
    intervention = parseIntervention(value.intervention)
  }
  const snapshot = requireDigest(value.snapshot_digest, 'score.snapshot_digest')
  const condition = requireDigest(value.condition_digest, 'score.condition_digest')
  if (condition !== conditionDigest(snapshot, intervention)) {
    throw new Error('score.condition_digest does not match snapshot_digest and intervention')
  }
  const record: ScoreRecord = {
    task_id: requireTaskId(value.task_id),
    run_id: requireRunId(value.run_id),
    snapshot_digest: snapshot,
    condition_digest: condition,
    suite_digest: requireDigest(value.suite_digest, 'score.suite_digest'),
    intervention,
    pass: value.pass,
    assertions,
    tokens,
    duration_ms: requireInt(value.duration_ms, 'score.duration_ms'),
  }
  if (value.error !== undefined) {
    if (typeof value.error !== 'string' || !value.error.trim()) {
      throw new Error('score.error must be a non-empty string when present')
    }
    record.error = value.error.trim()
  }
  return record
}

function assertionMap(score: ScoreRecord): Map<string, boolean> {
  return new Map(score.assertions.map((item) => [item.id, item.pass]))
}

export function compareScores(input: {
  mode: CompareMode
  baseline: ScoreRecord
  candidate: ScoreRecord
  target?: string
}): CompareResult {
  const baseline = parseScoreRecord(input.baseline)
  const candidate = parseScoreRecord(input.candidate)
  if (baseline.task_id !== candidate.task_id) {
    throw new Error('compare requires both runs to share task_id')
  }
  if (baseline.suite_digest !== candidate.suite_digest) {
    throw new Error('compare requires both runs to share suite_digest')
  }
  if (input.mode === 'ablate') {
    if (baseline.snapshot_digest !== candidate.snapshot_digest) {
      throw new Error('compare mode=ablate requires the same snapshot_digest')
    }
    if (baseline.intervention !== null) {
      throw new Error('compare mode=ablate baseline must be the intact condition (no intervention)')
    }
    if (!candidate.intervention) {
      throw new Error('compare mode=ablate candidate must be the ablated condition')
    }
    if (input.target) {
      const target = normalizeInterventionTarget(input.target)
      if (candidate.intervention.target !== target) {
        throw new Error('compare mode=ablate target does not match the candidate intervention')
      }
    }
  } else if (baseline.condition_digest === candidate.condition_digest) {
    throw new Error('compare mode=diff requires two different conditions')
  }

  const ids = [
    ...new Set([...assertionMap(baseline).keys(), ...assertionMap(candidate).keys()]),
  ].sort()
  const assertion_deltas: AssertionDelta[] = []
  let regress = false
  let improve = false
  for (const id of ids) {
    const left = assertionMap(baseline).get(id)
    const right = assertionMap(candidate).get(id)
    if (left === undefined || right === undefined || left === right) continue
    assertion_deltas.push({ id, baseline: left, candidate: right })
    if (left && !right) regress = true
    if (!left && right) improve = true
  }
  if (baseline.pass && !candidate.pass) regress = true
  if (!baseline.pass && candidate.pass) improve = true

  const cost_shifted =
    baseline.tokens.input !== candidate.tokens.input ||
    baseline.tokens.output !== candidate.tokens.output ||
    baseline.duration_ms !== candidate.duration_ms

  const result: CompareResult = {
    mode: input.mode,
    task_id: baseline.task_id,
    baseline_run: baseline.run_id,
    candidate_run: candidate.run_id,
    baseline_ref: `run:${baseline.run_id}/score`,
    candidate_ref: `run:${candidate.run_id}/score`,
    regress,
    improve,
    assertion_deltas,
    cost_shifted,
    tokens_delta: {
      input: candidate.tokens.input - baseline.tokens.input,
      output: candidate.tokens.output - baseline.tokens.output,
    },
  }
  if (input.mode === 'ablate') {
    result.faithful = assertion_deltas.length > 0 || baseline.pass !== candidate.pass
    result.ignored = !result.faithful
  }
  return result
}

export function promotionAllowed(compare: CompareResult): boolean {
  return compare.mode === 'diff' && !compare.regress
}

export function distillJustified(compare: CompareResult): boolean {
  return compare.mode === 'ablate' && compare.faithful === true
}

export function envelope<T>(
  action: EvalControlAction,
  data: T,
  parts: { refs?: string[]; files?: EvalFilePointer[]; next?: EvalNextAction[] } = {},
): EvalControlEnvelope<T> {
  if (isRecord(data) && Object.hasOwn(data, 'summary')) {
    throw new Error('eval_control envelope data must not include a narrative summary')
  }
  return {
    action,
    refs: parts.refs ?? [],
    files: parts.files ?? [],
    next: parts.next ?? [],
    data,
  }
}

export function nextAfterSnapshot(snapshotDigestValue?: string, taskId?: string): EvalNextAction[] {
  if (!taskId) {
    return [
      {
        tool: 'eval_control',
        action: 'show',
        args: { ref: 'index:tasks' },
        instruction: snapshotDigestValue
          ? 'List frozen tasks, then eval_control run with the snapshot_digest from this capture.'
          : 'List frozen tasks after capturing a snapshot.',
      },
    ]
  }
  return [
    {
      tool: 'eval_control',
      action: 'run',
      args: {
        task_id: requireTaskId(taskId),
        snapshot_digest: requireDigest(snapshotDigestValue, 'snapshot_digest'),
      },
      instruction: 'Run the task against this snapshot. Do not infer the live session.',
    },
  ]
}

export function nextMissingAblatePair(
  taskId: string,
  snapshot: string,
  target: string,
): EvalNextAction[] {
  const task_id = requireTaskId(taskId)
  const snapshot_digest = requireDigest(snapshot, 'snapshot_digest')
  const intervention = { op: 'ablate' as const, target: normalizeInterventionTarget(target) }
  return [
    {
      tool: 'eval_control',
      action: 'run',
      args: { task_id, snapshot_digest },
      instruction: 'Run the intact condition (no intervention).',
    },
    {
      tool: 'eval_control',
      action: 'run',
      args: { task_id, snapshot_digest, intervention },
      instruction: 'Run the ablated condition for the faithfulness compare.',
    },
  ]
}

export function nextAfterCompare(compare: CompareResult): EvalNextAction[] {
  if (compare.mode === 'diff') {
    if (compare.regress) {
      return [
        {
          tool: 'eval_control',
          action: 'show',
          args: { ref: compare.candidate_ref },
          instruction: 'Candidate regresses. Inspect score/assertions; do not prepare_promote.',
        },
      ]
    }
    return [
      {
        tool: 'plugin_forge',
        action: 'prepare_promote',
        instruction:
          'No assertion regress. Promotion is still a proposal: plugin_forge prepare_promote, then proposal_control apply.',
      },
    ]
  }
  if (compare.ignored) {
    return [
      {
        tool: 'eval_control',
        action: 'show',
        args: { ref: compare.baseline_ref },
        instruction:
          'Ablating the asset did not change assertions — it was not causally used. Do not distill or promote it on this task.',
      },
    ]
  }
  return [
    {
      tool: 'eval_control',
      action: 'show',
      args: { ref: compare.candidate_ref },
      instruction:
        'Ablation changed assertions. Read the files; a distill/promote proposal may be justified.',
    },
  ]
}

function parseOptionalIntervention(intervention: unknown, target: unknown): Intervention | null {
  if (intervention !== undefined && target !== undefined) {
    const parsed = parseIntervention(intervention)
    const normalized = normalizeInterventionTarget(requireString(target, 'target'))
    if (parsed.target !== normalized) {
      throw new Error('eval_control target does not match intervention.target')
    }
    return parsed
  }
  if (intervention !== undefined) return parseIntervention(intervention)
  if (target !== undefined) {
    return { op: 'ablate', target: normalizeInterventionTarget(requireString(target, 'target')) }
  }
  return null
}

export function parseEvalControlRequest(args: unknown): ParsedEvalControlRequest {
  if (!isRecord(args)) throw new Error('eval_control arguments must be an object')
  const unknown = Object.keys(args).filter(
    (key) => !(REQUEST_FIELDS as readonly string[]).includes(key),
  )
  if (unknown.length) {
    throw new Error(`eval_control has unknown fields: ${unknown.join(', ')}`)
  }
  const action = requireString(args.action, 'action')
  if ((FORBIDDEN_ACTIONS as readonly string[]).includes(action)) {
    if (action === 'tasks' || action === 'runs' || action === 'score' || action === 'grep') {
      throw new Error(`eval_control ${action} was removed; use show`)
    }
    throw new Error(
      `eval_control cannot ${action}; scoring files proposals and never applies, judges, or trains`,
    )
  }
  if (!(EVAL_CONTROL_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`eval_control action must be one of ${EVAL_CONTROL_ACTIONS.join(', ')}`)
  }

  if (action === 'snapshot') {
    for (const field of REQUEST_FIELDS) {
      if (field !== 'action' && args[field] !== undefined) {
        throw new Error(`eval_control ${action} does not take ${field}`)
      }
    }
    return { action }
  }

  if (action === 'run') {
    if (args.snapshot_digest === undefined) {
      throw new Error(
        'eval_control run requires snapshot_digest; call snapshot first, never infer "current"',
      )
    }
    return {
      action,
      task_id: requireTaskId(args.task_id),
      snapshot_digest: requireDigest(args.snapshot_digest, 'snapshot_digest'),
      intervention: parseOptionalIntervention(args.intervention, args.target),
    }
  }

  if (action === 'compare') {
    const mode = requireString(args.mode, 'mode')
    if (mode !== 'diff' && mode !== 'ablate') {
      throw new Error('eval_control compare mode must be "diff" or "ablate"')
    }
    const task_id = requireTaskId(args.task_id)
    if (mode === 'diff') {
      if (args.intervention !== undefined || args.target !== undefined) {
        throw new Error(
          'eval_control compare mode=diff uses baseline and candidate run ids, not intervention',
        )
      }
      if (args.snapshot_digest !== undefined) {
        throw new Error('eval_control compare mode=diff reads snapshot_digest from the two runs')
      }
      return {
        action,
        mode,
        task_id,
        baseline: requireRunId(args.baseline, 'baseline'),
        candidate: requireRunId(args.candidate, 'candidate'),
      }
    }
    if (args.baseline !== undefined || args.candidate !== undefined) {
      throw new Error(
        'eval_control compare mode=ablate resolves the intact/ablated pair; do not pass baseline/candidate',
      )
    }
    const intervention = parseOptionalIntervention(args.intervention, args.target)
    if (!intervention) {
      throw new Error('eval_control compare mode=ablate requires intervention or target')
    }
    return {
      action,
      mode,
      task_id,
      snapshot_digest: requireDigest(args.snapshot_digest, 'snapshot_digest'),
      intervention,
    }
  }

  const maxBytes =
    args.max_bytes === undefined ? SHOW_DEFAULT_BYTES : requireInt(args.max_bytes, 'max_bytes', 1)
  if (maxBytes > SHOW_MAX_BYTES) {
    throw new Error(`eval_control max_bytes must be ≤ ${SHOW_MAX_BYTES}`)
  }
  const file =
    args.file === undefined
      ? undefined
      : (SHOW_FILES as readonly string[]).includes(requireString(args.file, 'file'))
        ? (args.file as ShowFile)
        : (() => {
            throw new Error(`eval_control file must be one of ${SHOW_FILES.join(', ')}`)
          })()
  const query = optionalString(args.query, 'query')
  if (query && query.length > GREP_QUERY_MAX_CHARS) {
    throw new Error(`eval_control query must be at most ${GREP_QUERY_MAX_CHARS} characters`)
  }
  const scope = optionalString(args.in, 'in') ?? 'all'
  if (!(GREP_SCOPES as readonly string[]).includes(scope)) {
    throw new Error(`eval_control in must be one of ${GREP_SCOPES.join(', ')}`)
  }
  const ref = optionalString(args.ref, 'ref')
  const task_id = args.task_id === undefined ? undefined : requireTaskId(args.task_id)
  const snapshot_digest =
    args.snapshot_digest === undefined
      ? undefined
      : requireDigest(args.snapshot_digest, 'snapshot_digest')
  return {
    action: 'show',
    ...(ref ? { artifact: parseEvalArtifactRef(ref, file) } : {}),
    ...(query ? { query } : {}),
    in: scope as GrepScope,
    max_bytes: maxBytes,
    ...(task_id ? { task_id } : {}),
    ...(snapshot_digest ? { snapshot_digest } : {}),
  }
}

export function planEvalControl(
  request: ParsedEvalControlRequest,
): EvalControlEnvelope<Record<string, unknown>> {
  if (request.action === 'snapshot') {
    return envelope('snapshot', { status: 'capture' }, { next: nextAfterSnapshot() })
  }
  if (request.action === 'run') {
    const condition = conditionDigest(request.snapshot_digest, request.intervention)
    return envelope(
      'run',
      {
        status: 'queued',
        task_id: request.task_id,
        snapshot_digest: request.snapshot_digest,
        condition_digest: condition,
        intervention: request.intervention,
      },
      {
        refs: [`task:${request.task_id}`, `snapshot:${request.snapshot_digest}`],
        next: request.intervention
          ? [
              {
                tool: 'eval_control',
                action: 'compare',
                args: {
                  mode: 'ablate',
                  task_id: request.task_id,
                  snapshot_digest: request.snapshot_digest,
                  intervention: request.intervention,
                },
                instruction: 'After the intact run exists, compare mode=ablate.',
              },
            ]
          : [
              {
                tool: 'eval_control',
                action: 'show',
                args: { ref: 'index:runs' },
                instruction: 'Read the run files. Do not treat assistant text as the score.',
              },
            ],
      },
    )
  }
  if (request.action === 'compare' && request.mode === 'ablate') {
    return envelope(
      'compare',
      { status: 'needs_runs', mode: 'ablate' },
      {
        refs: [`task:${request.task_id}`, `snapshot:${request.snapshot_digest}`],
        next: nextMissingAblatePair(
          request.task_id,
          request.snapshot_digest,
          request.intervention.target,
        ),
      },
    )
  }
  if (request.action === 'compare') {
    return envelope(
      'compare',
      { status: 'needs_runs', mode: 'diff' },
      {
        refs: [`run:${request.baseline}/score`, `run:${request.candidate}/score`],
        files: [
          {
            kind: 'score',
            ref: `run:${request.baseline}/score`,
            path: evalArtifactPath({
              kind: 'run',
              id: request.baseline,
              file: 'score',
              ref: `run:${request.baseline}/score`,
            }),
          },
          {
            kind: 'score',
            ref: `run:${request.candidate}/score`,
            path: evalArtifactPath({
              kind: 'run',
              id: request.candidate,
              file: 'score',
              ref: `run:${request.candidate}/score`,
            }),
          },
        ],
      },
    )
  }
  const artifact = request.artifact ?? {
    kind: 'index' as const,
    id: 'tasks',
    ref: 'index:tasks',
  }
  return envelope(
    'show',
    {
      status: request.query ? 'search' : 'read',
      max_bytes: request.max_bytes,
      ...(request.query ? { query: request.query, in: request.in } : {}),
    },
    {
      refs: [artifact.ref],
      files: [
        {
          kind: pointerKind(artifact),
          ref: artifact.ref,
          path: evalArtifactPath(artifact),
        },
      ],
    },
  )
}
