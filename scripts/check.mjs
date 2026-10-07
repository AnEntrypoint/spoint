import { readFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { checkAppImports } from './check-app-imports.mjs'
import { ensureWorkspaceLinks } from './ensure-workspace-links.mjs'

const execFileAsync = promisify(execFile)

const NO_GPU_WITNESSES = [
  { file: 'msgpack-negative-zero-witness.mjs' },
  { file: 'app-event-dispatch-error-witness.mjs', must: /\[PASS\]/ },
  { file: 'lattice-dir-cache-witness.mjs', must: /mismatch\(es\)/ },
  { file: 'lattice-ring-bound-witness.mjs' },
  { file: 'veg-painted-surface-witness.mjs' },
  { file: 'physics-body-pool-witness.mjs' },
  { file: 'physics-motion-recreate-witness.mjs' },
  { file: 'terrain-reseed-failure-witness.mjs' },
  { file: 'ep-progressive-lod-schema-witness.mjs' },
  { file: 'tps-game-player-movement-witness.mjs', must: /PASS: walked/ },
  { file: 'placement-climate-gate-witness.mjs', must: /CPU per chunk veg/ },
  { file: 'check-cache-keys-scope-witness.mjs', must: /verifying 2 artifact\(s\) of the 2 tracked/ },
  { file: 'edge-collider-draco-witness.mjs', must: /0 byte\(s\) written into the tracked tree/ },
]
const NO_GPU_WITNESS_TIMEOUT_MS = 120000
const SLOW_WITNESS_TIMEOUT_MS = 600000
const SLOW_NO_GPU_WITNESSES = [
  { file: 'collider-ring-scale-witness.mjs', must: /ms of uninterrupted work per 1000 placement\(s\) the ring scan examines/ },
  { file: 'collider-ring-boot-batches-witness.mjs', must: /ms per 1k operation\(s\) over \d+ operation\(s\)/ },
]
const NO_GPU_WITNESS_GPU_SURFACE = /cdp-browser|gpu-probe|gpu-eval|witnessGpu|gpuLaunchArgs|use-angle|adapter-luid|WebGLRenderer|WebGPURenderer/
const NO_GPU_VERDICT_RE = /^(?:\[[^\]]*\]\s*)?RESULT:\s+(PASS|FAIL)(?![A-Za-z0-9_])/
const NO_GPU_WITNESS_ECHO_LINES = 6

const ROOTS = ['src', 'client', 'apps', 'scripts', 'bin']
const SKIP_DIRS = new Set(['basis', 'draco', 'maps'])
const SKIP_VENDORED_FILE = /(\.min\.js$|basis_transcoder|draco_decoder|jolt-physics)/

function collect(out) {
  const raw = execFileSync('git', ['ls-files', '-z', '--cached', '--', ...ROOTS], { maxBuffer: 64 * 1024 * 1024 })
  for (const rel of raw.toString('utf8').split('\0')) {
    if (!rel) continue
    const ext = extname(rel)
    if (ext !== '.js' && ext !== '.mjs') continue
    if (SKIP_VENDORED_FILE.test(rel)) continue
    if (rel.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg))) continue
    out.push(rel)
  }
  return out
}

function noGpuVerdict(stdout) {
  let failing = null
  let passing = null
  for (const line of stdout.split('\n')) {
    const m = NO_GPU_VERDICT_RE.exec(line.trim())
    if (m === null) continue
    if (m[1] === 'FAIL') { if (failing === null) failing = line.trim() }
    else if (passing === null) passing = line.trim()
  }
  if (failing !== null) return { verdict: 'FAIL', line: failing }
  if (passing !== null) return { verdict: 'PASS', line: passing }
  return { verdict: null, line: null }
}

function tailLines(text, count) {
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '')
  return lines.slice(Math.max(0, lines.length - count))
}

