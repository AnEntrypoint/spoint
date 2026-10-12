#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const GATE_REL = join('scripts', 'check-cache-keys.mjs')
const SOURCE_ARTIFACT_REL = join('apps', 'world', 'tps-game.hf')
const INJECT_REL = join('packages', 'mapspinner', 'baked', 'witness-scope.hf')
const TEMP_INDEX_REL = join('.gm', 'tmp', 'check-cache-keys-scope.index')
const TRACKED_COUNT_MARKER = 'shipped .hf artifact(s)'

const tempIndex = join(ROOT, TEMP_INDEX_REL)
const injectPath = join(ROOT, INJECT_REL)
let failures = 0

function expect(label, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failures += 1
}

function git(args, env = process.env) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
}

function runGate(env) {
  const r = spawnSync(process.execPath, [GATE_REL], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  return { exit: r.status, out }
}

function verifiedCount(out) {
  const line = out.split('\n').find(l => l.includes(TRACKED_COUNT_MARKER)) || ''
  const m = line.match(/verifying (\d+)/)
  return m ? Number(m[1]) : null
}

function staleCopyOf(sourcePath, targetPath, currentVersion) {
  const buf = readFileSync(sourcePath)
  const needle = Buffer.from(currentVersion, 'utf8')
  const hits = []
  for (let at = buf.indexOf(needle); at !== -1; at = buf.indexOf(needle, at + 1)) hits.push(at)
  const stale = 'f'.repeat(currentVersion.length)
  if (hits.length !== 1) return { error: `code version ${currentVersion} occurs ${hits.length} time(s) in ${sourcePath}, cannot corrupt in place` }
  if (stale === currentVersion) return { error: `cannot forge a stale version distinct from ${currentVersion}` }
  copyFileSync(sourcePath, targetPath)
  const target = readFileSync(targetPath)
  Buffer.from(stale, 'utf8').copy(target, hits[0])
  writeFileSync(targetPath, target)
  return { stale, offset: hits[0] }
}

async function main() {
  const toplevel = resolve(git(['rev-parse', '--show-toplevel']).trim())
  if (toplevel.toLowerCase() !== ROOT.toLowerCase()) {
    console.error(`[FAIL] this witness must run from the main checkout (${ROOT}), git toplevel is ${toplevel}`)
    process.exit(1)
  }

  // The gate this witness widens reads content from the WORK TREE and its tracked
  // set from the INDEX. So the scenario is reproduced in the shared tree with a
  // throwaway index: GIT_INDEX_FILE makes "one more .hf is tracked" true for the
  // gate alone, and the shared index is never written, so no second checkout is
  // materialised and no lane's staging is disturbed.
  //
  // Local HEAD is not an alternative source for either half. It lags remote main
  // by every path-scoped publish and can hold a re-baked closure next to the .hf
  // it replaced, an internally inconsistent tree nobody shipped; building it made
  // "the gate is green on a clean tree" fail over two HEAD-only code versions.
  rmSync(tempIndex, { force: true })
  rmSync(injectPath, { force: true })
  mkdirSync(dirname(tempIndex), { recursive: true })
  const sharedIndex = resolve(ROOT, git(['rev-parse', '--git-path', 'index']).trim())
  copyFileSync(sharedIndex, tempIndex)
  const tempEnv = { ...process.env, GIT_INDEX_FILE: tempIndex }
  const tempGit = (args) => git(args, tempEnv)
  // git speaks forward slashes however the platform spells a path, so an index
  // entry only compares against a join()ed path once both use one separator.
  const trackedHf = () => tempGit(['ls-files', '--cached', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter(p => p.endsWith('.hf'))
    .map(p => p.split('/').join(sep))

  try {
    for (const rel of trackedHf()) {
      if (rel !== SOURCE_ARTIFACT_REL) tempGit(['update-index', '--force-remove', '--', rel])
    }
    const baseline = trackedHf()
    expect(
      `the scenario starts with ${SOURCE_ARTIFACT_REL} as the only tracked .hf`,
      baseline.length === 1 && baseline[0] === SOURCE_ARTIFACT_REL,
      `tracked .hf: ${baseline.join(', ') || '(none)'}`,
    )

    const { decodeHeightfield } = await import('mapspinner/heightfield-codec')
    const fresh = decodeHeightfield(toArrayBuffer(readFileSync(join(ROOT, SOURCE_ARTIFACT_REL))))
    if (!fresh?.codeVersion) {
      console.error(`[FAIL] ${SOURCE_ARTIFACT_REL} does not decode to a header carrying a codeVersion`)
      process.exit(1)
    }
    mkdirSync(dirname(injectPath), { recursive: true })
    const forged = staleCopyOf(join(ROOT, SOURCE_ARTIFACT_REL), injectPath, fresh.codeVersion)
    if (forged.error) {
      console.error(`[FAIL] ${forged.error}`)
      process.exit(1)
    }
    const corrupted = decodeHeightfield(toArrayBuffer(readFileSync(injectPath)))
    expect(
      `forged artifact decodes with codeVersion ${forged.stale} (tree bakes ${fresh.codeVersion})`,
      corrupted?.codeVersion === forged.stale,
      `offset ${forged.offset} of ${INJECT_REL}`,
    )
    tempGit(['add', '--force', '--', INJECT_REL.replace(/\\/g, '/')])
    const tracked = tempGit(['ls-files', '--cached', '--', INJECT_REL.replace(/\\/g, '/')]).trim()
    expect(`git tracks ${INJECT_REL} outside apps${sep}world`, tracked.length > 0, `ls-files -> "${tracked}"`)

    const dirty = runGate(tempEnv)
    expect(
      `the shipped gate verifies every tracked .hf, including ${INJECT_REL} outside apps${sep}world`,
      dirty.exit !== 0 && verifiedCount(dirty.out) === 2,
      `exit ${dirty.exit}, verifying ${verifiedCount(dirty.out)} artifact(s) of the 2 tracked`,
    )
    expect(
      `the shipped gate names ${INJECT_REL} and both code versions`,
      dirty.out.includes(INJECT_REL) && dirty.out.includes(forged.stale) && dirty.out.includes(fresh.codeVersion),
      dirty.out.split('\n').filter(l => l.includes(INJECT_REL)).join(' | ') || 'no line naming the injected artifact',
    )

    rmSync(injectPath, { force: true })
    tempGit(['update-index', '--force-remove', '--', INJECT_REL.replace(/\\/g, '/')])
    const clean = runGate(tempEnv)
    expect(
      `widened gate is green again once ${INJECT_REL} is gone`,
      clean.exit === 0 && verifiedCount(clean.out) === 1,
      `exit ${clean.exit}, verifying ${verifiedCount(clean.out)} artifact(s) of the 1 remaining`,
    )
    const baselineLine = clean.out.split('\n').find(l => l.includes(SOURCE_ARTIFACT_REL)) || ''
    expect(
      `widened gate still reports ${SOURCE_ARTIFACT_REL} as matching`,
      baselineLine.includes('matches this tree'),
      baselineLine.trim(),
    )
  } finally {
    rmSync(injectPath, { force: true })
    rmSync(tempIndex, { force: true })
  }

  expect(`the shared work tree no longer holds ${INJECT_REL}`, !existsSync(injectPath))
  expect(`throwaway index ${TEMP_INDEX_REL} removed`, !existsSync(tempIndex))
  expect(
    `the shared index never gained ${INJECT_REL}`,
    git(['ls-files', '--cached', '--', INJECT_REL.replace(/\\/g, '/')]).trim() === '',
    `ls-files -> "${git(['ls-files', '--cached', '--', INJECT_REL.replace(/\\/g, '/')]).trim()}"`,
  )
  console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} check(s))`)
  process.exit(failures === 0 ? 0 : 1)
}

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

main().catch(e => {
  console.error(`[FAIL] witness threw: ${e?.stack || e}`)
  rmSync(injectPath, { force: true })
  rmSync(tempIndex, { force: true })
  process.exit(1)
})
