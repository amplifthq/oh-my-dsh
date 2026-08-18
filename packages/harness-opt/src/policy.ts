import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import {
  evalCanonical,
  normalizeInterventionTarget,
  type CompareResult,
} from '../../harness-eval/src/contract.js'
import {
  OPT_ARMS,
  OPT_POLICY_FILE,
  OPT_STORE_DIR,
  emptyPolicy,
  optSha256Hex,
  parseOptPolicy,
  type OptArm,
  type OptCandidate,
  type OptLastSuggestion,
  type OptPolicy,
  type OptSuggestion,
} from './contract.js'

export function optStoreRoot(dshHome: string): string {
  return resolve(dshHome, OPT_STORE_DIR)
}

export function optPolicyPath(dshHome: string): string {
  return join(optStoreRoot(dshHome), OPT_POLICY_FILE)
}

export function compareDigest(result: CompareResult): string {
  return optSha256Hex(evalCanonical(result))
}

async function refuseSymlink(path: string, label: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined)
  if (stat?.isSymbolicLink()) {
    throw new Error(`${label} ${path} is a symlink; refusing to write through it`)
  }
}

export async function readPolicy(dshHome: string): Promise<OptPolicy> {
  const path = optPolicyPath(dshHome)
  try {
    return parseOptPolicy(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyPolicy()
    throw error
  }
}

export async function writePolicy(dshHome: string, policy: OptPolicy): Promise<void> {
  const path = optPolicyPath(dshHome)
  const root = optStoreRoot(dshHome)
  const rel = relative(root, path)
  if (rel.startsWith('..')) throw new Error(`opt policy ${path} escapes ${root}`)
  await mkdir(dirname(path), { recursive: true })
  await refuseSymlink(path, 'opt policy')
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o644, flag: 'wx' })
    await rename(temp, path)
    await chmod(path, 0o644)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

export interface CreditableCompare {
  result: CompareResult
  targets: string[]
}

export function creditCompares(
  policy: OptPolicy,
  compares: CreditableCompare[],
): { policy: OptPolicy; credited: number } {
  const last = policy.last
  const creditArm = Boolean(last && last.arm !== 'noop' && last.arm !== 'prepare_forge')
  const seen = new Set(policy.credited)
  let credited = 0
  const arms =
    creditArm && last
      ? { ...policy.arms, [last.arm]: { ...policy.arms[last.arm] } }
      : { ...policy.arms }
  for (const row of compares) {
    const digest = compareDigest(row.result)
    if (seen.has(digest)) continue
    seen.add(digest)
    if (!creditArm || !last || !compareMatchesLast(row.targets, last)) continue
    const outcome = creditOutcome(last.arm, row.result)
    if (outcome === 'win') arms[last.arm].wins += 1
    if (outcome === 'loss') arms[last.arm].losses += 1
    if (outcome !== 'skip') credited += 1
  }
  return { policy: { ...policy, arms, credited: [...seen] }, credited }
}

function compareMatchesLast(targets: string[], last: OptLastSuggestion): boolean {
  if (!last.target) return false
  const wanted = normalizeInterventionTarget(last.target)
  return targets.some((item) => {
    try {
      return normalizeInterventionTarget(item) === wanted
    } catch {
      return item === last.target
    }
  })
}

export function creditOutcome(arm: OptArm, result: CompareResult): 'win' | 'loss' | 'skip' {
  if (arm === 'prepare_promote' || arm === 'prepare_save') {
    if (result.mode === 'diff') return result.regress ? 'loss' : 'win'
    if (result.mode === 'ablate') return result.faithful ? 'win' : 'loss'
  }
  if (arm === 'prepare_unload') {
    if (result.mode === 'ablate') return result.ignored ? 'win' : 'loss'
  }
  return 'skip'
}

const EXPLORE = 1000
const PRIORITY: Record<OptArm, number> = {
  prepare_promote: 4,
  prepare_save: 3,
  prepare_unload: 2,
  prepare_forge: 1,
  noop: 0,
}

export function armScore(arm: OptArm, policy: OptPolicy): number {
  const stats = policy.arms[arm]
  const n = stats.wins + stats.losses
  const total = OPT_ARMS.reduce(
    (sum, name) => sum + policy.arms[name].wins + policy.arms[name].losses,
    0,
  )
  if (n === 0) return EXPLORE + PRIORITY[arm]
  const mean = (stats.wins + 1) / (n + 2)
  return mean + Math.sqrt((2 * Math.log(Math.max(total, 1))) / n)
}

export function pickSuggestion(policy: OptPolicy, candidates: OptCandidate[]): OptSuggestion {
  const legal: OptCandidate[] = [...candidates, { arm: 'noop' }]
  let best = legal[0]!
  let bestScore = armScore(best.arm, policy)
  for (const candidate of legal.slice(1)) {
    const score = armScore(candidate.arm, policy)
    if (!isBetterCandidate(candidate, score, best, bestScore)) continue
    best = candidate
    bestScore = score
  }
  return {
    arm: best.arm,
    ...(best.target ? { target: best.target } : {}),
    ...(best.query ? { query: best.query } : {}),
    ...(best.scope ? { scope: best.scope } : {}),
    next: [],
  }
}

function isBetterCandidate(
  candidate: OptCandidate,
  score: number,
  best: OptCandidate,
  bestScore: number,
): boolean {
  if (score > bestScore) return true
  if (score < bestScore) return false
  if (PRIORITY[candidate.arm] > PRIORITY[best.arm]) return true
  if (PRIORITY[candidate.arm] < PRIORITY[best.arm]) return false
  const usage = candidate.usage ?? 0
  const bestUsage = best.usage ?? 0
  if (usage > bestUsage) return true
  if (usage < bestUsage) return false
  return (
    (candidate.target ?? candidate.query ?? '').localeCompare(best.target ?? best.query ?? '') < 0
  )
}

export function withLastSuggestion(policy: OptPolicy, suggestion: OptSuggestion): OptPolicy {
  const last: OptLastSuggestion = {
    arm: suggestion.arm,
    at: new Date().toISOString(),
  }
  if (suggestion.target) last.target = suggestion.target
  if (suggestion.query) last.query = suggestion.query
  return { ...policy, last }
}
