import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  describePortableProfileState,
  portableProfileReady,
  portableProfileState,
} from '../bin/portable-profile.js'

test('portableProfileState distinguishes missing, linked, stale-tree, and stale-link', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-portable-profile-'))
  try {
    const closure = join(root, 'current', 'app', 'node_modules')
    mkdirSync(join(closure, 'oh-my-dsh'), { recursive: true })
    writeFileSync(join(closure, 'oh-my-dsh', 'package.json'), '{"name":"oh-my-dsh"}')

    const missing = join(root, 'profiles', 'missing')
    mkdirSync(missing, { recursive: true })
    assert.equal(portableProfileState(missing, closure), 'missing')
    assert.equal(portableProfileReady(missing, closure), false)

    const linked = join(root, 'profiles', 'linked')
    mkdirSync(linked, { recursive: true })
    symlinkSync(closure, join(linked, 'node_modules'))
    assert.equal(portableProfileState(linked, closure), 'linked')
    assert.equal(portableProfileReady(linked, closure), true)

    const staleTree = join(root, 'profiles', 'stale-tree')
    mkdirSync(join(staleTree, 'node_modules', 'oh-my-dsh'), { recursive: true })
    writeFileSync(
      join(staleTree, 'node_modules', 'oh-my-dsh', 'package.json'),
      '{"name":"oh-my-dsh"}',
    )
    assert.equal(portableProfileState(staleTree, closure), 'stale-tree')
    assert.equal(portableProfileReady(staleTree, closure), false)

    const otherClosure = join(root, 'other', 'node_modules')
    mkdirSync(join(otherClosure, 'oh-my-dsh'), { recursive: true })
    writeFileSync(join(otherClosure, 'oh-my-dsh', 'package.json'), '{"name":"oh-my-dsh"}')
    const staleLink = join(root, 'profiles', 'stale-link')
    mkdirSync(staleLink, { recursive: true })
    symlinkSync(otherClosure, join(staleLink, 'node_modules'))
    assert.equal(portableProfileState(staleLink, closure), 'stale-link')
    assert.equal(portableProfileReady(staleLink, closure), false)

    assert.match(describePortableProfileState('stale-tree'), /stale npm\/source tree/)
    assert.match(describePortableProfileState('stale-link'), /stale link/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
