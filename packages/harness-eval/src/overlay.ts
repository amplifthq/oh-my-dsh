import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'

import { normalizeInterventionTarget, type Intervention } from './contract.js'
import type { StoredSnapshot } from './store.js'

export interface EvalOverlay {
  cwd: string
  mountedPluginRefs: string[]
  skillRefs: string[]
  dispose(): Promise<void>
}

function targetRef(intervention: Intervention | null): string | undefined {
  return intervention ? normalizeInterventionTarget(intervention.target) : undefined
}

async function linkNodeModules(cwd: string): Promise<void> {
  const req = createRequire(import.meta.url)
  const resolved = req.resolve('@deepseek-ai/dsh-tools')
  let dir = dirname(resolved)
  while (dir !== dirname(dir) && !dir.endsWith('node_modules')) dir = dirname(dir)
  if (!dir.endsWith('node_modules')) return
  await symlink(dir, join(cwd, 'node_modules'), 'junction')
}

export async function buildOverlay(input: {
  snapshot: StoredSnapshot
  intervention: Intervention | null
  fixtureDir?: string
  taskDir?: string
}): Promise<EvalOverlay> {
  const omitted = targetRef(input.intervention)
  const cwd = join(tmpdir(), `omd-eval-${randomBytes(8).toString('hex')}`)
  await mkdir(cwd, { recursive: true })
  await mkdir(join(cwd, 'plugins'), { recursive: true })
  await mkdir(join(cwd, 'skills'), { recursive: true })
  if (input.fixtureDir) {
    const fixture = resolve(input.fixtureDir)
    if (input.taskDir) {
      const rel = relative(resolve(input.taskDir), fixture)
      if (rel.startsWith('..')) {
        throw new Error(`eval fixture escapes its task directory: ${input.fixtureDir}`)
      }
    }
    await cp(fixture, cwd, { recursive: true })
  }
  await linkNodeModules(cwd)
  const mountedPluginRefs: string[] = []
  const skillRefs: string[] = []
  for (const file of input.snapshot.files) {
    const ref = normalizeInterventionTarget(file.ref)
    if (omitted && ref === omitted) continue
    if (ref.startsWith('skill:')) {
      const name = decodeURIComponent(ref.slice('skill:'.length))
      await mkdir(join(cwd, 'skills', name), { recursive: true })
      await writeFile(join(cwd, 'skills', name, 'SKILL.md'), file.bytes)
      skillRefs.push(ref)
    } else if (ref.startsWith('plugin:')) {
      const id = decodeURIComponent(ref.slice('plugin:'.length)).replaceAll('/', '__')
      await writeFile(join(cwd, 'plugins', `${id}.mjs`), file.bytes)
      mountedPluginRefs.push(ref)
    }
  }
  if (input.snapshot.patch) {
    await writeFile(join(cwd, 'cordis.patch.yml'), input.snapshot.patch)
  }
  return {
    cwd,
    mountedPluginRefs,
    skillRefs,
    async dispose() {
      await rm(cwd, { recursive: true, force: true })
    },
  }
}
