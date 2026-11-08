import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_GLB = join(ROOT, 'apps/maps/aim_sillos.glb')
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const { buildFetchManifest } = await import(pathToFileURL(join(ROOT, 'src/static/FetchManifest.js')).href)

const sandbox = mkdtempSync(join(tmpdir(), 'spoint-fetch-manifest-'))
const project = join(sandbox, 'project')
const sdkRoot = join(sandbox, 'sdk')
const outside = join(sandbox, 'outside')
mkdirSync(project)
mkdirSync(sdkRoot)
mkdirSync(outside)
copyFileSync(SAMPLE_GLB, join(outside, 'secret.glb'))
copyFileSync(SAMPLE_GLB, join(project, 'real.glb'))
copyFileSync(SAMPLE_GLB, join(sdkRoot, 'shared.glb'))
symlinkSync(join(outside, 'secret.glb'), join(project, 'link.glb'))
symlinkSync(outside, join(project, 'outdir'))

let caseNo = 0
const manifestFor = async (model) => {
  caseNo += 1
  const worldDef = { entities: [{ id: 'e' + caseNo, model, position: [0, 0, 0] }] }
  return buildFetchManifest('fetch-manifest-witness-' + caseNo, worldDef, project, sdkRoot)
}
const modelEntries = (m) => m.entries.filter((e) => e.kind === 'model')
const outsideCaches = () => ['.glb-cache', '.ktx2-cache', '.progressive-cache'].filter((d) => existsSync(join(outside, d)))

try {
  const real = await manifestFor('real.glb')
  check('control: a model inside the project root is listed in the manifest', modelEntries(real).some((e) => e.url === '/real.glb' && e.byteSize > 0), `entries=${real.entries.length}`)

  const shared = await manifestFor('shared.glb')
  check('control: a model that lives only under the sdk root is listed through the sdk root fallback', modelEntries(shared).some((e) => e.url === '/shared.glb'), `entries=${shared.entries.length}`)

  const sourceBefore = readFileSync(join(outside, 'secret.glb'))
  const fileLink = await manifestFor('link.glb')
  check('a model that is a symlink to a file outside the project root is not listed, so its size is not disclosed', modelEntries(fileLink).length === 0, `entries=${JSON.stringify(fileLink.entries.map((e) => [e.url, e.byteSize]))}`)

  const dirLink = await manifestFor('outdir/secret.glb')
  check('a model reached through a symlinked directory outside the project root is not listed', modelEntries(dirLink).length === 0, `entries=${JSON.stringify(dirLink.entries.map((e) => [e.url, e.byteSize]))}`)

  const dotdot = await manifestFor('../outside/secret.glb')
  check('a model path with ../ that leaves the project root is not listed', modelEntries(dotdot).length === 0, `entries=${JSON.stringify(dotdot.entries.map((e) => [e.url, e.byteSize]))}`)

  check('no transform or ktx2 cache is written outside the project root by a manifest build', outsideCaches().length === 0, `outside caches=${outsideCaches().join(',') || 'none'}`)
  check('the source outside the project root is not modified by a manifest build', readFileSync(join(outside, 'secret.glb')).equals(sourceBefore))
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  process.exit(1)
}
console.log('RESULT: PASS fetch manifest lists only models whose resolved path and realpath stay under the project or sdk root, and builds no cache outside them')
process.exit(0)
