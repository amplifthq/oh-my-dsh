import assert from 'node:assert/strict'
import test from 'node:test'
import {
  insertAfterAnchor,
  lineHash,
  renderAnchoredLines,
  replaceAnchoredRange,
} from '../dist/packages/editor/src/index.js'

test('anchored range replacement verifies and replaces inclusive lines', () => {
  const source = ['alpha', 'beta', 'gamma', 'delta'].join('\n')
  const start = `2:${lineHash('beta')}`
  const end = `3:${lineHash('gamma')}`
  assert.equal(replaceAnchoredRange(source, start, end, 'B\nC', [start, end]), 'alpha\nB\nC\ndelta')
})

test('stale anchors fail without changing content', () => {
  const source = 'alpha\nchanged'
  assert.throws(
    () =>
      replaceAnchoredRange(source, `2:${lineHash('beta')}`, `2:${lineHash('beta')}`, 'new', [
        `2:${lineHash('beta')}`,
      ]),
    /stale anchor/,
  )
})

test('interior changes invalidate a previously read range', () => {
  const start = `1:${lineHash('start')}`
  const staleMiddle = `2:${lineHash('middle')}`
  const end = `3:${lineHash('end')}`
  assert.throws(
    () =>
      replaceAnchoredRange('start\nchanged\nend', start, end, 'replacement', [
        start,
        staleMiddle,
        end,
      ]),
    /stale anchor/,
  )
})

test('read output can drive insert_after', () => {
  const source = 'one\ntwo'
  const anchor = `1:${lineHash('one')}`
  assert.match(renderAnchoredLines(source), new RegExp(`^${anchor.replace(':', ':')}\\|one`))
  assert.equal(insertAfterAnchor(source, anchor, 'middle'), 'one\nmiddle\ntwo')
})
