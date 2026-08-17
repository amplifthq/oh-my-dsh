import { createHash, randomBytes } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { SLUG_PATTERN, type SkillWritePlan } from './document.js'

export type SkillScope = 'user' | 'project'

export interface SkillTarget {
  scope: SkillScope
  root: string
  directory: string
  path: string
}

export interface SkillRoots {
  dshHome: string
  workspace?: string
}

export interface ExistingSkill {
  content: string
  digest: string
}

export function skillDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function resolveSkillTarget(
  scope: SkillScope,
  slug: string,
  roots: SkillRoots,
): SkillTarget {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`skill slug ${JSON.stringify(slug)} is not a safe directory name`)
  }
  let root: string
  if (scope === 'user') {
    root = resolve(roots.dshHome, 'skills')
  } else if (scope === 'project') {
    if (!roots.workspace) {
      throw new Error('project scope requires a session workspace; use user scope instead')
    }
    root = resolve(roots.workspace, '.dsh', 'skills')
  } else {
    throw new Error(`unknown skill scope ${JSON.stringify(scope)}`)
  }
  const directory = join(root, slug)
  const target: SkillTarget = { scope, root, directory, path: join(directory, 'SKILL.md') }
  assertLexicallyContained(target)
  return target
}

function assertLexicallyContained(target: SkillTarget): void {
  const rel = relative(target.root, target.directory)
  if (rel !== basename(target.directory) || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`skill directory ${target.directory} escapes the skill root ${target.root}`)
  }
  if (relative(target.directory, target.path) !== 'SKILL.md') {
    throw new Error(`skill path ${target.path} escapes its directory ${target.directory}`)
  }
}

async function assertSafeTarget(target: SkillTarget): Promise<void> {
  assertLexicallyContained(target)
  const directoryStat = await lstat(target.directory).catch(() => undefined)
  if (directoryStat?.isSymbolicLink()) {
    throw new Error(
      `skill directory ${target.directory} is a symlink; refusing to write through it`,
    )
  }
  if (directoryStat && !directoryStat.isDirectory()) {
    throw new Error(`skill directory ${target.directory} exists but is not a directory`)
  }
  const fileStat = await lstat(target.path).catch(() => undefined)
  if (fileStat?.isSymbolicLink()) {
    throw new Error(`skill file ${target.path} is a symlink; refusing to replace it`)
  }
  // With symlinked segments rejected above, an existing directory must realpath
  // into the (realpathed) root. Guards against surprises like case-mapped or
  // mount-crossing parents.
  const realRoot = await realpath(target.root).catch(() => undefined)
  if (realRoot && directoryStat) {
    const realDirectory = await realpath(target.directory)
    if (realDirectory !== join(realRoot, basename(target.directory))) {
      throw new Error(`skill directory ${target.directory} does not resolve inside ${target.root}`)
    }
  }
}

export async function readExistingSkill(path: string): Promise<ExistingSkill | undefined> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return { content, digest: skillDigest(content) }
}

export interface CommitSkillWriteOptions {
  /** Test seam: swap the final rename to inject failures. */
  renameFile?: typeof rename
}

export async function commitSkillWrite(
  target: SkillTarget,
  plan: SkillWritePlan,
  expectedDigest?: string,
  options: CommitSkillWriteOptions = {},
): Promise<void> {
  await assertSafeTarget(target)
  const existing = await readExistingSkill(target.path)
  if (expectedDigest === undefined) {
    if (existing) {
      throw new Error(
        `skill file ${target.path} appeared after the proposal was prepared; ` +
          'prepare a fresh proposal against the current content',
      )
    }
  } else if (!existing) {
    throw new Error(
      `skill file ${target.path} disappeared after the proposal was prepared; ` +
        'prepare a fresh proposal',
    )
  } else if (existing.digest !== expectedDigest) {
    throw new Error(
      `skill file ${target.path} changed after the proposal was prepared; ` +
        'prepare a fresh proposal against the current content',
    )
  }
  await mkdir(target.directory, { recursive: true })
  const temp = join(target.directory, `.SKILL.md.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, plan.after, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
    await (options.renameFile ?? rename)(temp, target.path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  await chmod(target.path, 0o644)
}
