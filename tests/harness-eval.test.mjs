import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'

import {
  COMPARE_MODES,
  EVAL_CONTROL_ACTIONS,
  EVAL_CONTROL_DESCRIPTION,
  EVAL_CONTROL_PARAMETERS,
  EVAL_STORE_DIR,
  SCORE_FORBIDDEN_KEYS,
  compareScores,
  conditionDigest,
  distillJustified,
  evalCanonical,
  evalSha256Hex,
  envelope,
  evalArtifactPath,
  nextAfterCompare,
  nextMissingAblatePair,
  parseEvalArtifactRef,
  parseEvalControlRequest,
  parseIntervention,
  parseScoreRecord,
  planEvalControl,
  promotionAllowed,
  runFilePointers,
  snapshotDigest,
} from '../dist/packages/harness-eval/src/contract.js'
import {
  HarnessEvalRuntime,
  apply as applyHarnessEval,
  bundledTasksDir,
} from '../dist/packages/harness-eval/src/index.js'
import { interpretRun } from '../dist/packages/harness-eval/src/interpret.js'
import { buildOverlay } from '../dist/packages/harness-eval/src/overlay.js'
import {
  compositionFromCapture,
  writeCapturedSnapshot,
} from '../dist/packages/harness-eval/src/snapshot.js'
import {
  assertDistillJustified,
  assertPromotionAllowed,
} from '../dist/packages/harness-eval/src/gate.js'
import {
  bundledSuiteDigest,
  evalStoreRoot,
  grepEvalStore,
  listTasks,
  readSnapshot,
  resolveTask,
  showArtifact,
  writeCompare,
  writeRun,
  writeSnapshot,
} from '../dist/packages/harness-eval/src/store.js'
import {
  parseEvalTaskDocument,
  suiteDigest,
  taskDigest,
} from '../dist/packages/harness-eval/src/task.js'
import { CapabilityDiscoveryRuntime } from '../dist/packages/capability-discovery/src/index.js'

const SNAPSHOT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_SNAPSHOT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const SUITE = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
const HERE = dirname(fileURLToPath(import.meta.url))
const ECHO_SOURCE = await readFile(
  join(HERE, '../packages/harness-eval/tasks/forged-tool-invocable/fixture/echo.mjs'),
  'utf8',
)
const PLANTED_JUDGE = join(
  HERE,
  '../packages/harness-eval/tasks/score-rejects-judge/fixture/score-with-judge.json',
)

function score(overrides = {}) {
  const intervention = overrides.intervention === undefined ? null : overrides.intervention
  const snapshot_digest = overrides.snapshot_digest ?? SNAPSHOT
  const assertions = overrides.assertions ?? [
    { id: 'files-exist', pass: true },
    { id: 'tests-pass', pass: true },
  ]
  const pass = overrides.pass ?? assertions.every((item) => item.pass)
  return {
    task_id: 'wordcount',
    run_id: 'run-intact',
    snapshot_digest,
    condition_digest: conditionDigest(snapshot_digest, intervention),
    suite_digest: SUITE,
    intervention,
    pass,
    assertions,
    tokens: { input: 100, output: 20 },
    duration_ms: 1_000,
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key]) => !['intervention', 'assertions', 'snapshot_digest'].includes(key),
      ),
    ),
    intervention,
    assertions,
    pass,
    snapshot_digest,
    suite_digest: overrides.suite_digest ?? SUITE,
    condition_digest: conditionDigest(snapshot_digest, intervention),
  }
}

function evalHarness() {
  const ctx = new Context()
  const registeredTools = new Map()
  const registeredCommands = new Map()
  const promptSections = []
  ctx.provide('tools', {
    register(definition) {
      registeredTools.set(definition.name, definition)
      return () => registeredTools.delete(definition.name)
    },
    schemas() {
      return [...registeredTools.values()].map((definition) => ({
        name: definition.name,
        description: definition.description ?? '',
      }))
    },
  })
  ctx.provide('commands', {
    register(definition) {
      registeredCommands.set(definition.name, definition)
      return () => registeredCommands.delete(definition.name)
    },
    list() {
      return [...registeredCommands.values()]
    },
  })
  ctx.provide('systemPrompt', {
    section(section) {
      promptSections.push(section)
      return () => {}
    },
  })
  return { ctx, registeredTools, registeredCommands, promptSections }
}

async function evalRoots() {
  return {
    dshHome: await mkdtemp(join(tmpdir(), 'omd-eval-home-')),
    workspace: await mkdtemp(join(tmpdir(), 'omd-eval-ws-')),
    bundledTasks: bundledTasksDir(),
  }
}

