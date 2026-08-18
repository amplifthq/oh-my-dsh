import {
  distillJustified,
  normalizeInterventionTarget,
  promotionAllowed,
  type CompareResult,
} from './contract.js'
import { bundledSuiteDigest, listCompares, readRun, readSnapshot, type EvalRoots } from './store.js'

export interface PromotionGate {
  diff: CompareResult
  ablate: CompareResult
}

function compositionHas(
  snapshot: { composition: { skills: { ref: string }[]; plugins: { ref: string }[] } },
  assetRef: string,
): boolean {
  const wanted = normalizeInterventionTarget(assetRef)
  return [...snapshot.composition.skills, ...snapshot.composition.plugins].some(
    (item) => normalizeInterventionTarget(item.ref) === wanted,
  )
}

export async function findNonRegressingDiff(
  roots: EvalRoots,
  assetRef: string,
): Promise<CompareResult | undefined> {
  const suite = await bundledSuiteDigest(roots)
  const wanted = normalizeInterventionTarget(assetRef)
  for (const result of [...(await listCompares(roots))].reverse()) {
    if (!promotionAllowed(result)) continue
    const candidate = await readRun(roots, result.candidate_run)
    if (!candidate || candidate.score.suite_digest !== suite) continue
    const snapshot = await readSnapshot(roots, candidate.score.snapshot_digest)
    if (!snapshot) continue
    if (compositionHas(snapshot, wanted)) return result
  }
  return undefined
}

export async function findIgnoredAblate(
  roots: EvalRoots,
  assetRef: string,
): Promise<CompareResult | undefined> {
  const suite = await bundledSuiteDigest(roots)
  const wanted = normalizeInterventionTarget(assetRef)
  for (const result of [...(await listCompares(roots))].reverse()) {
    if (result.mode !== 'ablate' || result.ignored !== true) continue
    const candidate = await readRun(roots, result.candidate_run)
    const baseline = await readRun(roots, result.baseline_run)
    if (!candidate || !baseline) continue
    if (candidate.score.suite_digest !== suite || baseline.score.suite_digest !== suite) continue
    if (candidate.score.intervention?.target !== wanted) continue
    const snapshot = await readSnapshot(roots, baseline.score.snapshot_digest)
    if (!snapshot || !compositionHas(snapshot, wanted)) continue
    return result
  }
  return undefined
}

export async function findFaithfulAblate(
  roots: EvalRoots,
  assetRef: string,
): Promise<CompareResult | undefined> {
  const suite = await bundledSuiteDigest(roots)
  const wanted = normalizeInterventionTarget(assetRef)
  for (const result of [...(await listCompares(roots))].reverse()) {
    if (!distillJustified(result)) continue
    const candidate = await readRun(roots, result.candidate_run)
    const baseline = await readRun(roots, result.baseline_run)
    if (!candidate || !baseline) continue
    if (candidate.score.suite_digest !== suite || baseline.score.suite_digest !== suite) continue
    if (candidate.score.intervention?.target !== wanted) continue
    const snapshot = await readSnapshot(roots, baseline.score.snapshot_digest)
    if (!snapshot || !compositionHas(snapshot, wanted)) continue
    return result
  }
  return undefined
}

export async function assertPromotionAllowed(
  roots: EvalRoots,
  pluginRef: string,
): Promise<PromotionGate> {
  const diff = await findNonRegressingDiff(roots, pluginRef)
  if (!diff) {
    throw new Error(
      'plugin_forge prepare_promote requires an eval_control compare mode=diff that does not regress. ' +
        'Call eval_control snapshot, run, compare first.',
    )
  }
  const ablate = await findFaithfulAblate(roots, pluginRef)
  if (!ablate) {
    throw new Error(
      'plugin_forge prepare_promote requires an eval_control compare mode=ablate that is faithful ' +
        '(ablating the plugin must change assertions). Call eval_control run with the intervention, then compare.',
    )
  }
  return { diff, ablate }
}

export async function assertDistillJustified(
  roots: EvalRoots,
  skillRef: string,
): Promise<CompareResult> {
  const ablate = await findFaithfulAblate(roots, skillRef)
  if (!ablate) {
    throw new Error(
      'skill_control prepare_save requires an eval_control compare mode=ablate that shows this skill was causally used. ' +
        'Call eval_control snapshot, run, compare first.',
    )
  }
  return ablate
}
