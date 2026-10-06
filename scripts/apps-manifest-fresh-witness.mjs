#!/usr/bin/env node
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveAllAppNames, ensureAppsManifestFresh, appsManifestFingerprint } from '../src/apps/appsManifest.js'

const TAG = '[apps-manifest-fresh]'
const failures = []
function expect(cond, msg) {
  if (cond) return
  failures.push(msg)
  console.error(`${TAG} assertion failed: ${msg}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'spoint-apps-manifest-fresh-'))
const appsDir = join(scratch, 'apps')
const outFile = join(scratch, 'apps-manifest.json')
const depPath = join(appsDir, 'lib', 'shared-dep.js')
const appPath = join(appsDir, 'fresh-probe', 'index.js')

try {
  writeFileSync(join(scratch, 'package.json'), `{"type":"module"}\n`)
  mkdirSync(join(appsDir, 'lib'), { recursive: true })
  writeFileSync(depPath, `export const SHARED = 1\n`)
  mkdirSync(join(appsDir, 'fresh-probe'), { recursive: true })
  const depSpecifier = ['..', 'lib', 'shared-dep.js'].join('/')
  writeFileSync(appPath, `import { SHARED } from '${depSpecifier}'\nexport default { category: 'FreshProbe', server: { setup() { return SHARED } } }\n`)

  const dirs = [appsDir]
  expect(resolveAllAppNames(dirs).join(',') === 'fresh-probe', `the probe apps dir resolved to ${JSON.stringify(resolveAllAppNames(dirs))}, expected ["fresh-probe"]`)

  const log = []
  const first = await ensureAppsManifestFresh(outFile, dirs, { log: m => log.push(m), warn: m => log.push(m) })
  console.log(`${TAG} first ensure: ${JSON.stringify({ status: first.status, apps: first.apps, filesRead: first.filesRead, ms: first.ms })}`)
  expect(first.status === 'written', `the first ensure returned status "${first.status}", expected "written"`)
  expect(first.apps === 1, `the first ensure built ${first.apps} app(s), expected 1`)
  expect(existsSync(outFile), `no manifest was written to ${outFile}`)
  const firstJson = readFileSync(outFile, 'utf8')
  expect(firstJson.includes('SHARED = 1'), 'the written manifest does not carry the probe app source')
  expect(firstJson.includes('"fingerprint"'), 'the written manifest carries no fingerprint, so a later boot cannot tell fresh from stale')

  const second = await ensureAppsManifestFresh(outFile, dirs, { log: m => log.push(m), warn: m => log.push(m) })
  console.log(`${TAG} second ensure (unchanged tree): ${JSON.stringify({ status: second.status, apps: second.apps, filesRead: second.filesRead, ms: second.ms })}`)
  expect(second.status === 'fresh', `an unchanged tree returned status "${second.status}", expected "fresh" (the fast path would pay a rebuild on every boot)`)
  expect(existsSync(outFile), `the ensure deleted ${outFile} instead of leaving the fresh manifest served`)
  expect(readFileSync(outFile, 'utf8') === firstJson, 'an unchanged tree rewrote the manifest')

  writeFileSync(depPath, `export const SHARED = 2\n`)
  const changed = await ensureAppsManifestFresh(outFile, dirs, { log: m => log.push(m), warn: m => log.push(m) })
  console.log(`${TAG} third ensure (shared dep edited): ${JSON.stringify({ status: changed.status, apps: changed.apps, filesRead: changed.filesRead, ms: changed.ms })}`)
  expect(changed.status === 'refreshed', `an edited dependency returned status "${changed.status}", expected "refreshed" (the fast path would serve the pre-edit source)`)
  const changedJson = readFileSync(outFile, 'utf8')
  expect(changedJson.includes('SHARED = 2'), 'the refreshed manifest still carries the pre-edit dependency source')
  expect(!changedJson.includes('SHARED = 1'), 'the refreshed manifest still carries the pre-edit dependency source')

  const staleFingerprint = JSON.parse(changedJson)
  staleFingerprint.fingerprint = 'stale-fingerprint-from-an-older-build'
  writeFileSync(outFile, JSON.stringify(staleFingerprint, null, 2))
  const afterStale = await ensureAppsManifestFresh(outFile, dirs, { log: m => log.push(m), warn: m => log.push(m) })
  expect(afterStale.status === 'refreshed', `a manifest stamped with an older fingerprint returned status "${afterStale.status}", expected "refreshed"`)
  expect(readFileSync(outFile, 'utf8').includes('SHARED = 2'), 'the manifest was not rebuilt from the current tree after its fingerprint went stale')

  const fingerprint = appsManifestFingerprint(dirs)
  const fingerprintAgain = appsManifestFingerprint(dirs)
  expect(fingerprint.fingerprint === fingerprintAgain.fingerprint, 'the tree fingerprint is not deterministic across two reads')
  expect(fingerprint.filesRead >= 2, `the fingerprint read ${fingerprint.filesRead} file(s), expected the app entry and its dependency`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`${TAG} RESULT: FAIL -- ${failures[0]}`)
  process.exit(1)
}
console.log(`${TAG} RESULT: PASS -- the served manifest is fingerprinted, rebuilt when the tree changes and never deleted`)
