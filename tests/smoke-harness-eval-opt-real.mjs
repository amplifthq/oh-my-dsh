// Real-harness smoke for eval_control and opt_control.
//
// Unlike tests/harness-eval.test.mjs and tests/harness-opt.test.mjs (mocked
// tools/commands), this boots the real ToolRuntime / CommandRuntime /
// SystemPrompt and the dist-built overlays. Every call goes through
// ctx.tools.execute().
//
// Run: pnpm build && node tests/smoke-harness-eval-opt-real.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

import CapabilityDiscoveryRuntime from '../dist/packages/capability-discovery/src/index.js'
import HarnessEvalRuntime from '../dist/packages/harness-eval/src/index.js'
import HarnessOptRuntime from '../dist/packages/harness-opt/src/index.js'
import PluginControlRuntime from '../dist/packages/plugin-control/src/index.js'
import PluginForgeRuntime from '../dist/packages/plugin-forge/src/index.js'
import ProposalRuntime from '../dist/packages/proposals/src/index.js'

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
}

const dshHome = mkdtempSync(join(tmpdir(), 'omd-eval-opt-smoke-home-'))
const workspace = mkdtempSync(join(tmpdir(), 'omd-eval-opt-smoke-ws-'))
process.env.DSH_HOME = dshHome

const catalogPath = new URL('../presets/plugins.json', import.meta.url)
const catalogBefore = readFileSync(catalogPath)

const skillDir = join(dshHome, 'skills', 'smoke-skill')
mkdirSync(skillDir, { recursive: true })
writeFileSync(
  join(skillDir, 'SKILL.md'),
  '---\nname: smoke-skill\ndescription: Disposable skill for the eval/opt smoke.\n---\n\nDo nothing.\n',
)

const ctx = new Context()
ctx.provide('approval', {
  request: async (request) => {
    throw new Error(`unexpected approval request for ${request.toolName}`)
  },
})
ctx.provide('skills', {
  snapshot: async () => ({
    complete: true,
    skills: [
      {
        name: 'smoke-skill',
        description: 'Disposable skill for the eval/opt smoke.',
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'user',
        source: 'user',
      },
    ],
  }),
})
ctx.provide('mcpControl', { list: () => [] })

await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(CommandRuntime)
await ctx.plugin(ProposalRuntime)
await ctx.plugin(PluginControlRuntime)
await ctx.plugin(PluginForgeRuntime)
await ctx.plugin(HarnessEvalRuntime)
await ctx.plugin(HarnessOptRuntime)
await ctx.plugin(CapabilityDiscoveryRuntime)

const agent = {
  id: 'eval-opt-smoke-agent',
  ctx,
  session: {
    header: { cwd: workspace },
    append() {},
  },
}

let sequence = 0
async function callTool(name, args) {
  const result = await ctx.tools.execute({
    name,
    arguments: args,
    agent,
    callId: `eval-opt-smoke-${++sequence}`,
    signal: new AbortController().signal,
  })
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  return { result, text, isError: result.isError === true }
}

function parseOk(text) {
  return JSON.parse(text)
}

console.log('=== [1/4] Real registry exposes eval_control, opt_control, and discovery ===')
{
  const names = ctx.tools.schemas(agent).map((schema) => schema.name)
  record(
    'Real registry exposes eval_control, opt_control, and capability_search',
    names.includes('eval_control') &&
      names.includes('opt_control') &&
      names.includes('capability_search'),
    names.join(', '),
  )
  const commands = ctx.commands.list(agent).map((command) => command.name)
  record(
    'Real command runtime registers /omd-eval and /omd-opt',
    commands.includes('omd-eval') && commands.includes('omd-opt'),
    commands.join(', '),
  )
}