async function main() {
  const files = []
  collect(files)

  const missingRoots = ROOTS.filter((r) => !existsSync(r))
  if (missingRoots.length) {
    console.error(`check: source root(s) absent, so ${files.length} file(s) were scanned: ${missingRoots.join(', ')}`)
    process.exit(1)
  }
  if (files.length === 0) {
    console.error(`check: 0 tracked source files collected from ${ROOTS.join(', ')} -- an empty parse scan is not a pass`)
    process.exit(1)
  }
  console.log(`check: parsing ${files.length} git-tracked source file(s) under ${ROOTS.join(', ')} (untracked scratch is not scanned)`)

  const failures = []

  const links = ensureWorkspaceLinks()
  for (const name of links.created) console.log(`check: workspace link node_modules/${name} was missing and is now restored`)
  for (const name of links.repaired) console.log(`check: workspace link node_modules/${name} pointed elsewhere and is now restored`)
  for (const detail of links.failed) failures.push(`workspace link ${detail} -- run: node scripts/ensure-workspace-links.mjs`)

  const MAX_PARALLEL_CHECKS = 16
  let idx = 0
  async function worker() {
    while (idx < files.length) {
      const file = files[idx++]
      try {
        const buf = readFileSync(file)
        if (buf.length && buf[buf.length - 1] === 0) {
          failures.push({ file, error: 'trailing NUL byte(s) - file is corrupted (Windows Edit/Write artifact)' })
          continue
        }
      } catch (e) {
        failures.push({ file, error: 'unreadable: ' + e.message })
        continue
      }
      try {
        await execFileAsync(process.execPath, ['--check', file])
      } catch (e) {
        failures.push({ file, error: (e.stderr || e.message || '').toString().split('\n').slice(0, 3).join(' ') })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_CHECKS, files.length) }, worker))

  if (failures.length) {
    console.error(`check: ${failures.length} of ${files.length} files failed to parse:`)
    for (const f of failures) console.error(`  ${f.file}: ${f.error}`)
    process.exit(1)
  }
  console.log(`check: ${files.length} source files parse cleanly`)

  const GUARDED = ['src/netcode/NetworkState.js', 'src/sdk/EditorHandlers.js', 'src/apps/AppContext.js']
  const guardFails = []
  if (GUARDED.length === 0) guardFails.push('no write-boundary file is guarded -- the guardrail is vacuous')
  for (const rel of GUARDED) {
    const full = join(...rel.split('/'))
    let txt = ''
    try { txt = readFileSync(full, 'utf8') } catch (e) {
      guardFails.push(`${rel}: unreadable (${e.message}) -- its NaN-poison guard was not verified`)
      continue
    }
    if (!/shared\/vecGuard/.test(txt)) {
      guardFails.push(`${rel}: accepts external transforms but no longer imports shared/vecGuard - NaN-poison guard removed`)
    }
  }
  if (guardFails.length) {
    console.error(`check: ${guardFails.length} transform-validation guardrail violation(s):`)
    for (const g of guardFails) console.error(`  ${g}`)
    process.exit(1)
  }
  console.log(`check: transform-validation guardrail intact (${GUARDED.length} write-boundary files)`)

  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/check-relative-imports.mjs'])
    for (const line of stdout.split('\n')) if (line.trim()) console.log(`check: ${line}`)
  } catch (e) {
    console.error('check: relative import resolution:', (e.stderr || e.message || '').toString().trim())
    process.exit(1)
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/check-cache-keys.mjs'])
    for (const line of stdout.split('\n')) if (line.trim()) console.log(line)
  } catch (e) {
    console.error('check: bake code-version closure:', (e.stderr || e.message || '').toString().trim())
    process.exit(1)
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/check-tsl-imports.mjs'])
    for (const line of stdout.split('\n')) if (line.trim()) console.log(`check: ${line}`)
  } catch (e) {
    console.error('check: three export-name resolution:', (e.stderr || e.message || '').toString().trim())
    process.exit(1)
  }
  try {
    await execFileAsync(process.execPath, ['scripts/bundle-apps-manifest.mjs', '--check'])
    console.log('check: apps-manifest.json is in sync with ./apps')
  } catch (e) {
    console.error('check: apps-manifest.json regeneration failed:', e.stderr || e.message)
    process.exit(1)
  }
  try {
    await execFileAsync(process.execPath, ['scripts/gen-sdk-typings.mjs', '--check'])
  } catch (e) {
    console.error('check: generated SDK typings drift:', (e.stderr || e.message || '').toString().trim())
    process.exit(1)
  }
  console.log('check: generated SDK typings match src/apps/AppContext.js')
  const imports = await checkAppImports()
  if (imports.problems.length) {
    console.error(`check: ${imports.problems.length} app import/asset resolution problem(s):`)
    for (const p of imports.problems) console.error(`  ${p}`)
    process.exit(1)
  }
  if (NO_GPU_WITNESSES.length === 0 && SLOW_NO_GPU_WITNESSES.length === 0) {
    console.error('check: no gpu-free witness is listed, so the gpu-free witness arm proves nothing')
    process.exit(1)
  }
  let noGpuMs = 0
  async function runNoGpuWitnesses(list, timeoutMs) {
    for (const spec of list) {
      const rel = join('scripts', spec.file)
      let source = ''
      try {
        source = readFileSync(rel, 'utf8')
      } catch (e) {
        console.error(`check: gpu-free witness ${spec.file} is unreadable (${e.message}), so its assertions never ran`)
        process.exit(1)
      }
      const gpuHit = NO_GPU_WITNESS_GPU_SURFACE.exec(source)
      if (gpuHit !== null) {
        console.error(`check: gpu-free witness ${spec.file} reaches the "${gpuHit[0]}" surface, so it cannot run where CI has no GPU -- move it behind SPOINT_GPU_WITNESS`)
        process.exit(1)
      }
      const started = Date.now()
      let stdout = ''
      let code = 0
      let killed = false
      try {
        const done = await execFileAsync(process.execPath, [rel], { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs })
        stdout = done.stdout
      } catch (e) {
        stdout = (e && e.stdout) || ''
        code = Number.isInteger(e.code) ? e.code : 1
        killed = e.killed === true
      }
      const ms = Date.now() - started
      noGpuMs += ms
      const verdict = noGpuVerdict(stdout)
      const witnessFailures = []
      if (killed) witnessFailures.push(`ran past the ${timeoutMs / 1000} s cap and was killed`)
      if (code !== 0) witnessFailures.push(`exited ${code}`)
      if (verdict.verdict === 'FAIL') witnessFailures.push(`reported ${verdict.line}`)
      if (stdout.trim() === '') witnessFailures.push('printed nothing, so silence cannot be told apart from a witness that never asserted')
      if (spec.must && !spec.must.test(stdout)) witnessFailures.push(`printed no line matching ${spec.must}, so its assertions never ran`)
      if (witnessFailures.length > 0) {
        console.error(`check: gpu-free witness ${spec.file}: ${witnessFailures.join('; ')}`)
        for (const line of tailLines(stdout, NO_GPU_WITNESS_ECHO_LINES)) console.error(`  ${spec.file} out ${line}`)
        process.exit(1)
      }
      console.log(`check: gpu-free witness ${spec.file} ${(ms / 1000).toFixed(1)} s, exit 0, ${verdict.line ?? 'no RESULT: line, so exit 0 is the verdict'}`)
    }
  }
  await runNoGpuWitnesses(NO_GPU_WITNESSES, NO_GPU_WITNESS_TIMEOUT_MS)
  await runNoGpuWitnesses(SLOW_NO_GPU_WITNESSES, SLOW_WITNESS_TIMEOUT_MS)
  const noGpuCount = NO_GPU_WITNESSES.length + SLOW_NO_GPU_WITNESSES.length
  console.log(`check: ${noGpuCount} gpu-free witness(es) ran in ${(noGpuMs / 1000).toFixed(1)} s with no GPU required`)
  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/fire-witness-gate.mjs'], { maxBuffer: 16 * 1024 * 1024 })
    for (const line of stdout.split('\n')) if (line.trim()) console.log(`check: ${line}`)
  } catch (e) {
    const out = (e.stdout || '').toString()
    for (const line of out.split('\n')) if (line.trim()) console.error(`check: ${line}`)
    console.error('check: fire witnesses:', (e.stderr || e.message || '').toString().trim())
    process.exit(1)
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/check-frame-time-baselines.mjs'])
    for (const line of stdout.split('\n')) if (line.trim()) console.log(line)
  } catch (e) {
    console.error('check: frame-time baselines:', (e.stderr || e.stdout || e.message || '').toString().trim())
    process.exit(1)
  }
  const gpuArms = (process.env.SPOINT_GPU_WITNESS || '').split(',').map((s) => s.trim()).filter(Boolean)
  for (const gpu of gpuArms) {
    const keep = (line) => /^(\[veg-witness\]|RESULT:|  \[(PASS|FAIL)\])/.test(line)
    try {
      const { stdout } = await execFileAsync(process.execPath, ['scripts/veg-instance-browser-witness.mjs', `--gpu=${gpu}`, '--at=-15,-12.5', '--settle=15000', '--walk=45000'], { maxBuffer: 16 * 1024 * 1024 })
      for (const line of stdout.split('\n')) if (keep(line)) console.log(`check: ${line}`)
    } catch (e) {
      for (const line of ((e && e.stdout) || '').toString().split('\n')) if (keep(line)) console.error(`check: ${line}`)
      console.error(`check: vegetation browser witness on ${gpu}:`, (e.stderr || e.message || '').toString().trim())
      process.exit(1)
    }
  }
  console.log(`check: ${imports.appCount} apps resolve every import through the worker path, ${imports.assetCount} asset references exist`)
}

main().catch((e) => { console.error('check: harness error:', e); process.exit(2) })