async function evalFixture() {
  const harness = evalHarness()
  const roots = await evalRoots()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = roots.dshHome
  const restore = () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  const fiber = harness.ctx.plugin(HarnessEvalRuntime)
  await fiber
  const agent = {
    id: 'agent-eval',
    ctx: harness.ctx,
    session: { header: { cwd: roots.workspace } },
  }
  const tool = harness.registeredTools.get('eval_control')
  const exec = { agent, signal: new AbortController().signal }
  return { harness, roots, agent, tool, exec, restore, fiber }
}

function echoPlugin(revision = 1) {
  return {
    ref: 'plugin:forged/user/eval-echo',
    bytes: Buffer.from(ECHO_SOURCE),
    revision,
  }
}

test('eval_control action enum is the locked four-verb surface', () => {
  assert.deepEqual([...EVAL_CONTROL_ACTIONS], ['snapshot', 'run', 'compare', 'show'])
  assert.deepEqual(EVAL_CONTROL_PARAMETERS.action.enum, [...EVAL_CONTROL_ACTIONS])
  assert.deepEqual([...COMPARE_MODES], ['diff', 'ablate'])
  assert.match(EVAL_CONTROL_DESCRIPTION, /snapshot before run/)
  assert.match(EVAL_CONTROL_DESCRIPTION, /machine assertions/)
  assert.match(EVAL_CONTROL_DESCRIPTION, /does not apply/)
  assert.match(EVAL_CONTROL_DESCRIPTION, /never read assistant text, LLM-as-judge, or self-report/)
  assert.match(EVAL_CONTROL_DESCRIPTION, /Four actions only/)
})

test('registered tool schema cannot drift from the contract', () => {
  const harness = evalHarness()
  applyHarnessEval(harness.ctx)
  const tool = harness.registeredTools.get('eval_control')
  assert.ok(tool)
  assert.deepEqual(tool.parameters.properties.action.enum, [...EVAL_CONTROL_ACTIONS])
  assert.equal(tool.description, EVAL_CONTROL_DESCRIPTION)
  assert.equal(harness.promptSections[0].name, 'omd:harness-eval')
  assert.ok(harness.registeredCommands.get('omd-eval'))
})

test('run requires a snapshot digest and never accepts current', () => {
  assert.throws(
    () => parseEvalControlRequest({ action: 'run', task_id: 'wordcount' }),
    /snapshot_digest/,
  )
  assert.throws(
    () =>
      parseEvalControlRequest({
        action: 'run',
        task_id: 'wordcount',
        snapshot_digest: 'current',
      }),
    /64-character/,
  )
  assert.throws(
    () =>
      parseEvalControlRequest({
        action: 'compare',
        mode: 'diff',
        task_id: 'wordcount',
        baseline: 'current',
        candidate: 'run-new',
      }),
    /cannot be "current"/,
  )
  const parsed = parseEvalControlRequest({
    action: 'run',
    task_id: 'wordcount',
    snapshot_digest: SNAPSHOT,
  })
  assert.equal(parsed.intervention, null)
  assert.equal(parsed.snapshot_digest, SNAPSHOT)
})

test('forbidden optimizer actions and removed list verbs are rejected', () => {
  for (const action of ['apply', 'judge', 'suggest', 'promote', 'train']) {
    assert.throws(() => parseEvalControlRequest({ action }), new RegExp(action))
  }
  for (const action of ['tasks', 'runs', 'score', 'grep']) {
    assert.throws(() => parseEvalControlRequest({ action }), /was removed; use show/)
  }
  assert.throws(
    () =>
      parseEvalControlRequest({
        action: 'run',
        task_id: 'wordcount',
        snapshot_digest: SNAPSHOT,
        judge: 'yes',
      }),
    /unknown fields/,
  )
})

test('intervention is ablate-only on a skill or plugin ref', () => {
  const forged = parseIntervention({
    op: 'ablate',
    target: 'plugin:forged/user/wordcount',
  })
  assert.equal(forged.target, 'plugin:forged%2Fuser%2Fwordcount')
  assert.equal(
    parseIntervention({ op: 'ablate', target: 'plugin:forged%2Fuser%2Fwordcount' }).target,
    forged.target,
  )
  assert.throws(() => parseIntervention({ op: 'include', target: 'skill:debug' }), /ablate/)
  assert.throws(() => parseIntervention({ op: 'ablate', target: 'tool:bash' }), /skill or plugin/)
  const run = parseEvalControlRequest({
    action: 'run',
    task_id: 'wordcount',
    snapshot_digest: SNAPSHOT,
    target: 'skill:verify-before-done',
  })
  assert.equal(run.intervention.op, 'ablate')
  assert.equal(run.intervention.target, 'skill:verify-before-done')
})

