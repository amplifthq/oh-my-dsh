import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { generateFileManifest, verifyFileManifest } from '../bin/distribution-files.js'

test('generateFileManifest and verifyFileManifest detect matching, modified, missing, and extra files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-file-manifest-'))
  try {
    mkdirSync(join(root, 'bin'), { recursive: true })
    mkdirSync(join(root, 'app', 'dist'), { recursive: true })
    writeFileSync(join(root, 'bin', 'omd'), '#!/bin/sh\necho ok\n')
    writeFileSync(join(root, 'app', 'dist', 'index.js'), 'console.log("hello")\n')
    writeFileSync(join(root, 'distribution.json'), '{"schemaVersion":1}\n')

    const manifest = await generateFileManifest(root, { ignore: ['distribution-files.json'] })
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(typeof manifest.files['bin/omd'], 'string')
    assert.equal(typeof manifest.files['app/dist/index.js'], 'string')
    assert.equal(typeof manifest.files['distribution.json'], 'string')

    // Initial check: ok
    const cleanCheck = await verifyFileManifest(root, manifest)
    assert.equal(cleanCheck.ok, true)
    assert.deepEqual(cleanCheck.mismatches, [])
    assert.deepEqual(cleanCheck.missing, [])
    assert.deepEqual(cleanCheck.extra, [])

    // Modification
    writeFileSync(join(root, 'bin', 'omd'), '#!/bin/sh\necho modified\n')
    const modifiedCheck = await verifyFileManifest(root, manifest)
    assert.equal(modifiedCheck.ok, false)
    assert.deepEqual(modifiedCheck.mismatches, ['bin/omd'])

    // Missing file
    rmSync(join(root, 'app', 'dist', 'index.js'))
    const missingCheck = await verifyFileManifest(root, manifest)
    assert.equal(missingCheck.ok, false)
    assert.deepEqual(missingCheck.missing, ['app/dist/index.js'])

    // Extra file
    writeFileSync(join(root, 'extra.txt'), 'extra')
    const extraCheck = await verifyFileManifest(root, manifest)
    assert.equal(extraCheck.ok, false)
    assert.deepEqual(extraCheck.extra, ['extra.txt'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
