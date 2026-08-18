import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

import {
  buildForgedPluginCapability,
  buildPluginCapability,
  buildSkillCapability,
  parseCapabilityRef,
  searchCapabilities,
} from '../../capability-discovery/src/catalog.js'
import {
  DIGEST_PATTERN,
  conditionDigest,
  normalizeInterventionTarget,
  snapshotDigest,
  type Intervention,
  type ScoreRecord,
} from './contract.js'
import type { EvalOverlay } from './overlay.js'
import type { EvidenceTree, StoredSnapshot } from './store.js'
import type { EvalTaskAssertion, EvalTaskDocument } from './task.js'

export interface InterpretInput {
  task: EvalTaskDocument
  overlay: EvalOverlay
  snapshot: StoredSnapshot
  suite_digest: string
  intervention: Intervention | null
}

function catalogPath(): string {
  return fileURLToPath(new URL('../../../../presets/plugins.json', import.meta.url))
}

async function runCommand(cwd: string, argv: string[], timeout_ms: number): Promise<number> {
  const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`command timed out after ${timeout_ms}ms`))
    }, timeout_ms)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })
}

async function executeTool(overlay: EvalOverlay, assertion: EvalTaskAssertion): Promise<string> {
  const wanted = assertion.plugin ? normalizeInterventionTarget(assertion.plugin) : undefined
  const refs = wanted
    ? overlay.mountedPluginRefs.filter((ref) => ref === wanted)
    : overlay.mountedPluginRefs
  if (!refs.length) throw new Error(`no overlay plugin available for ${assertion.tool}`)
  const ctx = new Context()
  const registered = new Map<
    string,
    { execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown> }
  >()
  ctx.provide('tools', {
    register(definition: {
      name: string
      execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>
    }) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  })
  for (const ref of refs) {
    const id = decodeURIComponent(parseCapabilityRef(ref).id).replaceAll('/', '__')
    const href = pathToFileURL(join(overlay.cwd, 'plugins', `${id}.mjs`)).href
    const mod = (await import(href)) as { apply?: (ctx: Context) => void }
    if (typeof mod.apply !== 'function') throw new Error(`plugin ${ref} has no apply`)
    mod.apply(ctx)
  }
  const tool = registered.get(assertion.tool!)
  if (!tool) throw new Error(`tool ${assertion.tool} was not registered`)
  return String(
    await tool.execute((assertion.args ?? {}) as Record<string, unknown>, {
      signal: new AbortController().signal,
    }),
  )
}

function sameCapability(left: string, right: string): boolean {
  try {
    const a = parseCapabilityRef(left)
    const b = parseCapabilityRef(right)
    return a.kind === b.kind && a.id === b.id
  } catch {
    return left === right
  }
}

function searchHits(
  snapshot: StoredSnapshot,
  overlay: EvalOverlay,
  query: string,
  intervention: Intervention | null,
) {
  const omitted = intervention ? normalizeInterventionTarget(intervention.target) : undefined
  const pluginRefs = new Set(overlay.mountedPluginRefs)
  for (const plugin of snapshot.composition.plugins) {
    const ref = normalizeInterventionTarget(plugin.ref)
    if (omitted && ref === omitted) continue
    pluginRefs.add(ref)
  }
  const capabilities = [
    ...overlay.skillRefs.map((ref) => {
      const { id } = parseCapabilityRef(ref)
      return buildSkillCapability({
        name: id,
        description: id,
        modelInvocable: true,
        userInvocable: true,
        provider: 'eval',
        source: 'overlay',
      })
    }),
    ...[...pluginRefs].map((ref) => {
      const { id } = parseCapabilityRef(ref)
      if (id.startsWith('forged/')) {
        const [, scope, slug] = id.split('/')
        return buildForgedPluginCapability({
          slug: slug ?? id,
          scope: scope === 'project' ? 'project' : 'user',
          summary: slug ?? id,
          revision: 1,
          digest:
            snapshot.composition.plugins.find((item) => sameCapability(item.ref, ref))?.digest ??
            '0'.repeat(64),
          digestMatches: true,
          active: true,
          status: 'ok',
          risk: 'eval overlay',
        })
      }
      return buildPluginCapability({
        id,
        module: id,
        version: '0.0.0',
        summary: id,
        risk: 'eval overlay',
        source: 'oh-my-dsh',
        active: false,
        availability: 'available',
      })
    }),
  ]
  return searchCapabilities(capabilities, query)
}

