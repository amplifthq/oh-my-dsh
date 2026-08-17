import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  acquireInstallLock,
  beginInstallTransaction,
  commitInstallTransaction,
  readInstallState,
  reconcileTransactions,
  rollbackToPreviousVersion,
  writeInstallState,
} from '../bin/distribution-state.js'

test('install lock acquires, prevents double acquisition, and releases', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-state-lock-'))
  try {
    const lock1 = acquireInstallLock(root)
    assert.throws(() => acquireInstallLock(root), /install lock is held by another process/)
    lock1.release()

    // Can acquire again after release
    const lock2 = acquireInstallLock(root)
    lock2.release()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('atomic transaction switches current and previous symlinks and supports rollback', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-state-tx-'))
  try {
    const v1 = join(root, 'versions', '0.1.7')
    const v2 = join(root, 'versions', '0.2.0')
    mkdirSync(v1, { recursive: true })
    mkdirSync(v2, { recursive: true })

    // Simulate initial installation of v1
    beginInstallTransaction(root, {
      op: 'install',
      candidateVersion: '0.1.7',
      oldCurrent: null,
      oldPrevious: null,
    })
    commitInstallTransaction(root, '0.1.7')

    let state = readInstallState(root)
    assert.equal(state.currentVersion, '0.1.7')
    assert.equal(state.previousVersion, null)
    assert.equal(readlinkSync(join(root, 'current')), 'versions/0.1.7')

    // Simulate upgrade to v2
    beginInstallTransaction(root, {
      op: 'update',
      candidateVersion: '0.2.0',
      oldCurrent: '0.1.7',
      oldPrevious: null,
    })
    commitInstallTransaction(root, '0.2.0')

    state = readInstallState(root)
    assert.equal(state.currentVersion, '0.2.0')
    assert.equal(state.previousVersion, '0.1.7')
    assert.equal(readlinkSync(join(root, 'current')), 'versions/0.2.0')
    assert.equal(readlinkSync(join(root, 'previous')), 'versions/0.1.7')

    // Rollback to v1
    const roll = rollbackToPreviousVersion(root)
    assert.equal(roll.from, '0.2.0')
    assert.equal(roll.to, '0.1.7')

    state = readInstallState(root)
    assert.equal(state.currentVersion, '0.1.7')
    assert.equal(state.previousVersion, '0.2.0')
    assert.equal(readlinkSync(join(root, 'current')), 'versions/0.1.7')
    assert.equal(readlinkSync(join(root, 'previous')), 'versions/0.2.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reconcileTransactions cleans interrupted transactions based on actual symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-state-reconcile-'))
  try {
    const v1 = join(root, 'versions', '0.1.7')
    const v2 = join(root, 'versions', '0.2.0')
    mkdirSync(v1, { recursive: true })
    mkdirSync(v2, { recursive: true })

    // Initial state: current -> 0.1.7
    beginInstallTransaction(root, {
      op: 'install',
      candidateVersion: '0.1.7',
      oldCurrent: null,
      oldPrevious: null,
    })
    commitInstallTransaction(root, '0.1.7')

    // Simulate interrupted transaction before symlink swap
    writeInstallState(root, {
      schemaVersion: 1,
      currentVersion: '0.1.7',
      previousVersion: null,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      openTransaction: {
        op: 'update',
        candidateVersion: '0.2.0',
        oldCurrent: '0.1.7',
        oldPrevious: null,
        startedAt: new Date().toISOString(),
      },
    })

    const rec1 = reconcileTransactions(root)
    assert.equal(rec1.recovered, true)
    assert.equal(rec1.activeVersion, '0.1.7')
    const clearedState = readInstallState(root)
    assert.equal(clearedState.openTransaction, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reconcileTransactions removes a stale previous symlink when no previous version remains', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-state-stale-previous-'))
  try {
    mkdirSync(join(root, 'versions', '0.2.0'), { recursive: true })
    symlinkSync('versions/0.2.0', join(root, 'current'))
    symlinkSync('versions/missing', join(root, 'previous'))
    writeInstallState(root, {
      schemaVersion: 1,
      currentVersion: '0.2.0',
      previousVersion: null,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      openTransaction: {
        op: 'update',
        candidateVersion: '0.2.0',
        oldCurrent: null,
        oldPrevious: null,
        startedAt: new Date().toISOString(),
      },
      verifiedArtifacts: {},
    })

    const result = reconcileTransactions(root)
    assert.equal(result.recovered, true)
    assert.equal(existsSync(join(root, 'previous')), false)
    assert.throws(() => lstatSync(join(root, 'previous')), /ENOENT/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