test('compare modes do not share arguments', () => {
  const diff = parseEvalControlRequest({
    action: 'compare',
    mode: 'diff',
    task_id: 'wordcount',
    baseline: 'run-old',
    candidate: 'run-new',
  })
  assert.equal(diff.mode, 'diff')
  assert.throws(
    () =>
      parseEvalControlRequest({
        action: 'compare',
        mode: 'diff',
        task_id: 'wordcount',
        baseline: 'run-old',
        candidate: 'run-new',
        target: 'skill:debug',
      }),
    /not intervention/,
  )
  const ablate = parseEvalControlRequest({
    action: 'compare',
    mode: 'ablate',
    task_id: 'wordcount',
    snapshot_digest: SNAPSHOT,
    target: 'plugin:forged/user/wordcount',
  })
  assert.equal(ablate.mode, 'ablate')
  assert.throws(
    () =>
      parseEvalControlRequest({
        action: 'compare',
        mode: 'ablate',
        task_id: 'wordcount',
        snapshot_digest: SNAPSHOT,
        target: 'skill:debug',
        baseline: 'run-old',
      }),
    /intact\/ablated pair/,
  )
})

test('eval artifacts resolve to the Meta-Harness filesystem layout', () => {
  assert.equal(EVAL_STORE_DIR, 'omd/eval')
  assert.equal(
    evalArtifactPath(parseEvalArtifactRef('snapshot:' + SNAPSHOT)),
    `${EVAL_STORE_DIR}/snapshots/${SNAPSHOT}/snapshot.json`,
  )
  assert.equal(
    evalArtifactPath(parseEvalArtifactRef('run:run-intact/score')),
    `${EVAL_STORE_DIR}/runs/run-intact/score.json`,
  )
  assert.equal(
    evalArtifactPath(parseEvalArtifactRef('run:run-intact', 'trace')),
    `${EVAL_STORE_DIR}/runs/run-intact/trace.jsonl`,
  )
  assert.deepEqual(
    runFilePointers('run-intact').map((file) => file.path),
    [
      `${EVAL_STORE_DIR}/runs/run-intact/meta.json`,
      `${EVAL_STORE_DIR}/runs/run-intact/score.json`,
      `${EVAL_STORE_DIR}/runs/run-intact/intervention.json`,
      `${EVAL_STORE_DIR}/runs/run-intact/assertions.json`,
      `${EVAL_STORE_DIR}/runs/run-intact/trace.jsonl`,
    ],
  )
  assert.throws(() => parseEvalArtifactRef('run:run-intact/score', 'trace'), /does not match/)
})

test('score records reject self-report and require suite_digest', () => {
  for (const key of SCORE_FORBIDDEN_KEYS) {
    assert.throws(() => parseScoreRecord(score({ [key]: 'good' })), /machine assertions/)
  }
  assert.throws(
    () =>
      parseScoreRecord(
        score({
          pass: true,
          assertions: [
            { id: 'files-exist', pass: true },
            { id: 'tests-pass', pass: false },
          ],
        }),
      ),
    /conjunction/,
  )
  const { suite_digest: _omit, ...missingSuite } = score()
  assert.throws(() => parseScoreRecord(missingSuite), /suite_digest/)
})

test('snapshot and condition digests are content-addressed and intervention-stable', () => {
  const left = snapshotDigest({
    skills: [
      { ref: 'skill:b', digest: SNAPSHOT },
      { ref: 'skill:a', digest: OTHER_SNAPSHOT },
    ],
    plugins: [{ ref: 'plugin:forged/user/wordcount', digest: SNAPSHOT, revision: 2 }],
    patch_digest: OTHER_SNAPSHOT,
  })
  const right = snapshotDigest({
    skills: [
      { ref: 'skill:a', digest: OTHER_SNAPSHOT },
      { ref: 'skill:b', digest: SNAPSHOT },
    ],
    plugins: [{ ref: 'plugin:forged%2Fuser%2Fwordcount', digest: SNAPSHOT, revision: 2 }],
    patch_digest: OTHER_SNAPSHOT,
  })
  assert.equal(left, right)
  assert.match(left, /^[0-9a-f]{64}$/)
  assert.equal(conditionDigest(SNAPSHOT, null), SNAPSHOT)
  assert.notEqual(conditionDigest(SNAPSHOT, { op: 'ablate', target: 'skill:debug' }), SNAPSHOT)
  assert.equal(
    conditionDigest(SNAPSHOT, { op: 'ablate', target: 'skill:debug' }),
    conditionDigest(SNAPSHOT, { op: 'ablate', target: 'skill:debug' }),
  )
})

