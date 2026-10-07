#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const GATE_REL = join('scripts', 'check-cache-keys.mjs')
const SOURCE_ARTIFACT_REL = join('apps', 'world', 'tps-game.hf')
const INJECT_REL = join('packages', 'mapspinner', 'baked', 'witness-scope.hf')
const WORKTREE_REL = '.check-cache-keys-scope-worktree'
const TRACKED_COUNT_MARKER = 'shipped .hf artifact(s)'

const worktree = join(ROOT, WORKTREE_REL)
let failures = 0

function expect(label, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failures += 1
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

function runGate(cwd) {
  const r = spawnSync(process.execPath, [GATE_REL], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  return { exit: r.status, out }
}

function verifiedCount(out) {
  const line = out.split('\n').find(l => l.includes(TRACKED_COUNT_MARKER)) || ''
  const m = line.match(/verifying (\d+)/)
  return m ? Number(m[1]) : null
}

function teardown() {
  if (!existsSync(worktree)) return
  try {
    git(['worktree', 'remove', '--force', worktree], ROOT)
  } catch (e) {
    rmSync(worktree, { recursive: true, force: true })
    git(['worktree', 'prune'], ROOT)
  }
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
  const toplevel = resolve(git(['rev-parse', '--show-toplevel'], ROOT).trim())
  if (toplevel.toLowerCase() !== ROOT.toLowerCase()) {
    console.error(`[FAIL] this witness must run from the main checkout (${ROOT}), git toplevel is ${toplevel}`)
    process.exit(1)
  }
  const mainInstallMarker = join(ROOT, 'node_modules', '.package-lock.json')
  const mainWasInstalled = existsSync(mainInstallMarker)

  teardown()
  git(['worktree', 'add', '--detach', worktree, 'HEAD'], ROOT)
  try {
    const headGate = join(worktree, GATE_REL)
    const widenedGate = join(ROOT, GATE_REL)
    const sourceArtifact = join(worktree, SOURCE_ARTIFACT_REL)
    const injectArtifact = join(worktree, INJECT_REL)
    mkdirSync(dirname(injectArtifact), { recursive: true })

    const { decodeHeightfield } = await import('mapspinner/heightfield-codec')
    const fresh = decodeHeightfield(toArrayBuffer(readFileSync(sourceArtifact)))
    if (!fresh?.codeVersion) {
      console.error(`[FAIL] ${SOURCE_ARTIFACT_REL} does not decode to a header carrying a codeVersion`)
      process.exit(1)
    }
    const forged = staleCopyOf(sourceArtifact, injectArtifact, fresh.codeVersion)
    if (forged.error) {
      console.error(`[FAIL] ${forged.error}`)
      process.exit(1)
    }
    const corrupted = decodeHeightfield(toArrayBuffer(readFileSync(injectArtifact)))
    expect(
      `forged artifact decodes with codeVersion ${forged.stale} (tree bakes ${fresh.codeVersion})`,
      corrupted?.codeVersion === forged.stale,
      `offset ${forged.offset} of ${INJECT_REL}`,
    )
    git(['add', '--', INJECT_REL.replace(/\\/g, '/')], worktree)
    const tracked = git(['ls-files', '--cached', '--', INJECT_REL.replace(/\\/g, '/')], worktree).trim()
    expect(`git tracks ${INJECT_REL} outside apps${sep}world`, tracked.length > 0, `ls-files -> "${tracked}"`)

    const clean = runGate(worktree)
    expect(
      `the shipped gate verifies every tracked .hf, including ${INJECT_REL} outside apps${sep}world`,
      clean.exit !== 0 && verifiedCount(clean.out) === 2,
      `exit ${clean.exit}, verifying ${verifiedCount(clean.out)} artifact(s) of the 2 tracked`,
    )
    expect(
      `the shipped gate names ${INJECT_REL} and both code versions`,
      clean.out.includes(INJECT_REL) && clean.out.includes(forged.stale) && clean.out.includes(fresh.codeVersion),
      clean.out.split('\n').filter(l => l.includes(INJECT_REL)).join(' | ') || 'no line naming the injected artifact',
    )

    rmSync(injectArtifact, { force: true })
    git(['rm', '--cached', '--quiet', '--', INJECT_REL.replace(/\\/g, '/')], worktree)
    const restored = runGate(worktree)
    expect(
      `widened gate is green again once ${INJECT_REL} is gone`,
      restored.exit === 0 && verifiedCount(restored.out) === 1,
      `exit ${restored.exit}, verifying ${verifiedCount(restored.out)} artifact(s) of the 1 remaining`,
    )
    const baselineLine = restored.out.split('\n').find(l => l.includes(SOURCE_ARTIFACT_REL)) || ''
    expect(
      `widened gate still reports ${SOURCE_ARTIFACT_REL} as matching`,
      baselineLine.includes('matches this tree'),
      baselineLine.trim(),
    )
  } finally {
    teardown()
  }
  expect(`throwaway worktree ${WORKTREE_REL} removed`, !existsSync(worktree))
  expect(
    'main node_modules intact',
    !mainWasInstalled || existsSync(mainInstallMarker),
    mainInstallMarker,
  )
  console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} check(s))`)
  process.exit(failures === 0 ? 0 : 1)
}

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

main().catch(e => {
  console.error(`[FAIL] witness threw: ${e?.stack || e}`)
  teardown()
  process.exit(1)
})
