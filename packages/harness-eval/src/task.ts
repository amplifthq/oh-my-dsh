import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { DIGEST_PATTERN, TASK_ID_PATTERN, evalCanonical, evalSha256Hex } from './contract.js'

export const EVAL_ASSERTION_KINDS = [
  'path-exists',
  'path-absent',
  'command-exit',
  'tool-execute',
  'search-hits',
  'search-misses',
  'catalog-untouched',
  'digest-equals',
] as const

export type EvalAssertionKind = (typeof EVAL_ASSERTION_KINDS)[number]

export interface EvalTaskSkip {
  id: string
  reason: string
}

export interface EvalTaskAssertion {
  id: string
  skill: string
  kind: EvalAssertionKind
  path?: string
  argv?: string[]
  expect_status?: number
  tool?: string
  plugin?: string
  args?: Record<string, unknown>
  expect?: string
  query?: string
  ref?: string
  left?: string
  right?: string
}

export interface EvalTaskDocument {
  id: string
  summary: string
  suite: string
  plan: { skills: string[]; skip: EvalTaskSkip[] }
  fixture?: string
  assertions: EvalTaskAssertion[]
  timeout_ms: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`eval task ${field} is required`)
  return value.trim()
}

export function parseEvalTaskDocument(value: unknown): EvalTaskDocument {
  if (!isRecord(value)) throw new Error('eval task must be an object')
  const id = requireString(value.id, 'id')
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error(
      'eval task id must be 1-41 characters of lowercase letters, digits, and hyphens',
    )
  }
  if (
    !isRecord(value.plan) ||
    !Array.isArray(value.plan.skills) ||
    value.plan.skills.length === 0
  ) {
    throw new Error('eval task plan.skills must be a non-empty string array')
  }
  const skills = value.plan.skills.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`eval task plan.skills[${index}] must be a non-empty string`)
    }
    return item.trim()
  })
  const skip = Array.isArray(value.plan.skip)
    ? value.plan.skip.map((item, index) => {
        if (!isRecord(item)) throw new Error(`eval task plan.skip[${index}] must be an object`)
        return {
          id: requireString(item.id, `plan.skip[${index}].id`),
          reason: requireString(item.reason, `plan.skip[${index}].reason`),
        }
      })
    : []
  if (!Array.isArray(value.assertions) || value.assertions.length === 0) {
    throw new Error('eval task assertions must be a non-empty array')
  }
  const assertions = value.assertions.map((item, index) => parseAssertion(item, index))
  if (new Set(assertions.map((item) => item.id)).size !== assertions.length) {
    throw new Error('eval task assertion ids must be unique')
  }
  for (const skill of skills) {
    if (!assertions.some((item) => item.skill === skill)) {
      throw new Error(`eval task plan skill "${skill}" is not referenced by any assertion`)
    }
  }
  const timeout = value.timeout_ms
  if (
    typeof timeout !== 'number' ||
    !Number.isInteger(timeout) ||
    timeout < 1_000 ||
    timeout > 120_000
  ) {
    throw new Error('eval task timeout_ms must be an integer between 1000 and 120000')
  }
  const document: EvalTaskDocument = {
    id,
    summary: requireString(value.summary, 'summary'),
    suite: requireString(value.suite, 'suite'),
    plan: { skills, skip },
    assertions,
    timeout_ms: timeout,
  }
  if (value.fixture !== undefined) {
    const fixture = requireString(value.fixture, 'fixture')
    if (fixture.includes('..') || fixture.startsWith('/') || fixture.includes('\\')) {
      throw new Error('eval task fixture must be a relative directory name')
    }
    document.fixture = fixture
  }
  return document
}

function parseAssertion(value: unknown, index: number): EvalTaskAssertion {
  if (!isRecord(value)) throw new Error(`eval task assertions[${index}] must be an object`)
  const kind = requireString(value.kind, `assertions[${index}].kind`)
  if (!(EVAL_ASSERTION_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`eval task assertions[${index}].kind "${kind}" is not a first-party kind`)
  }
  const assertion: EvalTaskAssertion = {
    id: requireString(value.id, `assertions[${index}].id`),
    skill: requireString(value.skill, `assertions[${index}].skill`),
    kind: kind as EvalAssertionKind,
  }
  if (kind === 'path-exists' || kind === 'path-absent') {
    assertion.path = requireString(value.path, `assertions[${index}].path`)
    if (assertion.path.includes('..'))
      throw new Error(`eval task assertions[${index}].path escapes the overlay`)
  } else if (kind === 'command-exit') {
    if (
      !Array.isArray(value.argv) ||
      value.argv.some((item) => typeof item !== 'string' || !item)
    ) {
      throw new Error(`eval task assertions[${index}].argv must be a non-empty string array`)
    }
    assertion.argv = value.argv
    if (value.expect_status !== undefined) {
      if (typeof value.expect_status !== 'number' || !Number.isInteger(value.expect_status)) {
        throw new Error(`eval task assertions[${index}].expect_status must be an integer`)
      }
      assertion.expect_status = value.expect_status
    }
  } else if (kind === 'tool-execute') {
    assertion.tool = requireString(value.tool, `assertions[${index}].tool`)
    assertion.expect = requireString(value.expect, `assertions[${index}].expect`)
    if (value.plugin !== undefined)
      assertion.plugin = requireString(value.plugin, `assertions[${index}].plugin`)
    assertion.args = isRecord(value.args) ? value.args : {}
  } else if (kind === 'search-hits') {
    assertion.query = requireString(value.query, `assertions[${index}].query`)
    assertion.ref = requireString(value.ref, `assertions[${index}].ref`)
  } else if (kind === 'search-misses') {
    assertion.query = requireString(value.query, `assertions[${index}].query`)
  } else if (kind === 'digest-equals') {
    assertion.left = requireString(value.left, `assertions[${index}].left`)
    assertion.right = requireString(value.right, `assertions[${index}].right`)
  }
  return assertion
}

export async function taskDigest(taskDir: string, document: EvalTaskDocument): Promise<string> {
  const files: { path: string; bytes: string }[] = [
    { path: 'task.json', bytes: evalCanonical(document) },
  ]
  if (document.fixture) {
    const fixtureRoot = resolve(taskDir, document.fixture)
    const listed = await listFiles(fixtureRoot)
    for (const file of listed.sort()) {
      const rel = relative(fixtureRoot, file).split(sep).join('/')
      files.push({
        path: `${document.fixture}/${rel}`,
        bytes: evalSha256Hex(await readFile(file, 'utf8')),
      })
    }
  }
  return evalSha256Hex(evalCanonical(files))
}

export function suiteDigest(entries: { id: string; task_digest: string }[]): string {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id))
  for (const entry of sorted) {
    if (!TASK_ID_PATTERN.test(entry.id) || !DIGEST_PATTERN.test(entry.task_digest)) {
      throw new Error('suite digest entries must have a task id and a 64-char digest')
    }
  }
  return evalSha256Hex(evalCanonical(sorted))
}

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...(await listFiles(path)))
    else if (entry.isFile()) {
      const info = await stat(path)
      if (info.isFile()) found.push(path)
    }
  }
  return found
}