test('compare mode=ablate is the faithfulness with/without test', () => {
  const intact = parseScoreRecord(score())
  const ignored = parseScoreRecord(
    score({
      run_id: 'run-ablate',
      intervention: { op: 'ablate', target: 'plugin:forged/user/wordcount' },
      tokens: { input: 180, output: 20 },
    }),
  )
  const unused = compareScores({ mode: 'ablate', baseline: intact, candidate: ignored })
  assert.equal(unused.faithful, false)
  assert.equal(unused.ignored, true)
  assert.equal(unused.cost_shifted, true)
  assert.equal(distillJustified(unused), false)
  assert.match(nextAfterCompare(unused)[0].instruction, /not causally used/)

  const used = compareScores({
    mode: 'ablate',
    baseline: intact,
    candidate: score({
      run_id: 'run-ablate-fail',
      intervention: { op: 'ablate', target: 'plugin:forged/user/wordcount' },
      assertions: [
        { id: 'files-exist', pass: true },
        { id: 'tests-pass', pass: false },
      ],
    }),
  })
  assert.equal(used.faithful, true)
  assert.equal(used.ignored, false)
  assert.equal(distillJustified(used), true)
  assert.throws(
    () =>
      compareScores({
        mode: 'ablate',
        baseline: intact,
        candidate: score({ snapshot_digest: OTHER_SNAPSHOT, run_id: 'run-other' }),
      }),
    /same snapshot_digest/,
  )
})

test('compare mode=diff is the promotion gate and rejects suite mismatch', () => {
  const baseline = parseScoreRecord(score())
  const regress = compareScores({
    mode: 'diff',
    baseline,
    candidate: score({
      run_id: 'run-new',
      snapshot_digest: OTHER_SNAPSHOT,
      assertions: [
        { id: 'files-exist', pass: true },
        { id: 'tests-pass', pass: false },
      ],
    }),
  })
  assert.equal(regress.regress, true)
  assert.equal(regress.faithful, undefined)
  assert.equal(promotionAllowed(regress), false)
  assert.match(nextAfterCompare(regress)[0].instruction, /do not prepare_promote/)

  const ok = compareScores({
    mode: 'diff',
    baseline,
    candidate: score({ run_id: 'run-new', snapshot_digest: OTHER_SNAPSHOT }),
  })
  assert.equal(ok.regress, false)
  assert.equal(promotionAllowed(ok), true)
  assert.equal(nextAfterCompare(ok)[0].tool, 'plugin_forge')
  assert.equal(nextAfterCompare(ok)[0].action, 'prepare_promote')

  assert.throws(
    () =>
      compareScores({
        mode: 'diff',
        baseline,
        candidate: score({
          run_id: 'run-new',
          snapshot_digest: OTHER_SNAPSHOT,
          suite_digest: OTHER_SNAPSHOT,
        }),
      }),
    /share suite_digest/,
  )
})

test('envelope is files and next actions, not a narrative summary', () => {
  assert.throws(() => envelope('show', { summary: 'the agent did well' }), /narrative summary/)
  const planned = planEvalControl(
    parseEvalControlRequest({
      action: 'compare',
      mode: 'ablate',
      task_id: 'wordcount',
      snapshot_digest: SNAPSHOT,
      target: 'skill:debug',
    }),
  )
  assert.ok(!Object.hasOwn(planned, 'summary'))
  assert.ok(!Object.hasOwn(planned.data, 'summary'))
  assert.deepEqual(
    planned.next.map((item) => item.action),
    nextMissingAblatePair('wordcount', SNAPSHOT, 'skill:debug').map((item) => item.action),
  )
  assert.equal(planned.next[0].args.intervention, undefined)
  assert.deepEqual(planned.next[1].args.intervention, {
    op: 'ablate',
    target: 'skill:debug',
  })
})

test('show covers list and grep; the grep action is gone', () => {
  const shown = planEvalControl(
    parseEvalControlRequest({ action: 'show', ref: `run:run-intact/trace` }),
  )
  assert.equal(shown.files[0].path, `${EVAL_STORE_DIR}/runs/run-intact/trace.jsonl`)
  const listed = parseEvalControlRequest({ action: 'show' })
  assert.equal(listed.artifact, undefined)
  const grepped = parseEvalControlRequest({ action: 'show', query: 'wordcount', in: 'traces' })
  assert.equal(grepped.query, 'wordcount')
  assert.equal(grepped.in, 'traces')
  assert.throws(() => parseEvalControlRequest({ action: 'show', query: 'x'.repeat(513) }), /512/)
})