console.log(
  '=== [2/4] eval_control snapshot → run → ablate → compare through the real pipeline ===',
)
let snapshotDigest
{
  const missing = await callTool('eval_control', { action: 'run', task_id: 'snapshot-stable' })
  record(
    'run without snapshot_digest is rejected by the real pipeline',
    missing.isError && /snapshot_digest/.test(missing.text),
    missing.text.slice(0, 160),
  )

  const shown = await callTool('eval_control', { action: 'show' })
  const listed = shown.isError ? undefined : parseOk(shown.text)
  record(
    'show lists bundled tasks including snapshot-stable',
    !shown.isError &&
      listed.action === 'show' &&
      listed.data.tasks.some((task) => task.id === 'snapshot-stable') &&
      !Object.hasOwn(listed.data, 'summary'),
    shown.isError ? shown.text.slice(0, 160) : `${listed.data.tasks.length} tasks`,
  )

  const captured = await callTool('eval_control', { action: 'snapshot' })
  const snap = captured.isError ? undefined : parseOk(captured.text)
  snapshotDigest = snap?.data?.snapshot_digest
  record(
    'snapshot writes a digest through the real pipeline',
    !captured.isError && typeof snapshotDigest === 'string' && snapshotDigest.length === 64,
    captured.isError ? captured.text.slice(0, 160) : snapshotDigest,
  )

  const intact = await callTool('eval_control', {
    action: 'run',
    task_id: 'snapshot-stable',
    snapshot_digest: snapshotDigest,
  })
  const intactData = intact.isError ? undefined : parseOk(intact.text)
  record(
    'run snapshot-stable passes on the captured snapshot',
    !intact.isError && intactData.data.pass === true && intactData.data.run_id,
    intact.isError ? intact.text.slice(0, 200) : intactData.data.run_id,
  )

  const catalogRun = await callTool('eval_control', {
    action: 'run',
    task_id: 'catalog-untouched',
    snapshot_digest: snapshotDigest,
  })
  const catalogData = catalogRun.isError ? undefined : parseOk(catalogRun.text)
  record(
    'run catalog-untouched passes and does not write presets/plugins.json',
    !catalogRun.isError && catalogData.data.pass === true,
    catalogRun.isError ? catalogRun.text.slice(0, 200) : 'catalog hashed',
  )

  const ablated = await callTool('eval_control', {
    action: 'run',
    task_id: 'snapshot-stable',
    snapshot_digest: snapshotDigest,
    target: 'skill:smoke-skill',
  })
  const ablatedData = ablated.isError ? undefined : parseOk(ablated.text)
  record(
    'run with ablate intervention completes through the real pipeline',
    !ablated.isError && ablatedData.data.intervention?.op === 'ablate',
    ablated.isError ? ablated.text.slice(0, 200) : JSON.stringify(ablatedData.data.intervention),
  )

  const compared = await callTool('eval_control', {
    action: 'compare',
    mode: 'ablate',
    task_id: 'snapshot-stable',
    snapshot_digest: snapshotDigest,
    target: 'skill:smoke-skill',
  })
  const compareData = compared.isError ? undefined : parseOk(compared.text)
  record(
    'compare mode=ablate persists a machine result with no narrative summary',
    !compared.isError &&
      compareData.action === 'compare' &&
      typeof compareData.data.faithful === 'boolean' &&
      !Object.hasOwn(compareData.data, 'summary'),
    compared.isError
      ? compared.text.slice(0, 200)
      : `faithful=${compareData.data.faithful} ignored=${compareData.data.ignored}`,
  )

  const grepped = await callTool('eval_control', {
    action: 'show',
    query: 'digest-stable',
    in: 'assertions',
  })
  const grepData = grepped.isError ? undefined : parseOk(grepped.text)
  record(
    'show query reads assertion files from $DSH_HOME/omd/eval',
    !grepped.isError && Array.isArray(grepData.data.hits) && grepData.data.hits.length > 0,
    grepped.isError ? grepped.text.slice(0, 160) : `${grepData.data.hits.length} hits`,
  )
}

console.log('=== [3/4] opt_control suggest/show through the real pipeline ===')
{
  const forbidden = await callTool('opt_control', { action: 'apply' })
  record(
    'opt_control apply is rejected by the real pipeline',
    forbidden.isError && /must be one of|cannot apply/.test(forbidden.text),
    forbidden.text.slice(0, 160),
  )

  const suggested = await callTool('opt_control', { action: 'suggest' })
  const suggestion = suggested.isError ? undefined : parseOk(suggested.text)
  record(
    'suggest returns a locked arm and never a summary',
    !suggested.isError &&
      ['prepare_promote', 'prepare_forge', 'prepare_unload', 'prepare_save', 'noop'].includes(
        suggestion.data.arm,
      ) &&
      !Object.hasOwn(suggestion.data, 'summary') &&
      Array.isArray(suggestion.next),
    suggested.isError ? suggested.text.slice(0, 200) : suggestion.data.arm,
  )

  const shown = await callTool('opt_control', { action: 'show' })
  const policy = shown.isError ? undefined : parseOk(shown.text)
  record(
    'show reads the durable policy file',
    !shown.isError &&
      policy.data.policy.version === 1 &&
      existsSync(join(dshHome, 'omd', 'opt', 'policy.json')),
    shown.isError ? shown.text.slice(0, 160) : join(dshHome, 'omd', 'opt', 'policy.json'),
  )
}

console.log('=== [4/4] Discovery finds the new tools; catalog bytes stay identical ===')
{
  const search = await callTool('capability_search', {
    action: 'search',
    query: 'eval_control opt_control machine assertions durable policy',
    kinds: 'tool',
    limit: 20,
  })
  const hits = search.isError ? [] : parseOk(search.text).hits
  record(
    'capability_search finds tool:eval_control and tool:opt_control',
    !search.isError &&
      hits.some((hit) => hit.ref === 'tool:eval_control') &&
      hits.some((hit) => hit.ref === 'tool:opt_control'),
    search.isError ? search.text.slice(0, 200) : hits.map((hit) => hit.ref).join(', '),
  )

  const catalogAfter = readFileSync(catalogPath)
  record(
    'presets/plugins.json is byte-identical after the real eval/opt session',
    Buffer.compare(catalogBefore, catalogAfter) === 0,
  )
}

rmSync(dshHome, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('Failed checks:')
  for (const entry of failed) console.log(`  ✗ ${entry.name}`)
  process.exit(1)
}
process.exit(0)
