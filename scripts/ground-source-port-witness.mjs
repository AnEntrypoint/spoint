import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, dirname, join } from 'node:path'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT_MODULE = resolve(REPO, 'src/terrain/PlanetFrame.js')
const PATCH_MODULE = resolve(REPO, 'client/core/ExactPatchFrame.js')
const RUN_LABEL = (process.env.WITNESS_RUN_LABEL || 'honest').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'honest'
const WITNESS_ID = 'witness-gap-GroundSourcePort'
const SCRIPT = 'scripts/ground-source-port-witness.mjs'
const OUT_DIR = resolve(REPO, '.gm/witness-out')
const LOG_PATH = resolve(REPO, '.gm/witness-log.md')

const ts = new Date().toISOString()
const outName = `${WITNESS_ID}-${RUN_LABEL}-${ts.replace(/[-:.]/g, '')}.txt`
const lines = []
const results = []

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

function record(id, ok, detail) {
  results.push(ok === true)
  lines.push(`check ${id}: ${ok === true ? 'ok' : 'FAIL'} ${detail}`)
}

function guarded(id, fn) {
  try {
    const out = fn()
    record(id, out.ok, out.detail)
  } catch (err) {
    record(id, false, `threw ${err && err.message}`)
  }
}

function freshFrame(M, relief = 40, radius = 6371000) {
  const sampler = {
    radius,
    hashVersion: 7,
    heightAt: (d) => relief * Math.sin(d[0] * 3) * Math.cos(d[2] * 3),
  }
  return M.createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0 })
}

function runChecks(M, Patch) {
  const { SurfaceSolveError, guardedGroundHeight, NO_GROUND_HEIGHT } = M

  guarded('P01-port-names-the-cpu-source-at-construction', () => {
    const frame = freshFrame(M)
    const names = frame.groundSources
    const ok = frame.groundSource === 'cpu-solve' && names.length === 1 && names[0] === 'cpu-solve'
    return { ok, detail: `groundSource=${frame.groundSource} groundSources=${JSON.stringify(names)}` }
  })

  guarded('P02-cpu-source-solves-a-real-height', () => {
    const frame = freshFrame(M)
    const y = frame.groundHeightLocal(10, 20)
    return { ok: Number.isFinite(y), detail: `y=${y}` }
  })

  guarded('P03-cpu-source-throws-SurfaceSolveError-beyond-the-chart-radius', () => {
    const frame = freshFrame(M)
    let name = 'none'
    let isSolve = false
    try { frame.groundHeightLocal(9e9, 0) } catch (e) { name = e.name; isSolve = e instanceof SurfaceSolveError }
    return { ok: isSolve, detail: `threw=${name} instanceof SurfaceSolveError=${isSolve}` }
  })

  guarded('P04-port-installs-a-source-that-drops-yGuess-and-never-notices', () => {
    const frame = freshFrame(M)
    const twoArg = (x, z) => 1.5
    const installed = frame.registerGroundSource('patch-1arg', twoArg)
    const y = frame.groundHeightLocal(0, 0, 12)
    const ok = installed === 'patch-1arg' && frame.groundSource === 'patch-1arg' && y === 1.5 && twoArg.length === 2
    return { ok, detail: `installed=${installed} groundSource=${frame.groundSource} y(yGuess=12)=${y} arity=${twoArg.length}` }
  })

  guarded('P05-port-installs-a-source-that-returns-a-non-number', () => {
    const frame = freshFrame(M)
    frame.registerGroundSource('nan-src', () => NaN)
    const y = frame.groundHeightLocal(0, 0)
    return { ok: Number.isNaN(y), detail: `y=${y} (no throw)` }
  })

  guarded('P06-assignment-through-the-port-setter-names-the-source-substituted', () => {
    const frame = freshFrame(M)
    const fn = (x, z, yGuess) => (x + z) * 0 + (Number.isFinite(yGuess) ? yGuess : 0)
    frame.groundHeightLocal = fn
    const ok = frame.groundSource === 'substituted' && frame.groundSourceOf('substituted') === fn
    return { ok, detail: `groundSource=${frame.groundSource} groundSourceOf('substituted')===fn=${frame.groundSourceOf('substituted') === fn}` }
  })

  guarded('P07-assigning-the-original-cpu-source-restores-cpu-solve', () => {
    const frame = freshFrame(M)
    frame.groundHeightLocal = (x, z) => x + z
    const swapped = frame.groundSource
    frame.groundHeightLocal = frame.cpuGroundHeightLocal
    const ok = swapped === 'substituted' && frame.groundSource === 'cpu-solve' && frame.groundHeightLocal === frame.cpuGroundHeightLocal
    return { ok, detail: `swapped=${swapped} restored=${frame.groundSource} identity=${frame.groundHeightLocal === frame.cpuGroundHeightLocal}` }
  })

  guarded('P08-a-second-anonymous-source-clobbers-the-first-under-the-same-name', () => {
    const frame = freshFrame(M)
    const first = (x, z) => 1
    const second = (x, z) => 2
    frame.groundHeightLocal = first
    frame.groundHeightLocal = second
    const served = frame.groundSourceOf('substituted')
    const ok = served === second && served !== first && frame.groundSources.filter((n) => n === 'substituted').length === 1
    return { ok, detail: `groundSourceOf('substituted')===second=${served === second} names=${JSON.stringify(frame.groundSources)}` }
  })

  guarded('P09-a-prototype-linked-install-mutates-the-shared-frame', () => {
    const frame = freshFrame(M)
    frame._patchHeightOrNull = () => 3
    const h = Patch.createExactPatchFrame(frame)
    const own = Object.prototype.hasOwnProperty.call(h.placementFrame, 'groundHeightLocal')
    const shared = frame.groundHeightLocal !== frame.cpuGroundHeightLocal
    const ok = own === false && shared === true && frame.groundSource === 'substituted'
    return { ok, detail: `own_property=${own} shared_frame_swapped=${shared} frame.groundSource=${frame.groundSource}` }
  })

  guarded('P10-the-patch-adapter-reports-no-ground-as-NaN-not-SurfaceSolveError', () => {
    const frame = freshFrame(M)
    frame._patchHeightOrNull = () => null
    const h = Patch.createExactPatchFrame(frame)
    let y = 'threw'
    let threw = false
    try { y = h.placementFrame.groundHeightLocal(0, 0) } catch (e) { threw = true }
    const ok = threw === false && Number.isNaN(y) && h.missing === true
    return { ok, detail: `y=${y} threw=${threw} missing=${h.missing}` }
  })

  guarded('P11-guardedGroundHeight-converts-a-thrown-solve-error-to-null-but-passes-NaN-through', () => {
    const throwing = guardedGroundHeight('witness throwing source', () => { throw new SurfaceSolveError(1, 2, 1e-4, 64, 0.5) })
    const nanning = guardedGroundHeight('witness nan source', () => NaN)
    const a = throwing(1, 2)
    const b = nanning(1, 2)
    const ok = a === NO_GROUND_HEIGHT && a === null && Number.isNaN(b)
    return { ok, detail: `throwing(1,2)=${a} nanning(1,2)=${b}` }
  })

  guarded('P12-guardedGroundHeight-ignores-a-caller-supplied-fallback', () => {
    const withFallback = guardedGroundHeight('witness fallback source', () => { throw new SurfaceSolveError(1, 2, 1e-4, 64, 0.5) }, 0)
    const got = withFallback(1, 2)
    const ok = got === null
    return { ok, detail: `declared_arity=${guardedGroundHeight.length} got=${got} (caller asked for 0)` }
  })

  guarded('P13-groundSourceOf-rejects-a-name-the-port-never-served', () => {
    const frame = freshFrame(M)
    let threw = false
    let msg = 'none'
    try { frame.groundSourceOf('patch') } catch (e) { threw = true; msg = e.message }
    return { ok: threw, detail: `threw=${threw} message=${msg}` }
  })

  guarded('P14-the-registry-keeps-every-name-it-ever-served', () => {
    const frame = freshFrame(M)
    frame.registerGroundSource('a', (x, z) => 1)
    frame.registerGroundSource('b', (x, z) => 2)
    frame.groundHeightLocal = (x, z) => 3
    const names = frame.groundSources
    const ok = names.length === 4 && frame.groundSource === 'substituted' && frame.groundHeightLocal(0, 0) === 3
    return { ok, detail: `names=${JSON.stringify(names)} current=${frame.groundSource}` }
  })
}