test('task documents reject unknown kinds and orphan plan skills', () => {
  const valid = parseEvalTaskDocument({
    id: 'snapshot-stable',
    summary: 'Rehash a snapshot.',
    suite: 'omd-eval-v1',
    plan: { skills: ['assert-snapshot-stable'] },
    assertions: [
      {
        id: 'digest-stable',
        skill: 'assert-snapshot-stable',
        kind: 'digest-equals',
        left: 'snapshot',
        right: 'recomputed',
      },
    ],
    timeout_ms: 30_000,
  })
  assert.equal(valid.id, 'snapshot-stable')
  assert.throws(
    () =>
      parseEvalTaskDocument({
        ...valid,
        assertions: [{ id: 'x', skill: 'assert-snapshot-stable', kind: 'llm-judge' }],
      }),
    /first-party kind/,
  )
  assert.throws(
    () =>
      parseEvalTaskDocument({
        ...valid,
        plan: { skills: ['assert-snapshot-stable', 'unused-skill'] },
      }),
    /not referenced/,
  )
  const changed = parseEvalTaskDocument({
    ...valid,
    assertions: [{ ...valid.assertions[0], id: 'digest-changed' }],
  })
  const left = suiteDigest([
    { id: valid.id, task_digest: 'a'.repeat(64) },
    { id: 'other', task_digest: 'b'.repeat(64) },
  ])
  const right = suiteDigest([
    { id: changed.id, task_digest: 'c'.repeat(64) },
    { id: 'other', task_digest: 'b'.repeat(64) },
  ])
  assert.notEqual(left, right)
})

test('bundled omd-eval-v1 suite is eight tasks with a stable digest', async () => {
  const roots = {
    dshHome: await mkdtemp(join(tmpdir(), 'omd-eval-suite-')),
    bundledTasks: bundledTasksDir(),
  }
  const tasks = await listTasks(roots)
  assert.deepEqual(
    tasks.map((task) => task.id),
    [
      'ablate-changes-condition',
      'catalog-untouched',
      'forged-search-hit',
      'forged-tool-invocable',
      'gap-is-not-a-score',
      'no-extra-write',
      'score-rejects-judge',
      'snapshot-stable',
    ],
  )
  const first = await bundledSuiteDigest(roots)
  const second = await bundledSuiteDigest(roots)
  assert.equal(first, second)
  assert.match(first, /^[0-9a-f]{64}$/)
  const entries = []
  for (const task of tasks) {
    const resolved = await resolveTask(roots, task.id)
    entries.push({ id: task.id, task_digest: await taskDigest(resolved.dir, task) })
  }
  assert.equal(suiteDigest(entries), first)
})

test('snapshot store round-trips and refuses a symlink directory', async () => {
  const roots = await evalRoots()
  const { composition, blobs } = compositionFromCapture({
    skills: [{ name: 'verify-before-done', bytes: Buffer.from('# skill\n') }],
    plugins: [echoPlugin()],
    patchBytes: null,
  })
  const first = await writeSnapshot(roots, composition, blobs)
  const second = await writeSnapshot(roots, composition, blobs)
  assert.equal(first.digest, second.digest)
  const stored = await readSnapshot(roots, first.digest)
  assert.equal(stored.digestMatches, true)
  assert.equal(stored.files.length, 2)
  const swapped = compositionFromCapture({
    skills: [{ name: 'verify-before-done', bytes: Buffer.from('# skill\n') }],
    plugins: [{ ...echoPlugin(), bytes: Buffer.from(`${ECHO_SOURCE}\n// changed\n`) }],
    patchBytes: null,
  })
  assert.notEqual(snapshotDigest(swapped.composition), first.digest)
  await rm(first.dir, { recursive: true, force: true })
  await symlink(tmpdir(), first.dir)
  await assert.rejects(writeSnapshot(roots, composition, blobs), /symlink/)
})

