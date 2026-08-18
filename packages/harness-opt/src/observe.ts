import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { capabilityRef } from '../../capability-discovery/src/catalog.js'
import {
  findFaithfulAblate,
  findIgnoredAblate,
  findNonRegressingDiff,
} from '../../harness-eval/src/gate.js'
import {
  listCompares,
  readRun,
  readSnapshot,
  type EvalRoots,
} from '../../harness-eval/src/store.js'
import { readCapabilityGaps, summarizeUsage } from '../../plugin-forge/src/journal.js'
import {
  listForgedPlugins,
  resolveForgedPluginTarget,
  type ForgeRoots,
} from '../../plugin-forge/src/store.js'
import { SLUG_PATTERN } from '../../skill-forge/src/document.js'
import type { OptCandidate } from './contract.js'
import type { CreditableCompare } from './policy.js'

export interface OptObserveRoots {
  dshHome: string
  workspace?: string
  bundledTasks: string
  activeSlugs?: ReadonlySet<string>
}

const TOKEN = /[a-z0-9]{3,}/g

export function queryTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(TOKEN) ?? [])
}

export function gapCoveredBySlug(query: string, slug: string): boolean {
  const querySet = queryTokens(query)
  if (querySet.size === 0) return false
  for (const token of queryTokens(slug.replace(/-/g, ' '))) {
    if (querySet.has(token)) return true
  }
  return false
}

export async function listCreditableCompares(roots: EvalRoots): Promise<CreditableCompare[]> {
  const rows: CreditableCompare[] = []
  for (const result of await listCompares(roots)) {
    const targets = new Set<string>()
    const candidate = await readRun(roots, result.candidate_run)
    const baseline = await readRun(roots, result.baseline_run)
    if (candidate?.score.intervention?.target) targets.add(candidate.score.intervention.target)
    if (baseline?.score.intervention?.target) targets.add(baseline.score.intervention.target)
    for (const snapshot of [
      candidate ? await readSnapshot(roots, candidate.score.snapshot_digest) : undefined,
      baseline ? await readSnapshot(roots, baseline.score.snapshot_digest) : undefined,
    ]) {
      if (!snapshot) continue
      for (const item of [...snapshot.composition.skills, ...snapshot.composition.plugins]) {
        targets.add(item.ref)
      }
    }
    rows.push({ result, targets: [...targets] })
  }
  return rows
}

export async function observeLegalCandidates(roots: OptObserveRoots): Promise<OptCandidate[]> {
  const evalRoots: EvalRoots = {
    dshHome: roots.dshHome,
    workspace: roots.workspace,
    bundledTasks: roots.bundledTasks,
  }
  const forgeRoots: ForgeRoots = { dshHome: roots.dshHome, workspace: roots.workspace }
  const active = roots.activeSlugs ?? new Set<string>()
  const candidates: OptCandidate[] = []
  const forged = await listForgedPlugins(forgeRoots)
  const slugs: string[] = []

  for (const summary of forged) {
    if (summary.status !== 'ok') continue
    slugs.push(summary.slug)
    const target = resolveForgedPluginTarget(summary.scope, summary.slug, forgeRoots)
    const ref = capabilityRef('plugin', `forged/${summary.scope}/${summary.slug}`)
    const usage = await summarizeUsage(target, summary.slug, summary.scope).catch(() => ({
      totalInvocations: 0,
    }))
    const [diff, faithful, ignored] = await Promise.all([
      findNonRegressingDiff(evalRoots, ref),
      findFaithfulAblate(evalRoots, ref),
      findIgnoredAblate(evalRoots, ref),
    ])
    if (diff && faithful) {
      candidates.push({
        arm: 'prepare_promote',
        target: ref,
        scope: summary.scope,
        usage: usage.totalInvocations,
      })
    }
    if (ignored && active.has(summary.slug)) {
      candidates.push({
        arm: 'prepare_unload',
        target: ref,
        scope: summary.scope,
        usage: usage.totalInvocations,
      })
    }
  }

  const gap = latestUncoveredGap(await readCapabilityGaps(roots.dshHome), slugs)
  if (gap) {
    candidates.push({ arm: 'prepare_forge', query: gap.query })
  }

  for (const skill of await listOnDiskSkills(roots)) {
    if (!(await findFaithfulAblate(evalRoots, skill.ref))) continue
    candidates.push({
      arm: 'prepare_save',
      target: skill.ref,
      scope: skill.scope,
    })
  }

  return candidates
}

function latestUncoveredGap(
  gaps: { at: string; query: string; authoritative: boolean; redacted: boolean }[],
  slugs: readonly string[],
) {
  const authoritative = gaps
    .filter((gap) => gap.authoritative && !gap.redacted && !gap.query.startsWith('[redacted'))
    .sort((left, right) => left.at.localeCompare(right.at))
  for (let index = authoritative.length - 1; index >= 0; index -= 1) {
    const gap = authoritative[index]!
    if (slugs.some((slug) => gapCoveredBySlug(gap.query, slug))) continue
    return gap
  }
  return undefined
}

async function listOnDiskSkills(
  roots: OptObserveRoots,
): Promise<{ scope: 'user' | 'project'; slug: string; ref: string }[]> {
  const found: { scope: 'user' | 'project'; slug: string; ref: string }[] = []
  const scopes: { scope: 'user' | 'project'; root?: string }[] = [
    { scope: 'user', root: resolve(roots.dshHome, 'skills') },
    ...(roots.workspace
      ? [{ scope: 'project' as const, root: resolve(roots.workspace, '.dsh', 'skills') }]
      : []),
  ]
  for (const { scope, root } of scopes) {
    if (!root) continue
    const entries = await readdir(root).catch((): string[] => [])
    for (const slug of entries.sort()) {
      if (!SLUG_PATTERN.test(slug)) continue
      const files = await readdir(join(root, slug)).catch((): string[] => [])
      if (!files.includes('SKILL.md')) continue
      found.push({ scope, slug, ref: capabilityRef('skill', slug) })
    }
  }
  return found
}