function finish(portSha, patchSha) {
  const failed = results.filter((ok) => !ok).length
  const pass = results.length > 0 && failed === 0
  const resultLine = `RESULT: ${pass ? 'PASS' : 'FAIL'} checks=${results.length} failed=${failed}`
  const exitCode = pass ? 0 : 1
  const text = [
    `witness: ${WITNESS_ID}`,
    `script: ${SCRIPT}`,
    `run: ${RUN_LABEL}`,
    `ts: ${ts}`,
    `module: ${PORT_MODULE}`,
    `module_sha256: ${portSha}`,
    `module: ${PATCH_MODULE}`,
    `module_sha256: ${patchSha}`,
    ...lines,
    resultLine,
  ].join('\n') + '\n'
  const outSha = sha256(text)
  const outRel = `.gm/witness-out/${outName}`
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, outName), text, { encoding: 'utf8', flag: 'wx' })
  appendFileSync(LOG_PATH, `${ts} | ${SCRIPT} | exit=${exitCode} | ${resultLine} | run=${RUN_LABEL} | out=${outRel} | out_sha256=${outSha}\n`, 'utf8')
  process.stdout.write(text)
  process.exitCode = exitCode
}

async function main() {
  const shaOf = (p) => (existsSync(p) ? sha256(readFileSync(p)) : 'none')
  const portSha = shaOf(PORT_MODULE)
  const patchSha = shaOf(PATCH_MODULE)
  record('M00-port-module-path', existsSync(PORT_MODULE), existsSync(PORT_MODULE) ? `present ${PORT_MODULE}` : `module path does not exist: ${PORT_MODULE}`)
  record('M01-patch-module-path', existsSync(PATCH_MODULE), existsSync(PATCH_MODULE) ? `present ${PATCH_MODULE}` : `module path does not exist: ${PATCH_MODULE}`)
  let M = null
  let Patch = null
  try {
    M = await import(pathToFileURL(PORT_MODULE).href)
    record('M02-port-module-import', true, 'imported under node')
  } catch (err) {
    record('M02-port-module-import', false, `import failed: ${err && err.message}`)
  }
  try {
    Patch = await import(pathToFileURL(PATCH_MODULE).href)
    record('M03-patch-module-import', true, 'imported under node')
  } catch (err) {
    record('M03-patch-module-import', false, `import failed: ${err && err.message}`)
  }
  if (M && Patch) runChecks(M, Patch)
  finish(portSha, patchSha)
}

main().catch((err) => {
  process.stdout.write(`reason: witness crashed: ${err && err.message}\nRESULT: FAIL checks=0 failed=1\n`)
  process.exitCode = 1
})