test('run write then show/grep, and the catalog is never opened for write', async () => {
  const roots = await evalRoots()
  const catalogPath = new URL('../presets/plugins.json', import.meta.url)
  const catalogBefore = await readFile(catalogPath)
  const { digest } = await writeCapturedSnapshot(roots, {
    skills: [],
    plugins: [echoPlugin()],
    patchBytes: null,
  })
  const suite = await bundledSuiteDigest(roots)
  const { run_id } = await writeRun(roots, {
    task_id: 'snapshot-stable',
    snapshot_digest: digest,
    suite_digest: suite,
    intervention: null,
    score: {
      task_id: 'snapshot-stable',
      snapshot_digest: digest,
      condition_digest: digest,
      suite_digest: suite,
      intervention: null,
      pass: true,
      assertions: [{ id: 'digest-stable', pass: true }],
      tokens: { input: 0, output: 0 },
      duration_ms: 1,
    },
    tree: {
      task_id: 'snapshot-stable',
      suite_digest: suite,
      plan: { skills: ['assert-snapshot-stable'], skip: [] },
      nodes: [
        { id: 'digest-stable', skill: 'assert-snapshot-stable', kind: 'digest-equals', pass: true },
      ],
    },
    traces: [{ id: 'digest-stable', kind: 'digest-equals', detail: 'digest' }],
    meta: { task_id: 'snapshot-stable' },
  })
  const shown = await showArtifact(
    roots,
    { kind: 'run', id: run_id, file: 'score', ref: `run:${run_id}/score` },
    16_384,
  )
  assert.match(shown.content, /digest-stable/)
  const hits = await grepEvalStore(roots, 'digest-stable', 'assertions')
  assert.ok(hits.some((hit) => hit.line.includes('digest-stable')))
  assert.match(evalStoreRoot(roots), /omd\/eval$/)
  const catalogAfter = await readFile(catalogPath)
  assert.deepEqual(catalogAfter, catalogBefore)
})

test('overlay copies fixtures, ablates a forged plugin, and dispose deletes the tree', async () => {
  const roots = await evalRoots()
  const captured = await writeCapturedSnapshot(roots, {
    skills: [{ name: 'debug', bytes: Buffer.from('# debug\n') }],
    plugins: [echoPlugin()],
    patchBytes: null,
  })
  const snapshot = await readSnapshot(roots, captured.digest)
  const task = await resolveTask(roots, 'forged-tool-invocable')
  const intact = await buildOverlay({
    snapshot,
    intervention: null,
    fixtureDir: join(task.dir, 'fixture'),
    taskDir: task.dir,
  })
  try {
    assert.ok(intact.mountedPluginRefs.some((ref) => ref.includes('eval-echo')))
    assert.ok(intact.skillRefs.some((ref) => ref.includes('debug')))
    await readFile(join(intact.cwd, 'echo.mjs'))
  } finally {
    await intact.dispose()
  }
  await assert.rejects(readFile(join(intact.cwd, 'echo.mjs')))
  const ablated = await buildOverlay({
    snapshot,
    intervention: { op: 'ablate', target: 'plugin:forged/user/eval-echo' },
    fixtureDir: join(task.dir, 'fixture'),
    taskDir: task.dir,
  })
  try {
    assert.equal(ablated.mountedPluginRefs.length, 0)
  } finally {
    await ablated.dispose()
  }
})

test('interpreter scores forged echo, catalog hash, and rejects path escape / judge scores', async () => {
  const roots = await evalRoots()
  const captured = await writeCapturedSnapshot(roots, {
    skills: [],
    plugins: [echoPlugin()],
    patchBytes: null,
  })
  const snapshot = await readSnapshot(roots, captured.digest)
  const task = await resolveTask(roots, 'forged-tool-invocable')
  const suite = await bundledSuiteDigest(roots)
  const overlay = await buildOverlay({
    snapshot,
    intervention: null,
    fixtureDir: join(task.dir, 'fixture'),
    taskDir: task.dir,
  })
  try {
    const first = await interpretRun({
      task: task.document,
      overlay,
      snapshot,
      suite_digest: suite,
      intervention: null,
    })
    const second = await interpretRun({
      task: task.document,
      overlay,
      snapshot,
      suite_digest: suite,
      intervention: null,
    })
    assert.equal(first.score.pass, true)
    assert.deepEqual(first.score.assertions, second.score.assertions)
    assert.equal(first.score.suite_digest, suite)
  } finally {
    await overlay.dispose()
  }

  const missing = await buildOverlay({
    snapshot,
    intervention: { op: 'ablate', target: 'plugin:forged/user/eval-echo' },
  })
  try {
    const failed = await interpretRun({
      task: task.document,
      overlay: missing,
      snapshot,
      suite_digest: suite,
      intervention: { op: 'ablate', target: 'plugin:forged/user/eval-echo' },
    })
    assert.equal(failed.score.pass, false)
    assert.equal(failed.score.assertions[0].pass, false)
  } finally {
    await missing.dispose()
  }

  const catalogTask = await resolveTask(roots, 'catalog-untouched')
  const catalogOverlay = await buildOverlay({ snapshot, intervention: null })
  try {
    const catalog = await interpretRun({
      task: catalogTask.document,
      overlay: catalogOverlay,
      snapshot,
      suite_digest: suite,
      intervention: null,
    })
    assert.equal(catalog.score.pass, true)
  } finally {
    await catalogOverlay.dispose()
  }

  assert.throws(
    () =>
      parseEvalTaskDocument({
        id: 'escape',
        summary: 'escape',
        suite: 'omd-eval-v1',
        plan: { skills: ['assert-cwd-clean'] },
        assertions: [
          { id: 'escape', skill: 'assert-cwd-clean', kind: 'path-exists', path: '../secret' },
        ],
        timeout_ms: 30_000,
      }),
    /escapes the overlay/,
  )
  await assert.rejects(
    async () => parseScoreRecord(JSON.parse(await readFile(PLANTED_JUDGE, 'utf8'))),
    /machine assertions/,
  )
})

