import { createServer } from 'node:http'
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import {
  searchCapabilities,
  buildSkillCapability,
} from '../dist/packages/capability-discovery/src/catalog.js'

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('=== [1/3] Capability Discovery & Skill Provider Integration ===')

// 1. Setup Cordis & discovery with real filesystem skills provider
const presetsDir = new URL('../presets/skills', import.meta.url).pathname
const providers = []
const ctx = new Context()
ctx.provide('skills')
ctx.skills = {
  registerProvider: (create) => {
    providers.push(create({ refresh: () => {}, signal: new AbortController().signal }))
  },
}

ctx.plugin(SkillFilesystem, {
  providerName: 'omd-skills',
  includeDefaultRoots: false,
  customSkillDirs: [presetsDir],
  watch: false,
})
await new Promise((r) => setTimeout(r, 200))

const candidateSkills = await providers[0].list({ cwd: process.cwd() })
const skillCaps = candidateSkills.map((s) => buildSkillCapability(s, true))
const hits = searchCapabilities(skillCaps, 'browser', { limit: 5 })

const browserSkillHit = hits.find((h) => h.id === 'browser-use-cli')
record(
  'Capability search finds browser-use-cli for "browser"',
  !!browserSkillHit,
  browserSkillHit
    ? `ref=${browserSkillHit.ref} score=${browserSkillHit.score.toFixed(2)}`
    : 'not found',
)

const skillCandidate = candidateSkills.find((c) => c.name === 'browser-use-cli')
const skillDef = await providers[0].get(skillCandidate, { cwd: process.cwd() })
record(
  'Skill body loads and contains isolated browser & security rules',
  /isolated browser/i.test(skillDef.content) &&
    /ANONYMIZED_TELEMETRY=false/.test(skillDef.content) &&
    /169\.254\.169\.254/.test(skillDef.content),
  `length=${skillDef.content.length} chars`,
)

console.log('\n=== [2/3] Live Browser Interaction via Script-Mode CLI ===')

// 2. Start a local test web server
const testHtml = `<!doctype html>
<html>
<head><title>OMD Real Browser Test</title></head>
<body>
  <h1 id="heading">Ready</h1>
  <button id="counter-btn" onclick="document.getElementById('heading').innerText = 'Clicked ' + (++count)">Click Me</button>
  <script>let count = 0;</script>
</body>
</html>`

const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(testHtml)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const testPort = server.address().port
const testUrl = `http://127.0.0.1:${testPort}/`
console.log(`Local test server running at ${testUrl}`)

// Dynamically select an available CDP port
const cdpPortServer = createServer()
await new Promise((r) => cdpPortServer.listen(0, '127.0.0.1', r))
const cdpPort = cdpPortServer.address().port
cdpPortServer.close()
await new Promise((r) => setTimeout(r, 100))

const tmpProfile = mkdtempSync(join(tmpdir(), 'omd-bu-smoke-'))

console.log(`Launching isolated Chrome on port ${cdpPort} with profile ${tmpProfile}...`)
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const chromeProc = spawn(
  chromePath,
  [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tmpProfile}`,
    '--no-first-run',
    '--headless=new',
    '--disable-gpu',
  ],
  { stdio: 'ignore' },
)

// Wait for Chrome CDP endpoint to be reachable
let cdpReady = false
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
    if (res.ok) {
      cdpReady = true
      break
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 200))
}
record(
  'Isolated headless Chrome started and CDP endpoint reachable',
  cdpReady,
  `http://127.0.0.1:${cdpPort}`,
)

// Find the browser-use binary
let buBin = '/tmp/omd-audit/bu-env/bin/browser-use'
try {
  execSync('which browser-use', { stdio: 'ignore' })
  buBin = 'browser-use'
} catch {}

console.log(`Executing browser automation with ${buBin}...`)

const pythonScript = `
new_tab("${testUrl}")
wait_for_load()
info = page_info()
print("INITIAL_PAGE_INFO:", info)
tree = cdp("Accessibility.getFullAXTree")
button_nodes = [n for n in tree.get("nodes", []) if n.get("role", {}).get("value") == "button"]
print("AX_BUTTON_FOUND:", len(button_nodes) > 0)
res = js("document.getElementById('counter-btn').click(); document.getElementById('heading').innerText")
print("AFTER_CLICK:", res)
`

let scriptOutput = ''
let scriptError = ''

const buProc = spawn(buBin, [], {
  env: {
    ...process.env,
    ANONYMIZED_TELEMETRY: 'false',
    BU_CDP_URL: `http://127.0.0.1:${cdpPort}`,
  },
})

buProc.stdin.write(pythonScript)
buProc.stdin.end()

buProc.stdout.on('data', (d) => {
  scriptOutput += d.toString('utf8')
})
buProc.stderr.on('data', (d) => {
  scriptError += d.toString('utf8')
})

const buExitCode = await new Promise((resolve) => {
  buProc.on('close', resolve)
})

const navigatedOk =
  buExitCode === 0 &&
  (scriptOutput.includes('OMD Real Browser Test') || scriptOutput.includes('INITIAL_PAGE_INFO'))
const axOk = scriptOutput.includes('AX_BUTTON_FOUND: True')
const interactionOk = scriptOutput.includes('Clicked 1')

record(
  'browser-use script navigated to test page and extracted AX / DOM state',
  navigatedOk && axOk,
  `exitCode=${buExitCode} ${scriptOutput.trim().slice(0, 150).replace(/\n/g, ' ')}`,
)
record(
  'browser-use script executed interaction and verified mutation',
  interactionOk,
  interactionOk ? 'Clicked 1 verified' : `Output: ${scriptOutput} Error: ${scriptError}`,
)

// Teardown
chromeProc.kill('SIGTERM')
await new Promise((r) => setTimeout(r, 500))
try {
  chromeProc.kill('SIGKILL')
} catch {}
try {
  execSync('pkill -f "browser_harness.daemon" 2>/dev/null')
} catch {}

if (existsSync(tmpProfile)) {
  rmSync(tmpProfile, { recursive: true, force: true })
}
server.close()

record('Isolated Chrome process and profile directory cleaned up', !existsSync(tmpProfile))

console.log('\n=== [3/3] CLI & Profile Sanity Checks ===')

let cliHelpOk = false
try {
  const out = execSync('node ./bin/omd --help', { encoding: 'utf8' })
  cliHelpOk =
    out.includes('omd') && out.includes('doctor') && out.includes('setup') && out.includes('preset')
} catch (e) {
  console.error('cli help error:', e)
}
record('omd --help displays top-level CLI documentation and subcommands', cliHelpOk)

let doctorOk = false
try {
  const out = execSync('node ./bin/omd doctor', { encoding: 'utf8' })
  doctorOk = out.includes('oh-my-dsh') && out.includes('web fetch') && out.includes('listeners')
} catch (e) {
  console.error('doctor error:', e)
}
record('omd doctor executes and reports installation/security posture', doctorOk)

const failed = results.filter((r) => !r.ok)
console.log(`\n========================================`)
if (failed.length === 0) {
  console.log(`🎉 ALL ${results.length} SMOKE CHECKS PASSED!`)
  process.exit(0)
} else {
  console.log(`❌ ${failed.length} of ${results.length} CHECKS FAILED`)
  process.exit(1)
}
