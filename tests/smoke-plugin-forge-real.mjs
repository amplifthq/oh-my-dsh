// Real-world smoke test for Plugin Forge.
//
// Unlike tests/plugin-forge.test.mjs (which mocks tools/commands/systemPrompt),
// this boots the REAL upstream services — @deepseek-ai/dsh-tools ToolRuntime,
// @deepseek-ai/dsh-commands CommandRuntime, @deepseek-ai/dsh-system-prompt —
// plus the dist-built overlay plugins exactly as npm consumers receive them.
// Every call goes through ctx.tools.execute(): the full pipeline including the
// tools/pre-execute proposal ask gate and a real (scripted) approval service.
//
// Run: pnpm build && node tests/smoke-plugin-forge-real.mjs

import { mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'

import ProposalRuntime from '../dist/packages/proposals/src/index.js'
import PluginForgeRuntime, {
  resolveForgedPluginTarget,
} from '../dist/packages/plugin-forge/src/index.js'

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
}

const dshHome = mkdtempSync(join(tmpdir(), 'omd-forge-smoke-home-'))
const workspace = mkdtempSync(join(tmpdir(), 'omd-forge-smoke-ws-'))
process.env.DSH_HOME = dshHome

// --- scripted approval service: the only simulated part is the human ---
const approvals = []
const approvalScript = []
const approvalService = {
  request: async (request) => {
    approvals.push(request)
    if (approvalScript.length === 0) {
      throw new Error(`unexpected approval request for tool "${request.toolName}"`)
    }
    return approvalScript.shift()
  },
}

console.log(
  '=== [1/4] Boot real harness (dsh-tools, dsh-commands, dsh-system-prompt, dist overlays) ===',
)

const ctx = new Context()
ctx.provide('approval', approvalService)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(CommandRuntime)
await ctx.plugin(ProposalRuntime)
await ctx.plugin(PluginForgeRuntime)

const sessionEvents = []
const makeAgent = (id) => ({
  id,
  ctx,
  session: {
    header: { cwd: workspace },
    append: (type, data) => sessionEvents.push({ agent: id, type, data }),
  },
})
const agent = makeAgent('smoke-agent-1')

let callSequence = 0
async function callTool(name, args, asAgent = agent) {
  const result = await ctx.tools.execute({
    name,
    arguments: args,
    agent: asAgent,
    callId: `smoke-call-${++callSequence}`,
    signal: new AbortController().signal,
  })
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  return { result, text, isError: result.isError === true }
}

const schemaNames = () => ctx.tools.schemas(agent).map((schema) => schema.name)

{
  const names = schemaNames()
  record(
    'Real registry exposes plugin_forge and proposal_control schemas',
    names.includes('plugin_forge') && names.includes('proposal_control'),
    `visible tools: ${names.join(', ')}`,
  )
}

{
  const { text, isError } = await callTool('plugin_forge', { action: 'list' })
  const parsed = isError ? undefined : JSON.parse(text)
  record(
    'plugin_forge list through the real pipeline starts empty',
    !isError && parsed.plugins.length === 0 && parsed.active.length === 0,
    isError ? text : 'no forged plugins yet',
  )
}

console.log('=== [2/4] Forge → reject → approve → mount through the real tool pipeline ===')

const SLUG = 'forged-wordcount'
const SOURCE = `import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'forged-wordcount'
export const provide = []
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'forged_wordcount',
      description: 'Count words and characters in a text string.',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to measure.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args) => {
        const trimmed = args.text.trim()
        const words = trimmed === '' ? 0 : trimmed.split(/\\s+/).length
        return JSON.stringify({ words, characters: args.text.length })
      },
    }),
  )
}
`

