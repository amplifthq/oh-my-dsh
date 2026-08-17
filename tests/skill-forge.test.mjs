import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  detectSecretLikeContent,
  parseSkillMarkdown,
  planSkillWrite,
  renderSkillMarkdown,
  validateSkillInput,
} from '../dist/packages/skill-forge/src/document.js'
import {
  commitSkillWrite,
  readExistingSkill,
  resolveSkillTarget,
  skillDigest,
} from '../dist/packages/skill-forge/src/store.js'
import {
  distillInstruction,
  planSkillSave,
  skillSaveCommit,
} from '../dist/packages/skill-forge/src/index.js'
import { ProposalStore } from '../dist/packages/proposals/src/index.js'

const PRESET_SKILLS = [
  'review-changes',
  'systematic-debugging',
  'verify-before-done',
  'browser-use-cli',
]

function presetContent(slug) {
  return readFileSync(new URL(`../presets/skills/${slug}/SKILL.md`, import.meta.url), 'utf8')
}

function sampleInput(overrides = {}) {
  return {
    slug: 'release-tagging',
    description: 'Cut a release with matching package.json, src version, and annotated tag.',
    whenToUse: 'Use when the user asks to publish or tag a release.',
    body: '# Release tagging\n\n1. Bump both version fields.\n2. Tag and verify.',
    ...overrides,
  }
}

// --- document model ---

test('bundled preset skills round-trip byte-for-byte', () => {
  for (const slug of PRESET_SKILLS) {
    const content = presetContent(slug)
    const document = parseSkillMarkdown(content)
    assert.equal(document.slug, slug)
    assert.equal(renderSkillMarkdown(document), content)
  }
})

