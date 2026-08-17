import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const STATE_FILE = 'install-state.json'
const LOCK_FILE = 'update.lock'

export function readInstallState(installRoot) {
  const statePath = join(installRoot, STATE_FILE)
  if (!existsSync(statePath)) {
    return {
      schemaVersion: 1,
      currentVersion: null,
      previousVersion: null,
      installedAt: null,
      updatedAt: null,
      openTransaction: null,
      verifiedArtifacts: {},
    }
  }
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8'))
    return {
      schemaVersion: 1,
      currentVersion: raw.currentVersion || null,
      previousVersion: raw.previousVersion || null,
      installedAt: raw.installedAt || null,
      updatedAt: raw.updatedAt || null,
      openTransaction: raw.openTransaction || null,
      verifiedArtifacts: raw.verifiedArtifacts || {},
    }
  } catch {
    throw new Error(`cannot parse ${statePath}`)
  }
}

export function writeInstallState(installRoot, state) {
  mkdirSync(installRoot, { recursive: true })
  const statePath = join(installRoot, STATE_FILE)
  const tempPath = join(installRoot, `${STATE_FILE}.tmp.${Date.now()}`)
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(tempPath, statePath)
}

export function acquireInstallLock(installRoot) {
  mkdirSync(installRoot, { recursive: true })
  const lockPath = join(installRoot, LOCK_FILE)
  if (existsSync(lockPath)) {
    let pid = null
    try {
      const lockData = JSON.parse(readFileSync(lockPath, 'utf8'))
      pid = lockData.pid
    } catch {}

    // Check if process is alive
    if (pid && typeof pid === 'number') {
      try {
        process.kill(pid, 0)
        throw new Error(`install lock is held by another process (PID ${pid})`)
      } catch (err) {
        if (err.code === 'EPERM')
          throw new Error(`install lock is held by another process (PID ${pid})`)
        if (err.code === 'ESRCH') {
          // Process is dead, remove stale lock
          rmSync(lockPath, { force: true })
        } else {
          throw err
        }
      }
    } else {
      rmSync(lockPath, { force: true })
    }
  }

  const payload = { pid: process.pid, createdAt: new Date().toISOString() }
  writeFileSync(lockPath, JSON.stringify(payload), { flag: 'wx', mode: 0o600 })

  return {
    release: () => {
      try {
        if (existsSync(lockPath)) rmSync(lockPath, { force: true })
      } catch {}
    },
  }
}

function atomicSymlink(installRoot, targetRelative, linkName) {
  const finalLinkPath = join(installRoot, linkName)
  const tempLinkPath = join(installRoot, `${linkName}.tmp.${Date.now()}`)
  try {
    unlinkSync(tempLinkPath)
  } catch {}
  symlinkSync(targetRelative, tempLinkPath)
  renameSync(tempLinkPath, finalLinkPath)
}

export function reconcileTransactions(installRoot) {
  const state = readInstallState(installRoot)
  if (!state.openTransaction) {
    return { recovered: false, activeVersion: state.currentVersion }
  }

  const currentLink = join(installRoot, 'current')
  let currentTargetVersion = null
  if (existsSync(currentLink)) {
    try {
      const rawTarget = readlinkSync(currentLink)
      currentTargetVersion = rawTarget.replace(/^versions\//, '')
    } catch {}
  }

  const tx = state.openTransaction
  let resolvedCurrent = state.currentVersion
  let resolvedPrevious = state.previousVersion

  if (currentTargetVersion === tx.candidateVersion) {
    // Current switch succeeded
    resolvedCurrent = tx.candidateVersion
    resolvedPrevious = tx.oldCurrent
  } else if (currentTargetVersion === tx.oldCurrent) {
    // Current switch never completed
    resolvedCurrent = tx.oldCurrent
    resolvedPrevious = tx.oldPrevious
    if (resolvedPrevious) {
      atomicSymlink(installRoot, `versions/${resolvedPrevious}`, 'previous')
    }
  }

  const nextState = {
    ...state,
    currentVersion: resolvedCurrent,
    previousVersion: resolvedPrevious,
    updatedAt: new Date().toISOString(),
    openTransaction: null,
  }
  writeInstallState(installRoot, nextState)
  return { recovered: true, activeVersion: resolvedCurrent }
}

export function beginInstallTransaction(installRoot, tx) {
  const state = readInstallState(installRoot)
  const nextState = {
    ...state,
    openTransaction: {
      op: tx.op,
      candidateVersion: tx.candidateVersion,
      oldCurrent: tx.oldCurrent,
      oldPrevious: tx.oldPrevious,
      startedAt: new Date().toISOString(),
    },
  }
  writeInstallState(installRoot, nextState)
}

export function commitInstallTransaction(installRoot, newCurrentVersion, artifactRecord = null) {
  const state = readInstallState(installRoot)
  const oldCurrent = state.currentVersion

  // 1. Link previous
  if (oldCurrent && oldCurrent !== newCurrentVersion) {
    atomicSymlink(installRoot, `versions/${oldCurrent}`, 'previous')
  }

  // 2. Link current
  atomicSymlink(installRoot, `versions/${newCurrentVersion}`, 'current')

  // 3. Update state
  const nextArtifacts = { ...state.verifiedArtifacts }
  if (artifactRecord) {
    nextArtifacts[newCurrentVersion] = artifactRecord
  }

  const nextState = {
    schemaVersion: 1,
    currentVersion: newCurrentVersion,
    previousVersion:
      oldCurrent && oldCurrent !== newCurrentVersion ? oldCurrent : state.previousVersion,
    installedAt: state.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    openTransaction: null,
    verifiedArtifacts: nextArtifacts,
  }
  writeInstallState(installRoot, nextState)
}

export function rollbackToPreviousVersion(installRoot) {
  const state = readInstallState(installRoot)
  const current = state.currentVersion
  const previous = state.previousVersion
  if (!previous) {
    throw new Error('no rollback target available: no previous version is recorded')
  }

  const previousDir = join(installRoot, 'versions', previous)
  if (!existsSync(previousDir)) {
    throw new Error(`cannot rollback: version directory ${previousDir} is missing`)
  }

  beginInstallTransaction(installRoot, {
    op: 'rollback',
    candidateVersion: previous,
    oldCurrent: current,
    oldPrevious: previous,
  })

  // Swap links: current -> previous version, previous -> old current version
  atomicSymlink(installRoot, `versions/${current}`, 'previous')
  atomicSymlink(installRoot, `versions/${previous}`, 'current')

  const nextState = {
    ...state,
    currentVersion: previous,
    previousVersion: current,
    updatedAt: new Date().toISOString(),
    openTransaction: null,
  }
  writeInstallState(installRoot, nextState)
  return { from: current, to: previous }
}