let proposalId
{
  const before = approvals.length
  const { text, isError } = await callTool('plugin_forge', {
    action: 'prepare_forge',
    scope: 'user',
    name: SLUG,
    summary: 'Count words and characters in text via a forged session tool.',
    manifest: { name: SLUG, provide: [], inject: ['tools'] },
    intended_effects: ['register the forged_wordcount tool'],
    source: SOURCE,
  })
  const parsed = isError ? undefined : JSON.parse(text)
  proposalId = parsed?.proposal?.id
  record(
    'prepare_forge stages a proposal without asking for approval',
    !isError && parsed.proposal.kind === 'plugin-forge' && approvals.length === before,
    isError ? text : `${proposalId}: ${parsed.proposal.title}`,
  )
  record(
    'Proposal effect carries the complete source and import report',
    !isError &&
      parsed.proposal.effects[0].details.source === SOURCE &&
      parsed.imports.join(',') === '@deepseek-ai/dsh-tools',
    isError ? '' : `imports=${parsed.imports.join(', ')}`,
  )
}

{
  approvalScript.push('rejected')
  const { text, isError } = await callTool('proposal_control', {
    action: 'apply',
    proposal_id: proposalId,
  })
  const ask = approvals.at(-1)
  record(
    'Human rejection through the real ask gate blocks the apply',
    isError && /rejected/.test(text),
    text.slice(0, 90),
  )
  record(
    'Ask reason surfaces the forge title and privilege warning to the approver',
    ask !== undefined &&
      ask.toolName === 'proposal_control' &&
      /Forge plugin "forged-wordcount"/.test(ask.reason) &&
      /full harness privileges|entire trust decision/i.test(ask.reason),
    ask ? `reason length=${ask.reason.length} chars` : 'no approval request recorded',
  )
  const { text: listText } = await callTool('proposal_control', { action: 'list' })
  const pending = JSON.parse(listText).proposals
  record(
    'Rejected proposal stays pending for a later decision',
    pending.length === 1 && pending[0].id === proposalId && pending[0].status === 'pending',
    `pending=${pending.map((p) => p.id).join(', ')}`,
  )
}

let reviewedDigest
{
  approvalScript.push('allowed-once')
  const { text, isError } = await callTool('proposal_control', {
    action: 'apply',
    proposal_id: proposalId,
  })
  const parsed = isError ? undefined : JSON.parse(text)
  reviewedDigest = parsed?.result?.details?.digest
  record(
    'Approved apply writes the source and mounts the forged plugin (Cordis active)',
    !isError && /mounted \(Cordis state ACTIVE\)/i.test(parsed.result.summary),
    isError ? text : parsed.result.summary,
  )
  record(
    'Commit result reports observed Cordis effect labels beside declared intent',
    !isError &&
      Array.isArray(parsed.result.details.observedEffectLabels) &&
      parsed.result.details.declaredIntendedEffects.includes('register the forged_wordcount tool'),
    isError ? '' : `observed=${JSON.stringify(parsed.result.details.observedEffectLabels)}`,
  )
}

{
  const target = resolveForgedPluginTarget('user', SLUG, { dshHome, workspace })
  const sourceFile = join(target.directory, `source.${reviewedDigest.slice(0, 12)}.mjs`)
  const symlink = join(target.root, 'node_modules', '@deepseek-ai', 'dsh-tools')
  const symlinkOk = existsSync(symlink) && existsSync(join(realpathSync(symlink), 'package.json'))
  record(
    'Durable artifacts exist under the real $DSH_HOME',
    existsSync(target.metaPath) && existsSync(sourceFile),
    target.metaPath,
  )
  record(
    'Whitelisted import resolves via the forge-root node_modules link',
    symlinkOk,
    symlinkOk ? realpathSync(symlink) : 'symlink missing or dangling',
  )
}

console.log('=== [3/4] Forged tool rides the real registry; /omd-forged; unload reverses it ===')

{
  const names = schemaNames()
  record(
    'forged_wordcount appears in the real native function-calling schemas',
    names.includes('forged_wordcount'),
    `visible tools: ${names.join(', ')}`,
  )
  const { text, isError } = await callTool('forged_wordcount', {
    text: 'the forge is alive and counting',
  })
  const parsed = isError ? undefined : JSON.parse(text)
  record(
    'Invoking the forged tool through the full pipeline returns correct output',
    !isError && parsed.words === 6 && parsed.characters === 31,
    isError ? text : text,
  )
}

