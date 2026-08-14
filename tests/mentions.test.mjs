import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractMentions,
  mentionsInMessages,
  renderFileWindow,
  resolveSections,
  scanLines,
} from '../dist/packages/mentions/src/index.js'
import { lineHash } from '../dist/packages/editor/src/index.js'

test('bare mentions parse paths, ranges, and trailing punctuation', () => {
  const mentions = extractMentions('see @src/index.ts, then @docs/plan.md:10-20.')
  assert.deepEqual(mentions, [
    { raw: '@src/index.ts', path: 'src/index.ts', start: undefined, end: undefined },
    { raw: '@docs/plan.md:10-20', path: 'docs/plan.md', start: 10, end: 20 },
  ])
})

test('quoted mentions support spaces and ranges', () => {
  const mentions = extractMentions('open @"my notes/todo list.md":3-5 now')
  assert.deepEqual(mentions, [
    { raw: '@"my notes/todo list.md":3-5', path: 'my notes/todo list.md', start: 3, end: 5 },
  ])
})

test('emails, mid-word tokens, and code spans are not mentions', () => {
  assert.deepEqual(extractMentions('mail me at user@example.com'), [])
  assert.deepEqual(extractMentions('the token a@b/c stays text'), [])
  assert.deepEqual(extractMentions('run `@src/index.ts` verbatim'), [])
})

test('invalid ranges fall back to the plain path', () => {
  const mentions = extractMentions('check @a.ts:40-10 and @b.ts:0-5')
  assert.deepEqual(mentions.map((mention) => [mention.path, mention.start]), [
    ['a.ts', undefined],
    ['b.ts', undefined],
  ])
})

test('duplicate mentions collapse to one', () => {
  assert.equal(extractMentions('@x.ts and @x.ts again').length, 1)
})

test('mentionsInMessages reads only user-sourced text blocks', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'fix @one.ts' }], source: { kind: 'user' } },
    { role: 'user', content: [{ type: 'text', text: 'skip @two.ts' }], source: { kind: 'plugin', plugin: 'x' } },
    { role: 'user', content: [{ type: 'text', text: 'also @one.ts and @three.ts' }], source: { kind: 'user' } },
  ]
  assert.deepEqual(mentionsInMessages(messages).map((mention) => mention.path), ['one.ts', 'three.ts'])
})

async function* chunked(text, size = 4) {
  for (let at = 0; at < text.length; at += size) yield text.slice(at, at + size)
}

test('scanLines reads to end of file when within budget', async () => {
  const scan = await scanLines(chunked('a\nb\nc'), 100, 1000)
  assert.deepEqual(scan, { lines: ['a', 'b', 'c'], complete: true })
})

test('scanLines stops early once enough complete lines exist', async () => {
  const scan = await scanLines(chunked('one\ntwo\nthree\nfour\n'), 2, 1000)
  assert.equal(scan.complete, false)
  assert.deepEqual(scan.lines.slice(0, 2), ['one', 'two'])
})

test('scanLines drops the partial trailing line on byte-budget stop', async () => {
  const scan = await scanLines(chunked('alpha\nbeta\ngam'), 100, 8)
  assert.equal(scan.complete, false)
  assert.deepEqual(scan.lines, ['alpha'])
})

test('renderFileWindow emits hash_edit-compatible anchor rows', () => {
  const text = renderFileWindow({
    path: 'src/a.ts',
    sizeBytes: 8,
    lines: ['aa', 'bb'],
    totalLines: 2,
    maxLines: 200,
    maxBytes: 1000,
  })
  assert.equal(text, [
    'src/a.ts lines 1-2 of 2, 8 bytes:',
    `1:${lineHash('aa')}|aa`,
    `2:${lineHash('bb')}|bb`,
  ].join('\n'))
})

test('renderFileWindow honors an explicit line range with a continuation footer', () => {
  const lines = ['l1', 'l2', 'l3', 'l4', 'l5']
  const text = renderFileWindow({
    path: 'a.ts',
    lines,
    totalLines: 5,
    start: 2,
    end: 3,
    maxLines: 200,
    maxBytes: 1000,
  })
  assert.match(text, /^a\.ts lines 2-3 of 5:/)
  assert.match(text, new RegExp(`2:${lineHash('l2')}\\|l2`))
  assert.match(text, /\[2 more lines; hash_edit read offset 4 continues\]$/)
})

test('renderFileWindow caps attachment bytes and reports the resume offset', () => {
  const lines = Array.from({ length: 50 }, (_value, index) => `line-${index + 1}-${'x'.repeat(40)}`)
  const text = renderFileWindow({
    path: 'big.ts',
    lines,
    totalLines: 50,
    maxLines: 200,
    maxBytes: 300,
  })
  assert.match(text, /\[attachment capped at 300 bytes; hash_edit read offset \d+ continues\]$/)
  assert.ok(text.split('\n').length < 20)
})

test('renderFileWindow reports ranges beyond the scanned content', () => {
  const text = renderFileWindow({
    path: 'a.ts',
    lines: ['only'],
    totalLines: 1,
    start: 10,
    end: 12,
    maxLines: 200,
    maxBytes: 1000,
  })
  assert.equal(text, 'a.ts: requested lines 10-12, but only 1 lines exist.')
})

test('renderFileWindow marks partial scans with an unknown total', () => {
  const text = renderFileWindow({
    path: 'a.log',
    lines: ['x', 'y'],
    maxLines: 200,
    maxBytes: 1000,
  })
  assert.match(text, /^a\.log lines 1-2 \(partial scan\):/)
  assert.match(text, /\[file continues; hash_edit read offset 3 continues\]$/)
})

const context = { workspace: '/w', agent: {}, signal: undefined }

test('resolveSections prefers registered resolvers and skips failures', async () => {
  const custom = async (mention) =>
    mention.path === 'special' ? { name: mention.raw, text: 'custom' } : undefined
  const failing = async () => {
    throw new Error('boom')
  }
  const fallback = async (mention) => ({ name: mention.raw, text: `file:${mention.path}` })
  const sections = await resolveSections(
    [{ raw: '@special', path: 'special' }, { raw: '@plain', path: 'plain' }],
    [failing, custom, fallback],
    context,
    { maxMentions: 6, maxTotalBytes: 1000 },
  )
  assert.deepEqual(sections.map((section) => section.text), ['custom', 'file:plain'])
})

test('resolveSections enforces the mention and total-byte caps', async () => {
  const resolver = async (mention) => ({ name: mention.raw, text: 'x'.repeat(30) })
  const mentions = Array.from({ length: 5 }, (_value, index) => ({ raw: `@f${index}`, path: `f${index}` }))
  const capped = await resolveSections(mentions, [resolver], context, { maxMentions: 2, maxTotalBytes: 1000 })
  assert.equal(capped.length, 2)
  const bytes = await resolveSections(mentions, [resolver], context, { maxMentions: 5, maxTotalBytes: 65 })
  assert.equal(bytes.length, 2)
})

test('unresolvable mentions expand to nothing', async () => {
  const sections = await resolveSections(
    [{ raw: '@ghost.ts', path: 'ghost.ts' }],
    [async () => undefined],
    context,
    { maxMentions: 6, maxTotalBytes: 1000 },
  )
  assert.deepEqual(sections, [])
})
