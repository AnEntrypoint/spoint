import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, dirname, join } from 'node:path'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODULE = process.env.EXACT_PATCH_FRAME_MODULE
  ? resolve(process.env.EXACT_PATCH_FRAME_MODULE)
  : resolve(REPO, 'client/core/ExactPatchFrame.js')
const RUN_LABEL = (process.env.WITNESS_RUN_LABEL || 'honest').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'honest'
const WITNESS_ID = 'witness-gap-ClientCoreExactPatchFrame'
const SCRIPT = 'scripts/client-core-exact-patch-frame-witness.mjs'
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

function runChecks(M) {
  const make = M.createExactPatchFrame

  guarded('E01-export', () => ({ ok: typeof make === 'function', detail: `createExactPatchFrame typeof=${typeof make}` }))

  guarded('E02-exact-handle-shape-and-prototype-link', () => {
    const frame = { _patchHeightOrNull: () => 1 }
    const h = make(frame)
    const shape = typeof h.beginChunk === 'function' && typeof h.prefetchChunk === 'function' && 'missing' in h
    const linked = h.placementFrame !== frame && Object.getPrototypeOf(h.placementFrame) === frame
    return { ok: shape && linked, detail: `shape=${shape} linked=${linked}` }
  })

  guarded('E03-exact-forwards-sample-and-arguments', () => {
    const calls = []
    const frame = { _patchHeightOrNull: (x, z) => { calls.push([x, z]); return x * 10 + z } }
    const h = make(frame)
    const y = h.placementFrame.groundHeightLocal(3, 4)
    const ok = y === 34 && calls.length === 1 && calls[0][0] === 3 && calls[0][1] === 4 && h.missing === false
    return { ok, detail: `y=${y} calls=${calls.length} missing=${h.missing}` }
  })

  guarded('E04-null-sample-throws-NoGroundHeightError-and-marks-missing', () => {
    const h = make({ _patchHeightOrNull: () => null })
    const before = h.missing
    let name = 'none'
    try { h.placementFrame.groundHeightLocal(0, 0) } catch (e) { name = e.name }
    const ok = before === false && name === 'NoGroundHeightError' && h.missing === true
    return { ok, detail: `before=${before} threw=${name} after=${h.missing}` }
  })

  guarded('E05-missing-sticky-until-beginChunk', () => {
    let next = null
    const h = make({ _patchHeightOrNull: () => next })
    try { h.placementFrame.groundHeightLocal(0, 0) } catch (_) {}
    next = 7
    const y = h.placementFrame.groundHeightLocal(1, 1)
    const sticky = h.missing === true && y === 7
    h.beginChunk()
    const reset = h.missing === false
    return { ok: sticky && reset, detail: `sticky=${sticky} y=${y} reset_after_beginChunk=${reset}` }
  })

  guarded('E06-zero-sample-is-a-value-not-missing', () => {
    const h = make({ _patchHeightOrNull: () => 0 })
    const y = h.placementFrame.groundHeightLocal(5, 5)
    const ok = Object.is(y, 0) && h.missing === false
    return { ok, detail: `y=${y} missing=${h.missing}` }
  })

  guarded('E07-placement-inherits-frame-state-live', () => {
    const frame = { _patchHeightOrNull: () => 1, scale: 2, describe() { return 'base' } }
    const h = make(frame)
    const inherited = h.placementFrame.scale === 2 && h.placementFrame.describe() === 'base'
    frame.scale = 5
    const live = h.placementFrame.scale === 5
    return { ok: inherited && live, detail: `inherited=${inherited} live=${live}` }
  })

  guarded('E08-wrapper-leaves-frame-method-untouched', () => {
    const original = () => 3
    const frame = { _patchHeightOrNull: () => 1, groundHeightLocal: original }
    const h = make(frame)
    h.placementFrame.groundHeightLocal(0, 0)
    const ok = frame.groundHeightLocal === original
    return { ok, detail: `frame_method_same=${ok}` }
  })

  guarded('E09-absent-hook-passes-frame-through', () => {
    const frame = { groundHeightLocal: () => 9 }
    const h = make(frame)
    const ok = h.placementFrame === frame && h.placementFrame.groundHeightLocal(0, 0) === 9 && h.missing === false
    return { ok, detail: `identity=${h.placementFrame === frame} missing=${h.missing}` }
  })

  guarded('E10-prefetch-forwards-args-with-live-hook', () => {
    const frame = { _patchHeightOrNull: () => 1 }
    const h = make(frame)
    const calls = []
    frame._patchPrefetch = (cx, cz) => { calls.push([cx, cz]) }
    h.prefetchChunk(5, -7)
    const ok = calls.length === 1 && calls[0][0] === 5 && calls[0][1] === -7
    return { ok, detail: `calls=${JSON.stringify(calls)}` }
  })

  guarded('E11-prefetch-without-hook-is-noop', () => {
    const exact = make({ _patchHeightOrNull: () => 1 })
    const passthrough = make({})
    const r1 = exact.prefetchChunk(1, 2)
    const r2 = passthrough.prefetchChunk(3, 4)
    return { ok: r1 === undefined && r2 === undefined, detail: `returns=${r1},${r2}` }
  })

  guarded('E12-handles-keep-independent-missing-state', () => {
    const frame = { _patchHeightOrNull: () => null }
    const a = make(frame)
    const b = make(frame)
    try { a.placementFrame.groundHeightLocal(0, 0) } catch (_) {}
    const ok = a.missing === true && b.missing === false
    return { ok, detail: `a_missing=${a.missing} b_missing=${b.missing}` }
  })

  guarded('E13-sample-reads-hook-at-call-time', () => {
    const frame = { _patchHeightOrNull: () => 1 }
    const h = make(frame)
    frame._patchHeightOrNull = () => 42
    const y = h.placementFrame.groundHeightLocal(0, 0)
    return { ok: y === 42, detail: `y=${y}` }
  })
}