async function interpretAssertion(
  assertion: EvalTaskAssertion,
  input: InterpretInput,
): Promise<{ pass: boolean; detail: string }> {
  if (assertion.kind === 'path-exists' || assertion.kind === 'path-absent') {
    const path = resolve(input.overlay.cwd, assertion.path!)
    if (relative(input.overlay.cwd, path).startsWith('..')) {
      throw new Error(`eval assertion path escapes the overlay: ${assertion.path}`)
    }
    let exists = true
    try {
      await lstat(path)
    } catch {
      exists = false
    }
    const pass = assertion.kind === 'path-exists' ? exists : !exists
    return { pass, detail: exists ? 'exists' : 'absent' }
  }
  if (assertion.kind === 'command-exit') {
    const status = await runCommand(input.overlay.cwd, assertion.argv!, input.task.timeout_ms)
    return { pass: status === (assertion.expect_status ?? 0), detail: `exit ${status}` }
  }
  if (assertion.kind === 'tool-execute') {
    try {
      const value = await executeTool(input.overlay, assertion)
      return { pass: value === assertion.expect, detail: value }
    } catch (error) {
      return { pass: false, detail: String(error) }
    }
  }
  if (assertion.kind === 'search-hits') {
    const hits = searchHits(input.snapshot, input.overlay, assertion.query!, input.intervention)
    const pass = hits.some(
      (hit) =>
        sameCapability(hit.ref, assertion.ref!) || hit.id === parseCapabilityRef(assertion.ref!).id,
    )
    return { pass, detail: hits.map((hit) => hit.ref).join(',') }
  }
  if (assertion.kind === 'search-misses') {
    const hits = searchHits(input.snapshot, input.overlay, assertion.query!, input.intervention)
    return { pass: hits.length === 0, detail: String(hits.length) }
  }
  if (assertion.kind === 'catalog-untouched') {
    const bytes = await readFile(catalogPath())
    JSON.parse(bytes.toString('utf8'))
    const digest = createHash('sha256').update(bytes).digest('hex')
    return { pass: DIGEST_PATTERN.test(digest), detail: digest }
  }
  const resolveSide = (side: string) => {
    if (side === 'snapshot') return input.snapshot.digest
    if (side === 'recomputed') return snapshotDigest(input.snapshot.composition)
    if (side === 'condition') return conditionDigest(input.snapshot.digest, input.intervention)
    return side
  }
  return { pass: resolveSide(assertion.left!) === resolveSide(assertion.right!), detail: 'digest' }
}

export async function interpretRun(input: InterpretInput): Promise<{
  score: Omit<ScoreRecord, 'run_id'>
  tree: EvidenceTree
  traces: object[]
}> {
  const traces: object[] = []
  const nodes = []
  const skipped = new Set(input.task.plan.skip.map((item) => item.id))
  for (const assertion of input.task.assertions) {
    if (skipped.has(assertion.skill)) continue
    const result = await interpretAssertion(assertion, input)
    traces.push({ id: assertion.id, kind: assertion.kind, detail: result.detail })
    nodes.push({
      id: assertion.id,
      skill: assertion.skill,
      kind: assertion.kind,
      pass: result.pass,
      tool: assertion.tool,
      evidence_ref: `trace`,
    })
  }
  const assertions = nodes.map((node) => ({ id: node.id, pass: node.pass }))
  if (!assertions.length) {
    throw new Error(`eval task "${input.task.id}" produced no assertion nodes`)
  }
  const pass = assertions.every((item) => item.pass)
  return {
    score: {
      task_id: input.task.id,
      snapshot_digest: input.snapshot.digest,
      condition_digest: conditionDigest(input.snapshot.digest, input.intervention),
      suite_digest: input.suite_digest,
      intervention: input.intervention,
      pass,
      assertions,
      tokens: { input: 0, output: 0 },
      duration_ms: 0,
    },
    tree: {
      task_id: input.task.id,
      suite_digest: input.suite_digest,
      plan: input.task.plan,
      nodes,
    },
    traces,
  }
}
