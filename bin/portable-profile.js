import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Classify a profile's node_modules against the portable dependency closure.
 *
 * Portable dsh and the profile must resolve one physical `@deepseek-ai/dsh-scope`.
 * A leftover npm/source tree keeps its own copy; `kScope` is a per-module
 * Symbol, so the standing preset mount becomes invisible to system-prompt and
 * `dsh-persona` collides with the deployment persona on the global layer.
 *
 * @param {string} profileDir
 * @param {string} closureTarget absolute path of the portable app/node_modules
 * @returns {'missing' | 'linked' | 'stale-tree' | 'stale-link'}
 */
export function portableProfileState(profileDir, closureTarget) {
  const nodeModulesPath = join(profileDir, 'node_modules')
  const omdPath = join(nodeModulesPath, 'oh-my-dsh')
  if (!existsSync(omdPath)) return 'missing'
  if (!existsSync(nodeModulesPath)) return 'missing'

  let info
  try {
    info = lstatSync(nodeModulesPath)
  } catch {
    return 'missing'
  }

  if (!info.isSymbolicLink()) return 'stale-tree'

  let target
  try {
    target = resolve(dirname(nodeModulesPath), readlinkSync(nodeModulesPath))
  } catch {
    return 'stale-link'
  }
  return resolve(target) === resolve(closureTarget) ? 'linked' : 'stale-link'
}

export function portableProfileReady(profileDir, closureTarget) {
  return portableProfileState(profileDir, closureTarget) === 'linked'
}

export function describePortableProfileState(state) {
  switch (state) {
    case 'linked':
      return 'linked to portable closure'
    case 'missing':
      return 'missing'
    case 'stale-tree':
      return 'stale npm/source tree (run `omd setup` to relink)'
    case 'stale-link':
      return 'stale link (run `omd setup` to relink)'
    default:
      return 'unknown'
  }
}