test('validateSkillInput normalizes and preserves fields', () => {
  const document = validateSkillInput(sampleInput({ description: '  padded description  ' }))
  assert.equal(document.slug, 'release-tagging')
  assert.equal(document.description, 'padded description')
  assert.equal(document.whenToUse, 'Use when the user asks to publish or tag a release.')
  assert.match(document.body, /^# Release tagging/)
})

test('validateSkillInput accepts omitted whenToUse', () => {
  const document = validateSkillInput(sampleInput({ whenToUse: undefined }))
  assert.equal(document.whenToUse, undefined)
  const rendered = renderSkillMarkdown(document)
  assert.ok(!rendered.includes('whenToUse:'))
  assert.deepEqual(parseSkillMarkdown(rendered), document)
})

test('validateSkillInput rejects path-flavored and malformed slugs', () => {
  const rejected = [
    '../escape',
    'nested/slug',
    '/absolute',
    'dotted.slug',
    'a\u2024b', // unicode one-dot leader
    'Upper-Case',
    'under_score',
    '-leading-hyphen',
    '',
    'a'.repeat(42),
  ]
  for (const slug of rejected) {
    assert.throws(
      () => validateSkillInput(sampleInput({ slug })),
      /slug/,
      `slug ${JSON.stringify(slug)}`,
    )
  }
  assert.equal(validateSkillInput(sampleInput({ slug: 'a'.repeat(41) })).slug, 'a'.repeat(41))
})

test('validateSkillInput enforces description and whenToUse bounds', () => {
  assert.throws(() => validateSkillInput(sampleInput({ description: '' })), /description/)
  assert.throws(() => validateSkillInput(sampleInput({ description: '   ' })), /description/)
  assert.throws(
    () => validateSkillInput(sampleInput({ description: 'x'.repeat(501) })),
    /description/,
  )
  assert.throws(
    () => validateSkillInput(sampleInput({ description: 'line one\nline two' })),
    /description/,
  )
  assert.throws(() => validateSkillInput(sampleInput({ whenToUse: 'x'.repeat(501) })), /whenToUse/)
  assert.throws(() => validateSkillInput(sampleInput({ whenToUse: 'a\nb' })), /whenToUse/)
  assert.equal(
    validateSkillInput(sampleInput({ description: 'x'.repeat(500) })).description,
    'x'.repeat(500),
  )
})

test('validateSkillInput enforces body bounds', () => {
  assert.throws(() => validateSkillInput(sampleInput({ body: '' })), /body/)
  assert.throws(() => validateSkillInput(sampleInput({ body: '  \n ' })), /body/)
  assert.throws(() => validateSkillInput(sampleInput({ body: 'x'.repeat(32 * 1024 + 1) })), /body/)
  // multi-byte characters count in bytes, not code points
  assert.throws(() => validateSkillInput(sampleInput({ body: '汉'.repeat(11000) })), /body/)
  assert.ok(validateSkillInput(sampleInput({ body: 'x'.repeat(32 * 1024) })))
})

test('parseSkillMarkdown rejects missing or malformed frontmatter', () => {
  assert.throws(() => parseSkillMarkdown('# no frontmatter\n'), /frontmatter/)
  assert.throws(() => parseSkillMarkdown('---\nname: [\n---\nbody\n'), /frontmatter/)
  assert.throws(() => parseSkillMarkdown('---\n- just\n- a list\n---\nbody\n'), /frontmatter/)
  assert.throws(
    () => parseSkillMarkdown('---\nname: x-skill\ndescription: d\nextra: nope\n---\nbody\n'),
    /extra/,
  )
})

test('renderSkillMarkdown emits canonical layout', () => {
  const rendered = renderSkillMarkdown(validateSkillInput(sampleInput()))
  assert.ok(rendered.startsWith('---\nname: release-tagging\ndescription: '))
  assert.match(rendered, /\n---\n\n# Release tagging/)
  assert.ok(rendered.endsWith('.\n'))
  assert.ok(!rendered.endsWith('\n\n'))
})

test('detectSecretLikeContent flags known credential shapes', () => {
  const findings = detectSecretLikeContent(
    [
      'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv12',
      'aws key AKIAIOSFODNN7EXAMPLE',
      'token ghp_abcdefghijklmnopqrstuvwxyz1234',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MY_SERVICE_TOKEN=super-secret-value-here',
    ].join('\n'),
  )
  assert.ok(findings.length >= 4, `expected at least 4 warnings, got: ${JSON.stringify(findings)}`)
  for (const finding of findings) assert.equal(typeof finding, 'string')
})

test('detectSecretLikeContent stays quiet on ordinary procedure text', () => {
  assert.deepEqual(
    detectSecretLikeContent('1. Run pnpm test.\n2. Check the queue-skip regression.\n'),
    [],
  )
})

test('planSkillWrite distinguishes create from update and carries warnings', () => {
  const document = validateSkillInput(sampleInput())
  const create = planSkillWrite(document)
  assert.equal(create.action, 'create')
  assert.equal(create.before, undefined)
  assert.equal(create.after, renderSkillMarkdown(document))
  assert.deepEqual(create.warnings, [])

  const previous = renderSkillMarkdown(
    validateSkillInput(sampleInput({ body: '# Old body\n\nOld steps.' })),
  )
  const update = planSkillWrite(document, previous)
  assert.equal(update.action, 'update')
  assert.equal(update.before, previous)
  assert.equal(update.after, create.after)

  const leaky = planSkillWrite(
    validateSkillInput(sampleInput({ body: 'Use AKIAIOSFODNN7EXAMPLE to sign in.' })),
  )
  assert.equal(leaky.warnings.length, 1)
  assert.match(leaky.warnings[0], /AWS/i)
})

// --- store ---

async function scratchRoots() {
  const base = await mkdtemp(join(tmpdir(), 'omd-skill-forge-'))
  const dshHome = join(base, 'dsh-home')
  const workspace = join(base, 'workspace')
  await mkdir(dshHome, { recursive: true })
  await mkdir(workspace, { recursive: true })
  return { base, dshHome, workspace }
}

function samplePlan(body = '# Sample\n\nStep one.') {
  return planSkillWrite(validateSkillInput(sampleInput({ body })))
}

test('resolveSkillTarget maps scopes to their roots', async () => {
  const { dshHome, workspace } = await scratchRoots()
  const user = resolveSkillTarget('user', 'release-tagging', { dshHome, workspace })
  assert.equal(user.root, join(dshHome, 'skills'))
  assert.equal(user.path, join(dshHome, 'skills', 'release-tagging', 'SKILL.md'))

  const project = resolveSkillTarget('project', 'release-tagging', { dshHome, workspace })
  assert.equal(project.root, join(workspace, '.dsh', 'skills'))
  assert.equal(project.path, join(workspace, '.dsh', 'skills', 'release-tagging', 'SKILL.md'))

  assert.throws(() => resolveSkillTarget('project', 'release-tagging', { dshHome }), /workspace/)
  assert.throws(() => resolveSkillTarget('user', '../escape', { dshHome }), /slug/)
  assert.throws(() => resolveSkillTarget('user', 'a/b', { dshHome }), /slug/)
})

test('commitSkillWrite rejects targets outside the skill root', async () => {
  const { base, dshHome } = await scratchRoots()
  const honest = resolveSkillTarget('user', 'sample', { dshHome })
  const forged = {
    ...honest,
    directory: join(base, 'elsewhere'),
    path: join(base, 'elsewhere', 'SKILL.md'),
  }
  await assert.rejects(commitSkillWrite(forged, samplePlan()), /escapes/)
})

test('commitSkillWrite refuses symlinked skill directories and files', async () => {
  const { base, dshHome } = await scratchRoots()
  const target = resolveSkillTarget('user', 'sneaky', { dshHome })
  const outside = join(base, 'outside')
  await mkdir(outside, { recursive: true })
  await mkdir(target.root, { recursive: true })
  await symlink(outside, target.directory)
  await assert.rejects(commitSkillWrite(target, samplePlan()), /symlink/)
  assert.deepEqual(await readdir(outside), [])

  const fileTarget = resolveSkillTarget('user', 'sneaky-file', { dshHome })
  await mkdir(fileTarget.directory, { recursive: true })
  const decoy = join(base, 'decoy.md')
  await writeFile(decoy, 'decoy')
  await symlink(decoy, fileTarget.path)
  await assert.rejects(commitSkillWrite(fileTarget, samplePlan(), skillDigest('decoy')), /symlink/)
  assert.equal(await readFile(decoy, 'utf8'), 'decoy')
})

test('commitSkillWrite enforces the stale-content guard without writing', async () => {
  const { dshHome } = await scratchRoots()
  const target = resolveSkillTarget('user', 'sample', { dshHome })
  await mkdir(target.directory, { recursive: true })
  await writeFile(target.path, 'original content')
  const prepared = await readExistingSkill(target.path)

  await writeFile(target.path, 'drifted content')
  await assert.rejects(commitSkillWrite(target, samplePlan(), prepared.digest), /changed after/)
  assert.equal(await readFile(target.path, 'utf8'), 'drifted content')

  // file appeared although the proposal expected a fresh create
  const fresh = resolveSkillTarget('user', 'fresh', { dshHome })
  await mkdir(fresh.directory, { recursive: true })
  await writeFile(fresh.path, 'surprise')
  await assert.rejects(commitSkillWrite(fresh, samplePlan()), /appeared after/)

  // file disappeared although the proposal expected an update
  const gone = resolveSkillTarget('user', 'gone', { dshHome })
  await assert.rejects(
    commitSkillWrite(gone, samplePlan(), skillDigest('was there')),
    /disappeared/,
  )
})

test('commitSkillWrite leaves no residue when the final rename fails', async () => {
  const { dshHome } = await scratchRoots()
  const target = resolveSkillTarget('user', 'sample', { dshHome })
  await assert.rejects(
    commitSkillWrite(target, samplePlan(), undefined, {
      renameFile: async () => {
        throw new Error('injected rename failure')
      },
    }),
    /injected rename failure/,
  )
  assert.deepEqual(await readdir(target.directory), [])
})

test('commitSkillWrite creates and updates atomically with mode 0644', async () => {
  const { dshHome } = await scratchRoots()
  const target = resolveSkillTarget('user', 'sample', { dshHome })
  const createPlan = samplePlan()
  await commitSkillWrite(target, createPlan)
  assert.equal(await readFile(target.path, 'utf8'), createPlan.after)
  const { mode } = await import('node:fs/promises').then((fs) => fs.stat(target.path))
  assert.equal(mode & 0o777, 0o644)
  assert.deepEqual(await readdir(target.directory), ['SKILL.md'])

  const existing = await readExistingSkill(target.path)
  const updatePlan = samplePlan('# Sample\n\nStep one.\nStep two.')
  await commitSkillWrite(target, updatePlan, existing.digest)
  assert.equal(await readFile(target.path, 'utf8'), updatePlan.after)
  assert.deepEqual(await readdir(target.directory), ['SKILL.md'])

  assert.equal(await readExistingSkill(join(dshHome, 'skills', 'missing', 'SKILL.md')), undefined)
})

// --- runtime ---

function saveArgs(overrides = {}) {
  return {
    scope: 'user',
    name: 'release-tagging',
    description: 'Cut a release with matching version fields and an annotated tag.',
    when_to_use: 'Use when the user asks to publish or tag a release.',
    body: '# Release tagging\n\n1. Bump both version fields.\n2. Tag and verify.',
    ...overrides,
  }
}

test('planSkillSave validates arguments before touching the filesystem', async () => {
  const { dshHome, workspace } = await scratchRoots()
  await assert.rejects(planSkillSave(saveArgs({ name: '../escape' }), { dshHome }), /slug/)
  await assert.rejects(planSkillSave(saveArgs({ body: '' }), { dshHome }), /body/)
  await assert.rejects(
    planSkillSave(saveArgs({ description: 'x'.repeat(501) }), { dshHome }),
    /description/,
  )
  await assert.rejects(planSkillSave(saveArgs({ scope: 'project' }), { dshHome }), /workspace/)
  assert.ok(await planSkillSave(saveArgs({ scope: 'project' }), { dshHome, workspace }))
})

test('planSkillSave stages exact before/after effects for create and update', async () => {
  const { dshHome } = await scratchRoots()
  const created = await planSkillSave(saveArgs(), { dshHome })
  assert.equal(created.plan.action, 'create')
  assert.equal(created.expectedDigest, undefined)
  assert.equal(created.effects.length, 1)
  const effect = created.effects[0]
  assert.equal(effect.type, 'skill-write')
  assert.equal(effect.target, created.target.path)
  assert.equal(effect.details.before, null)
  assert.equal(effect.details.after, created.plan.after)
  assert.equal(effect.details.expectedDigest, null)
  assert.deepEqual(effect.details.warnings, [])
  assert.match(created.title, /release-tagging/)

  await commitSkillWrite(created.target, created.plan)
  const updated = await planSkillSave(saveArgs({ body: '# Release tagging\n\nNew steps.' }), {
    dshHome,
  })
  assert.equal(updated.plan.action, 'update')
  assert.equal(updated.effects[0].details.before, created.plan.after)
  assert.equal(updated.expectedDigest, skillDigest(created.plan.after))
  assert.equal(updated.effects[0].details.expectedDigest, updated.expectedDigest)
})

test('planSkillSave rejects an identical re-save', async () => {
  const { dshHome } = await scratchRoots()
  const created = await planSkillSave(saveArgs(), { dshHome })
  await commitSkillWrite(created.target, created.plan)
  await assert.rejects(planSkillSave(saveArgs(), { dshHome }), /identical/)
})

test('skill-write proposals commit end-to-end through the proposal store', async () => {
  const { dshHome } = await scratchRoots()
  const agent = {}
  const store = new ProposalStore()
  const saved = await planSkillSave(saveArgs(), { dshHome })
  const proposal = store.create(agent, {
    kind: 'skill-write',
    title: saved.title,
    summary: saved.summary,
    effects: saved.effects,
    commit: skillSaveCommit(saved),
  })
  assert.equal(proposal.kind, 'skill-write')
  assert.equal(proposal.status, 'pending')

  const result = await store.apply(agent, proposal.id, {})
  assert.match(result.summary, /Saved skill "release-tagging"/)
  assert.equal(await readFile(saved.target.path, 'utf8'), saved.plan.after)
  assert.equal(store.show(agent, proposal.id), undefined)
})

test('a failed commit marks the proposal failed and leaves the target untouched', async () => {
  const { dshHome } = await scratchRoots()
  const agent = {}
  const store = new ProposalStore()
  const saved = await planSkillSave(saveArgs(), { dshHome })
  const proposal = store.create(agent, {
    kind: 'skill-write',
    title: saved.title,
    summary: saved.summary,
    effects: saved.effects,
    commit: skillSaveCommit(saved),
  })

  // the file appears between prepare and apply — the stale guard must fail the commit
  await mkdir(saved.target.directory, { recursive: true })
  await writeFile(saved.target.path, 'raced content')

  await assert.rejects(store.apply(agent, proposal.id, {}), /appeared after/)
  const failed = store.show(agent, proposal.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /appeared after/)
  assert.equal(await readFile(saved.target.path, 'utf8'), 'raced content')
})

test('distillInstruction routes focus and mandates the approval gate', () => {
  const focused = distillInstruction('the release steps')
  assert.match(focused, /Focus: the release steps/)
  assert.match(focused, /skill_control prepare_save/)
  assert.match(focused, /proposal_control apply/)
  const unfocused = distillInstruction('')
  assert.match(unfocused, /most recently verified procedure/)
})