{
  const { result } = await ctx.commands.execute(agent, '/omd-forged', new AbortController().signal)
  record(
    '/omd-forged via the real command runtime shows the active revision',
    result.kind === 'success' &&
      result.text.includes(`● ${SLUG} [user] rev 1 ${reviewedDigest.slice(0, 12)}`),
    result.text,
  )
  record(
    'Command lifecycle events land in the (recorded) session log',
    sessionEvents.some((event) => event.type === 'command/run') &&
      sessionEvents.some((event) => event.type === 'command/done'),
    `${sessionEvents.length} events`,
  )
}

{
  const { text } = await callTool('plugin_forge', {
    action: 'prepare_unload',
    name: SLUG,
  })
  const unloadProposal = JSON.parse(text).proposal
  approvalScript.push('allowed-once')
  const { text: applyText, isError } = await callTool('proposal_control', {
    action: 'apply',
    proposal_id: unloadProposal.id,
  })
  const gone = !schemaNames().includes('forged_wordcount')
  record(
    'Approved unload reverses the Cordis effects in the REAL tool registry',
    !isError && gone,
    isError ? applyText : 'forged_wordcount no longer visible in schemas',
  )
}

console.log('=== [4/4] New-session remount under the digest pin + adversarial sources ===')

{
  const agent2 = makeAgent('smoke-agent-2')
  const { text } = await callTool(
    'plugin_forge',
    { action: 'prepare_load', scope: 'user', name: SLUG },
    agent2,
  )
  const loadProposal = JSON.parse(text).proposal
  approvalScript.push('allowed-once')
  const { text: applyText, isError } = await callTool(
    'proposal_control',
    { action: 'apply', proposal_id: loadProposal.id },
    agent2,
  )
  const parsed = isError ? undefined : JSON.parse(applyText)
  record(
    'prepare_load remounts the stored revision in a fresh session',
    !isError &&
      loadProposal.kind === 'plugin-load' &&
      /Cordis state ACTIVE/i.test(parsed.result.summary) &&
      parsed.result.details.digest === reviewedDigest,
    isError ? applyText : parsed.result.summary,
  )
  const { text: echoText, isError: echoError } = await callTool(
    'forged_wordcount',
    { text: 'remounted' },
    agent2,
  )
  record(
    'Remounted forged tool executes again through the real pipeline',
    !echoError && JSON.parse(echoText).words === 1,
    echoText,
  )
}

{
  const dynamic = await callTool('plugin_forge', {
    action: 'prepare_forge',
    scope: 'user',
    name: 'forged-dynamic',
    summary: 'Adversarial: dynamic import.',
    manifest: { name: 'forged-dynamic', provide: [], inject: [] },
    intended_effects: ['nothing'],
    source: `export const name = 'forged-dynamic'\nexport async function apply() {\n  await import('node:fs')\n}\n`,
  })
  record(
    'Dynamic import() is rejected before any proposal exists',
    dynamic.isError && /dynamic import/.test(dynamic.text),
    dynamic.text.slice(0, 90),
  )
  const builtin = await callTool('plugin_forge', {
    action: 'prepare_forge',
    scope: 'user',
    name: 'forged-builtin',
    summary: 'Adversarial: non-whitelisted import.',
    manifest: { name: 'forged-builtin', provide: [], inject: [] },
    intended_effects: ['nothing'],
    source: `import { readFileSync } from 'node:fs'\nexport const name = 'forged-builtin'\nexport function apply() {\n  readFileSync('/etc/hosts')\n}\n`,
  })
  record(
    'Non-whitelisted static import is rejected before any proposal exists',
    builtin.isError && /whitelist|not in the import/i.test(builtin.text),
    builtin.text.slice(0, 90),
  )
  record(
    'Adversarial prepares never reached the approval service',
    approvalScript.length === 0,
    `${approvals.length} approval request(s) total, all for proposal_control apply`,
  )
}

// --- summary ---
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