test('runtime snapshot → run echo → ablate → compare is faithful', async () => {
  const { harness, roots, tool, exec, restore } = await evalFixture()
  const catalogPath = new URL('../presets/plugins.json', import.meta.url)
  const catalogBefore = await readFile(catalogPath)
  try {
    const captured = JSON.parse(await tool.execute({ action: 'snapshot' }, exec))
    assert.equal(captured.action, 'snapshot')
    assert.match(captured.data.snapshot_digest, /^[0-9a-f]{64}$/)

    const planted = await writeCapturedSnapshot(roots, {
      skills: [],
      plugins: [echoPlugin()],
      patchBytes: null,
    })
    const intact = JSON.parse(
      await tool.execute(
        {
          action: 'run',
          task_id: 'forged-tool-invocable',
          snapshot_digest: planted.digest,
        },
        exec,
      ),
    )
    assert.equal(intact.data.pass, true)
    const ablated = JSON.parse(
      await tool.execute(
        {
          action: 'run',
          task_id: 'forged-tool-invocable',
          snapshot_digest: planted.digest,
          target: 'plugin:forged/user/eval-echo',
        },
        exec,
      ),
    )
    assert.equal(ablated.data.pass, false)
    const compared = JSON.parse(
      await tool.execute(
        {
          action: 'compare',
          mode: 'ablate',
          task_id: 'forged-tool-invocable',
          snapshot_digest: planted.digest,
          target: 'plugin:forged/user/eval-echo',
        },
        exec,
      ),
    )
    assert.equal(compared.data.faithful, true)
    assert.equal(distillJustified(compared.data), true)

    const listed = JSON.parse(await tool.execute({ action: 'show' }, exec))
    assert.ok(listed.data.tasks.some((task) => task.id === 'forged-tool-invocable'))
    const grepped = JSON.parse(
      await tool.execute({ action: 'show', query: 'tool-invocable', in: 'assertions' }, exec),
    )
    assert.ok(grepped.data.hits.length > 0)

    await assert.rejects(
      tool.execute(
        { action: 'run', task_id: 'forged-tool-invocable', snapshot_digest: SNAPSHOT },
        exec,
      ),
      /unknown or drifted snapshot/,
    )
    const catalogAfter = await readFile(catalogPath)
    assert.deepEqual(catalogAfter, catalogBefore)
    assert.ok(harness.registeredCommands.get('omd-eval'))
  } finally {
    restore()
    await harness.ctx.root.fiber.dispose()
  }
})

test('capability_search finds tool:eval_control after mount', async () => {
  const harness = evalHarness()
  harness.ctx.provide('skills', {
    snapshot: async () => ({ complete: true, skills: [] }),
  })
  harness.ctx.provide('mcpControl', { list: () => [] })
  harness.ctx.provide('pluginControl', { list: () => [] })
  await harness.ctx.plugin(HarnessEvalRuntime)
  await harness.ctx.plugin(CapabilityDiscoveryRuntime)
  const search = harness.registeredTools.get('capability_search')
  const agent = {
    id: 'agent-eval',
    ctx: harness.ctx,
    session: { header: { cwd: '/workspace' } },
  }
  const output = JSON.parse(
    await search.execute(
      { action: 'search', query: 'eval_control machine assertions', kinds: 'tool', limit: 12 },
      { agent, signal: new AbortController().signal },
    ),
  )
  assert.ok(output.hits.some((hit) => hit.ref === 'tool:eval_control'))
  await harness.ctx.root.fiber.dispose()
})

