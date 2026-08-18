import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { capabilityRef } from '../../capability-discovery/src/catalog.js'
import { evalSha256Hex, type SnapshotComposition } from './contract.js'
import { writeSnapshot, type EvalRoots, type SnapshotBlob } from './store.js'

export interface SnapshotCaptureInput {
  skills: { name: string; bytes?: Buffer }[]
  plugins: { ref: string; bytes?: Buffer; revision?: number; version?: string }[]
  patchBytes: Buffer | null
}

export function compositionFromCapture(input: SnapshotCaptureInput): {
  composition: SnapshotComposition
  blobs: { patch?: Buffer; files: SnapshotBlob[] }
} {
  const files: SnapshotBlob[] = []
  const skills = input.skills.map((skill) => {
    const bytes = skill.bytes ?? Buffer.from(skill.name)
    const ref = capabilityRef('skill', skill.name)
    files.push({ ref, bytes })
    return { ref, digest: evalSha256Hex(bytes.toString('utf8')) }
  })
  const plugins = input.plugins.map((plugin) => {
    const bytes = plugin.bytes
    if (bytes) files.push({ ref: plugin.ref, bytes })
    return {
      ref: plugin.ref,
      digest: evalSha256Hex(
        (bytes ?? Buffer.from(`${plugin.ref}@${plugin.version ?? '0'}`)).toString('utf8'),
      ),
      ...(plugin.revision === undefined ? {} : { revision: plugin.revision }),
    }
  })
  const patch = input.patchBytes ?? Buffer.alloc(0)
  const patch_digest = patch.length ? evalSha256Hex(patch.toString('utf8')) : ''
  return {
    composition: { skills, plugins, patch_digest },
    blobs: { patch: patch.length ? patch : undefined, files },
  }
}

export async function writeCapturedSnapshot(roots: EvalRoots, input: SnapshotCaptureInput) {
  const { composition, blobs } = compositionFromCapture(input)
  return writeSnapshot(roots, composition, blobs)
}

export async function captureFromAgent(
  roots: EvalRoots,
  deps: {
    listSkills(): Promise<SnapshotCaptureInput['skills']>
    listPlugins(): Promise<SnapshotCaptureInput['plugins']>
    readPatch(): Promise<Buffer | null>
  },
) {
  return writeCapturedSnapshot(roots, {
    skills: await deps.listSkills(),
    plugins: await deps.listPlugins(),
    patchBytes: await deps.readPatch(),
  })
}

export async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function readSkillBytes(roots: { dshHome: string; workspace?: string }, name: string) {
  const candidates = [
    join(roots.dshHome, 'skills', name, 'SKILL.md'),
    ...(roots.workspace ? [join(roots.workspace, '.dsh', 'skills', name, 'SKILL.md')] : []),
  ]
  for (const path of candidates) {
    const bytes = await readOptionalFile(path)
    if (bytes) return bytes
  }
  return undefined
}