function finish(moduleSha) {
  const failed = results.filter((ok) => !ok).length
  const pass = results.length > 0 && failed === 0
  const resultLine = `RESULT: ${pass ? 'PASS' : 'FAIL'} checks=${results.length} failed=${failed}`
  const exitCode = pass ? 0 : 1
  const text = [
    `witness: ${WITNESS_ID}`,
    `script: ${SCRIPT}`,
    `run: ${RUN_LABEL}`,
    `ts: ${ts}`,
    `module: ${MODULE}`,
    `module_sha256: ${moduleSha}`,
    ...lines,
    resultLine,
  ].join('\n') + '\n'
  const outSha = sha256(text)
  const outRel = `.gm/witness-out/${outName}`
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, outName), text, { encoding: 'utf8', flag: 'wx' })
  appendFileSync(LOG_PATH, `${ts} | ${SCRIPT} | exit=${exitCode} | ${resultLine} | run=${RUN_LABEL} | module=${MODULE} | module_sha256=${moduleSha} | out=${outRel} | out_sha256=${outSha}\n`, 'utf8')
  process.stdout.write(text)
  process.exitCode = exitCode
}

async function main() {
  const present = existsSync(MODULE)
  const moduleSha = present ? sha256(readFileSync(MODULE)) : 'none'
  record('M00-module-path', present, present ? `present ${MODULE}` : `module path does not exist: ${MODULE}`)
  if (present) {
    let M = null
    try {
      M = await import(pathToFileURL(MODULE).href)
      record('M01-module-import', true, 'imported under node')
    } catch (err) {
      record('M01-module-import', false, `import failed: ${err && err.message}`)
    }
    if (M) runChecks(M)
  }
  finish(moduleSha)
}

main().catch((err) => {
  process.stdout.write(`reason: witness crashed: ${err && err.message}\nRESULT: FAIL checks=0 failed=1\n`)
  process.exitCode = 1
})