async function plantScoreRun(roots, suite, snapshotDigest, overrides = {}) {
  const intervention = overrides.intervention === undefined ? null : overrides.intervention
  const assertions = overrides.assertions ?? [{ id: 'digest-stable', pass: true }]
  const pass = overrides.pass ?? assertions.every((item) => item.pass)
  const written = await writeRun(roots, {
    task_id: 'snapshot-stable',
    snapshot_digest: snapshotDigest,
    suite_digest: suite,
    intervention,
    score: {
      task_id: 'snapshot-stable',
      snapshot_digest: snapshotDigest,
      condition_digest: conditionDigest(snapshotDigest, intervention),
      suite_digest: suite,
      intervention,
      pass,
      assertions,
      tokens: { input: 0, output: 0 },
      duration_ms: 1,
    },
    tree: {
      task_id: 'snapshot-stable',
      suite_digest: suite,
      plan: { skills: ['assert-snapshot-stable'], skip: [] },
      nodes: [],
    },
    traces: [],
    meta: {},
  })
  return {
    ...written,
    score: {
      task_id: 'snapshot-stable',
      run_id: written.run_id,
      snapshot_digest: snapshotDigest,
      condition_digest: conditionDigest(snapshotDigest, intervention),
      suite_digest: suite,
      intervention,
      pass,
      assertions,
      tokens: { input: 0, output: 0 },
      duration_ms: 1,
    },
  }
}

test('promotion gate requires a non-regressing diff and a faithful ablate', async () => {
  const roots = await evalRoots()
  const pluginRef = 'plugin:forged/user/eval-echo'
  const first = await writeSnapshot(
    roots,
    {
      skills: [],
      plugins: [{ ref: pluginRef, digest: SNAPSHOT, revision: 1 }],
      patch_digest: '',
    },
    { files: [{ ref: pluginRef, bytes: Buffer.from(ECHO_SOURCE) }] },
  )
  const second = await writeSnapshot(
    roots,
    {
      skills: [],
      plugins: [{ ref: pluginRef, digest: OTHER_SNAPSHOT, revision: 2 }],
      patch_digest: '',
    },
    { files: [{ ref: pluginRef, bytes: Buffer.from(ECHO_SOURCE + '\n// rev2\n') }] },
  )
  const suite = await bundledSuiteDigest(roots)
  await assert.rejects(assertPromotionAllowed(roots, pluginRef), /mode=diff/)

  const baseline = await plantScoreRun(roots, suite, first.digest)
  const candidate = await plantScoreRun(roots, suite, second.digest)
  const diff = compareScores({
    mode: 'diff',
    baseline: baseline.score,
    candidate: candidate.score,
  })
  await writeCompare(roots, evalSha256Hex(evalCanonical(diff)), diff)
  await assert.rejects(assertPromotionAllowed(roots, pluginRef), /mode=ablate/)

  const intact = await plantScoreRun(roots, suite, first.digest)
  const ablated = await plantScoreRun(roots, suite, first.digest, {
    intervention: { op: 'ablate', target: pluginRef },
    assertions: [{ id: 'digest-stable', pass: false }],
  })
  const ablate = compareScores({
    mode: 'ablate',
    baseline: intact.score,
    candidate: ablated.score,
    target: pluginRef,
  })
  await writeCompare(roots, evalSha256Hex(evalCanonical(ablate)), ablate)
  const allowed = await assertPromotionAllowed(roots, pluginRef)
  assert.equal(allowed.diff.regress, false)
  assert.equal(allowed.ablate.faithful, true)
})

test('distill gate requires a faithful ablate of the skill', async () => {
  const roots = await evalRoots()
  const skillRef = 'skill:release-tagging'
  const captured = await writeCapturedSnapshot(roots, {
    skills: [{ name: 'release-tagging', bytes: Buffer.from('# skill\n') }],
    plugins: [],
    patchBytes: null,
  })
  const suite = await bundledSuiteDigest(roots)
  await assert.rejects(assertDistillJustified(roots, skillRef), /causally used/)

  const intact = await plantScoreRun(roots, suite, captured.digest)
  const ablated = await plantScoreRun(roots, suite, captured.digest, {
    intervention: { op: 'ablate', target: skillRef },
    assertions: [{ id: 'digest-stable', pass: false }],
  })
  const ablate = compareScores({
    mode: 'ablate',
    baseline: intact.score,
    candidate: ablated.score,
    target: skillRef,
  })
  await writeCompare(roots, evalSha256Hex(evalCanonical(ablate)), ablate)
  const justified = await assertDistillJustified(roots, skillRef)
  assert.equal(justified.faithful, true)
})
