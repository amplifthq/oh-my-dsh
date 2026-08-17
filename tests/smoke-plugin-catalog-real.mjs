// Real-harness smoke for the curated plugin catalog.
//
// Run: pnpm build && node tests/smoke-plugin-catalog-real.mjs

import { Context } from '@deepseek-ai/cordis'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

import PluginControlRuntime from '../dist/packages/plugin-control/src/index.js'
import ProposalRuntime from '../dist/packages/proposals/src/index.js'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
}

const approvals = []
const approvalScript = []
const ctx = new Context()
ctx.provide('approval', {
  request: async (request) => {
    approvals.push(request)
    if (approvalScript.length === 0) {
      throw new Error(`unexpected approval request for ${request.toolName}`)
    }
    return approvalScript.shift()
  },
})

await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(CommandRuntime)
await ctx.plugin(ProposalRuntime)
await ctx.plugin(PluginControlRuntime)

const agent = {
  id: 'catalog-smoke-agent',
  ctx,
  session: {
    header: { id: 'catalog-smoke-session', cwd: process.cwd() },
    events: [],
    append() {},
  },
}

let sequence = 0
async function callTool(name, args) {
  const result = await ctx.tools.execute({
    name,
    arguments: args,
    agent,
    callId: `catalog-smoke-${++sequence}`,
    signal: new AbortController().signal,
  })
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  return { result, text, isError: result.isError === true }
}

const toolNames = () => ctx.tools.schemas(agent).map((schema) => schema.name)

console.log('=== [1/3] Discovery stays inert and exposes reviewed provenance ===')
{
  const { text, isError } = await callTool('plugin_control', { action: 'list' })
  const catalog = isError ? undefined : JSON.parse(text).plugins
  const pkgInfo = catalog?.find((plugin) => plugin.id === 'dsh-pkg-info')
  record(
    'Catalog lists the upstream seed and admitted community plugin',
    !isError &&
      catalog.length === 2 &&
      catalog.some((plugin) => plugin.id === 'dsh-skill-badge') &&
      pkgInfo !== undefined,
    isError ? text : catalog.map((plugin) => plugin.id).join(', '),
  )
  record(
    'Community entry is exact-pinned, available, inactive, and source-linked',
    pkgInfo?.version === '0.1.1' &&
      pkgInfo?.availability?.status === 'available' &&
      pkgInfo?.active === false &&
      pkgInfo?.source === 'community' &&
      pkgInfo?.provenance?.commit === 'd0f339f486148ae15948a7b4b9d5a144dd513238',
    pkgInfo ? `${pkgInfo.module}@${pkgInfo.version}` : 'entry missing',
  )
  record(
    'Discovery imported no community code and registered no pkg_info tool',
    !toolNames().includes('pkg_info') && approvals.length === 0,
  )
}

console.log('=== [2/3] Prepare → reject → approve → invoke ===')
let proposalId
{
  const { text, isError } = await callTool('plugin_control', {
    action: 'prepare_load',
    plugin_id: 'dsh-pkg-info',
  })
  const proposal = isError ? undefined : JSON.parse(text).proposal
  proposalId = proposal?.id
  const detail = proposal?.effects?.[0]?.details
  record(
    'Prepare stages exact artifact, risk, manifest, and provenance without approval',
    !isError &&
      detail.module === 'dsh-pkg-info' &&
      detail.version === '0.1.1' &&
      detail.provenance.integrity.startsWith('sha512-') &&
      detail.risk.includes('npm or PyPI') &&
      approvals.length === 0,
    isError ? text : proposalId,
  )
}

{
  approvalScript.push('rejected')
  const rejected = await callTool('proposal_control', {
    action: 'apply',
    proposal_id: proposalId,
  })
  record(
    'Real approval gate blocks a rejected load and keeps code inert',
    rejected.isError && /rejected/.test(rejected.text) && !toolNames().includes('pkg_info'),
    rejected.text,
  )
}

{
  approvalScript.push('allowed-once')
  const applied = await callTool('proposal_control', {
    action: 'apply',
    proposal_id: proposalId,
  })
  const value = applied.isError ? undefined : JSON.parse(applied.text)
  record(
    'Approved apply mounts the exact package through Cordis',
    !applied.isError &&
      /Cordis state ACTIVE/.test(value.result.summary) &&
      toolNames().includes('pkg_info'),
    applied.isError ? applied.text : value.result.summary,
  )
  const ask = approvals.at(-1)
  record(
    'Approval reason includes community source and npm integrity evidence',
    ask?.reason?.includes('"source": "community"') &&
      ask?.reason?.includes('"integrity": "sha512-'),
    ask ? `reason length=${ask.reason.length}` : 'no ask captured',
  )
}

{
  const invoked = await callTool('pkg_info', {
    registry: 'npm',
    name: 'dsh-pkg-info',
    version: '0.1.1',
  })
  record(
    'Mounted tool performs a live npm registry query',
    !invoked.isError &&
      invoked.result.value?.ok === true &&
      invoked.result.value?.name === 'dsh-pkg-info' &&
      invoked.result.value?.version === '0.1.1',
    invoked.isError ? invoked.text : `${invoked.result.value.name}@${invoked.result.value.version}`,
  )
}

console.log('=== [3/3] Approved unload reverses the real registry effect ===')
{
  const prepared = await callTool('plugin_control', {
    action: 'prepare_unload',
    plugin_id: 'dsh-pkg-info',
  })
  const unloadId = JSON.parse(prepared.text).proposal.id
  approvalScript.push('allowed-once')
  const unloaded = await callTool('proposal_control', {
    action: 'apply',
    proposal_id: unloadId,
  })
  record(
    'Unload removes pkg_info from real function-calling schemas',
    !unloaded.isError && !toolNames().includes('pkg_info'),
    unloaded.isError ? unloaded.text : 'pkg_info is no longer visible',
  )
  const listed = JSON.parse((await callTool('plugin_control', { action: 'list' })).text).plugins
  record(
    'Catalog remains available and reports the plugin inactive after unload',
    listed.find((plugin) => plugin.id === 'dsh-pkg-info')?.active === false,
  )
}

await ctx.root.fiber.dispose()

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
