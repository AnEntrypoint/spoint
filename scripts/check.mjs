import { readFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { checkAppImports } from './check-app-imports.mjs'
import { ensureWorkspaceLinks } from './ensure-workspace-links.mjs'

const execFileAsync = promisify(execFile)

const NO_GPU_WITNESSES = [
  { file: 'msgpack-negative-zero-witness.mjs', must: /\[PASS\] scalar -0 round-trips[\s\S]*RESULT: PASS/ },
  { file: 'app-event-dispatch-error-witness.mjs', must: /RESULT: PASS -- 8 of 8 check\(s\) passed/ },
  { file: 'lattice-dir-cache-witness.mjs', must: /, 0 mismatch\(es\)[\s\S]*violations: 0 over [1-9]\d* key\(s\) in [1-9]\d* ring\(s\)[\s\S]*RESULT: PASS -- [1-9]\d* chunk key\(s\) agree and [1-9]\d* ring key\(s\) across [1-9]\d* ring\(s\)/ },
  { file: 'lattice-ring-bound-witness.mjs', must: /RESULT: PASS \(missing 0, beyond 0,/ },
  { file: 'veg-painted-surface-witness.mjs', must: /RESULT: PASS -- [1-9]\d* placement\(s\) over [1-9]\d* cell\(s\), of which [1-9]\d* snow-dominant carrying 0 and [1-9]\d* bare-sand carrying 0/ },
  { file: 'physics-body-pool-witness.mjs', must: /RESULT: PASS \([1-9]\d*\/[1-9]\d*\)/ },
  { file: 'physics-motion-recreate-witness.mjs', must: /RESULT: PASS \([1-9]\d*\/[1-9]\d*\)/ },
  { file: 'terrain-reseed-failure-witness.mjs', must: /\[reseed-witness\] [1-9]\d* passed, 0 failed[\s\S]*\[reseed-witness\] RESULT: PASS/ },
  { file: 'terrain-residency-seam-witness.mjs', must: /RESULT: PASS -- [1-9]\d* seam check\(s\) held over [1-9]\d* heightfield accessor read\(s\)/ },
  { file: 'spawn-clearance-witness.mjs', must: /RESULT: PASS -- [1-9]\d* intersecting candidate\(s\) across [1-9]\d* blocker height\(s\), 0 called clear/ },
  { file: 'prediction-wedge-witness.mjs', must: /\[wedge\] \{[^\n]*"arm":"kinematic-headon"[^\n]*"heldMaxPenetrationM":0,[^\n]*"wallPlaneTicks":0,[^\n]*\n[\s\S]*RESULT: PASS/ },
  { file: 'boot-failure-leak-witness.mjs', must: /MEASURED boot-failure-leak: 2 induced failed boot\(s\) \+ 1 control boot, handle census [1-9]\d* handle\(s\) of which [1-9]\d* owned, post-boot log line\(s\) 0\/0, control log window [1-9]\d* line\(s\) of [1-9]\d* emitted, listener leak false, watchers 0, servers \d+, owned growth -?\d+[\s\S]*RESULT: PASS/ },
  { file: 'collider-build-failure-witness.mjs', must: /"arm":"appruntime\.autoTrimesh\.probe-good","model"[\s\S]*"arm":"editor\.rebuild\.retryAfterFailure"[\s\S]*"recovered":true[\s\S]*RESULT: PASS/ },
  { file: 'player-manager-send-failure-witness.mjs', must: /MEASURED player-manager-send-failure: 3 player\(s\), [1-9]\d* refused send\(s\) of 4 site\(s\), sendFailures \+[1-9]\d*, log line\(s\) [1-9]\d*[\s\S]*disconnect site call\(s\) [1-9]\d*, encode signal\(s\) [1-9]\d*, control frame\(s\) [1-9]\d*[\s\S]*RESULT: PASS/ },
  { file: 'static-collision-cpu-witness.mjs', must: /MEASURED static-collision-cpu: [1-9]\d* tick\(s\) over 144 collision entit[\s\S]*16 forced overlap pair\(s\) producing [1-9]\d* collision event\(s\)[\s\S]*0 event\(s\)\/tick after the overlaps were removed[\s\S]*RESULT: PASS/ },
  { file: 'physics-lod-budget-cpu-witness.mjs', args: ['--warm=0', '--ticks=256', '--budget=128'], must: /resident=[1-9]\d*[^\n]*\bdropped=0\b[\s\S]*RESULT: PASS/ },
  { file: 'transport-churn-witness.mjs', must: /\[transport-churn\] [1-9]\d* passed, 0 failed[\s\S]*\[transport-churn\] RESULT: PASS/ },
  { file: 'veg-lod-stream-witness.mjs', must: /^(?![\s\S]*\binstances=0\b)[\s\S]*shape=\S+ instancers=[1-9]\d* instances=[1-9]\d* visits\/frame=[1-9][\d.]*[\s\S]*shape=\S+ instancers=[1-9]\d* instances=[1-9]\d* visits\/frame=[1-9][\d.]*[\s\S]*RESULT: PASS/ },
  { file: 'veg-lod-sweep-witness.mjs', must: /^(?![\s\S]*\binstances=0\b)(?![\s\S]*\bsurvivors=0\b)[\s\S]*shape=\S+ instances=[1-9]\d* instancers=[1-9]\d* records\/frame=[1-9][\d.]* planeTests\/frame=[1-9][\d.]*[\s\S]*scaling: \{"countRatio":[\d.]+,"survivorRatio":[\d.]+[\s\S]*RESULT: PASS/ },
  { file: 'veg-lod-pair-witness.mjs', must: /ratio shared\/control: \{"recordsWalked":0\.5\d+,"cellsTested":0\.5\d+,"planeTests":0\.5\d+,"rebuilds":0\.5,"rebuildRecords":0\.5\}/ },
  { file: 'relevance-radius-witness.mjs', args: ['--counts=8', '--reps=1', '--duration=3000'], must: /MEASURED relevance-radius:[\s\S]*snapshot byte\(s\)\/snapshot \d+:[1-9]\d*->[1-9]\d*[\s\S]*[1-9]\d* shot\(s\) at hit rate[\s\S]*[1-9]\d*\/[1-9]\d* real client\(s\) over [1-9]\d* stage entit[\s\S]*cell-centre solves\/tick [1-9][\d.]* -> 0\.00 \([1-9][\d.]*% cut\)[\s\S]*[1-9]\d*\/[1-9]\d* cached base set\(s\) matched[\s\S]*re-solved [1-9]\d*\/[1-9]\d* centre\(s\)[\s\S]*RESULT: PASS/ },
  { file: 'ep-progressive-lod-schema-witness.mjs', must: /MEASURED ep-progressive-lod-schema: [1-9]\d* mesh\(es\) \/ [1-9]\d* LOD\(s\)[\s\S]*[1-9]\d* clustered prim\(s\) \/ [1-9]\d* cluster\(s\)[\s\S]*[1-9]\d* schema mutation\(s\) and [1-9]\d* cluster mutation\(s\) each rejected[\s\S]*RESULT: PASS \(0 failure\(s\)\)/ },
  { file: 'tps-game-player-movement-witness.mjs', must: /RESULT: PASS: walked [1-9][\d.]*m over [1-9]\d* input step\(s\) and [1-9]\d* tick\(s\) in world=tps-game/ },
  { file: 'placement-climate-gate-witness.mjs', must: /RESULT: PASS identical true over [1-9]\d* veg and [1-9]\d* rock placement\(s\)[\s\S]*over [1-9]\d*\/[1-9]\d*\/[1-9]\d*\/[1-9]\d* placement\(s\) \(quarter-chunk control [1-9]\d* of [1-9]\d*\)/ },
  { file: 'check-cache-keys-scope-witness.mjs', must: /verifying 2 artifact\(s\) of the 2 tracked/ },
  { file: 'edge-collider-draco-witness.mjs', must: /0 byte\(s\) written into the tracked tree/ },
  { file: 'collider-turnover-witness.mjs', must: /MEASURED collider-turnover: [1-9]\d* step\(s\) of 30 m, radius 64 m -- capped cap 8 live [1-9]\d*\.\.[1-9]\d* in-radius [1-9]\d*\.\.[1-9]\d*[\s\S]*free cap 256 live [1-9]\d*\.\.[1-9]\d* in-radius [1-9]\d*\.\.[1-9]\d*[\s\S]*saturated 0\/9, stale 0\/18 step\(s\)[\s\S]*RESULT: PASS/ },
  { file: 'cpu-skip-witness.mjs', must: /"ticks": [1-9]\d*[\s\S]*"row2_encodePerSnapshotCall": [1-9][\d.]*[\s\S]*"row2_snapshotStaleTotal": 0[\s\S]*"row2_snapshotChecks": [1-9]\d*[\s\S]*"row3_colEntitiesPerTick": [1-9]\d*[\s\S]*"row4_interactPairsPerTick": [1-9]\d*[\s\S]*"clientErrors": 0[\s\S]*RESULT: PASS/ },
  { file: 'snapshot-perplayer-encode-witness.mjs', must: /RESULT: PASS -- [1-9]\d* recipient\(s\), 0 re-encode\(s\) with a warm cache, 0 byte mismatch\(es\) over [1-9]\d* wire record\(s\)/ },
  { file: 'netcode-profile-downgrade-witness.mjs', must: /RESULT: PASS -- MSG\.WORLD_DEF carries netcode\.profile "lockstep" to a client that never saw the world file/ },
  { file: 'agents-md-facts-witness.mjs', must: /checked [1-9]\d* path claim\(s\), \d+ line claim\(s\) and \d+ sha-like token\(s\)[\s\S]*RESULT: PASS -- every AGENTS\.md path and line claim resolves/ },
  { file: 'ground-source-port-witness.mjs', must: /RESULT: PASS checks=[1-9]\d* failed=0/ },
  { file: 'ground-entry-precondition-witness.mjs', must: /checks=[1-9]\d* failed=0[\s\S]*RESULT: PASS/ },
  { file: 'hud-applydiff-witness.mjs', args: ['--frames=200'], must: /\[hud-applydiff\] RESULT: PASS [1-9]\d* tick\(s\) over [1-9]\d* node\(s\): [01] mutation\(s\)\/tick, \d+\.\d+ ms diff\/tick/ },
  { file: 'terrain-quad-upload-witness.mjs', must: /\[quad-upload\] RESULT: PASS -- 2 config\(s\), 0 upload\(s\) issued for 1200 frame\(s\) whose payload was unchanged/ },
  { file: 'contact-occlusion-softness-witness.mjs', must: /  passed [1-9]\d*, failed 0[\s\S]*RESULT: PASS/ },
  { file: 'browser-lease-single-session-witness.mjs', must: /  passed [1-9]\d*, failed 0[\s\S]*RESULT: PASS/ },
  { file: 'lib/witness-audit.mjs', args: ['--gate'], must: /RESULT: PASS [1-9]\d* file\(s\) scanned/ },
  { file: 'governor-hitch-response-witness.mjs', must: /qualityGovernor registry default true[\s\S]*single 100ms hitch answered after 1 frames[\s\S]*min trigger 1 frame\(s\)[\s\S]*smallest visible hitch 34ms answered after 1 frames[\s\S]*0 resolution key\(s\) written[\s\S]*RESULT: PASS/ },
  { file: 'veg-macrotask-yield-witness.mjs', must: /\[veg-macrotask-yield\] delivery: messageChannel=\d+ setTimeout=0[\s\S]*requestAnimationFrame=0 macrotaskYield calls=2[\s\S]*RESULT: PASS/ },
  { file: 'rain-over-grass-draw-order-witness.mjs', must: /\[rain-over-grass-draw-order\] \[PASS\] weather band is above the grass band[\s\S]*RESULT: PASS/ },
  { file: 'grass-lod-geometry-budget-witness.mjs', must: /\[PASS\] both grass LOD call sites read out of client\/core\/Grass\.js[\s\S]*RESULT: PASS/ },
  // gpu-free: it measures the bend the shader computes, not pixels. Whether that many mm is VISIBLE
  // still needs a real frame, and that arm is a browser arm this CI does not run.
  { file: 'grass-bend-geometry-witness.mjs', must: /\[PASS\] the bend is quadratic in the card height coordinate[\s\S]*\[PASS\] the change is sub-centimetre at the wind that ships[\s\S]*RESULT: PASS/ },
  { file: 'veg-lod-poly-budget-witness.mjs', args: ['--min-mid-tris=600', '--min-mid-total=18000'], must: /branchTriCap=6000 \(shipped default\)[\s\S]*RESULT: PASS -- 15 species at branchTriCap=6000, branch mid tier \d+ far \d+, 0 violation\(s\)/ },
  { file: 'webgpu-hiz-shaders-witness.mjs', must: /CHECK C06-strides-match-wgsl-layout PASS[\s\S]*CHECK C08-packer-direct-matches-wgsl-layout PASS[\s\S]*CHECK C12-parser-to-packer-matches-wgsl-layout PASS[\s\S]*RESULT: PASS -- [1-9]\d* of [1-9]\d* checks passed/ },
  { file: 'webgpu-pipeline-validation-refusal-witness.mjs', must: /\[PASS\] A1 real WGSL validates all four pipelines -- pipelinesValidated=4[\s\S]*\[PASS\] B1 broken WGSL is REFUSED --[\s\S]*\[PASS\] M1 without the error scope the same broken WGSL is NOT refused[\s\S]*RESULT: PASS/ },
]
const NO_GPU_WITNESS_TIMEOUT_MS = 120000
const SLOW_WITNESS_TIMEOUT_MS = 600000
const SLOW_NO_GPU_WITNESSES = [
  { file: 'planet-multiplayer-harness.mjs', args: ['--n=8'], must: /RESULT: PASS -- [1-9]\d* of [1-9]\d* check\(s\) passed/ },
  { file: 'collider-ring-scale-witness.mjs', must: /\[ring-scale\] [1-9]\d* passed, 0 failed[\s\S]*\[ring-scale\] RESULT: PASS/ },
  { file: 'collider-ring-boot-batches-witness.mjs', must: /ms per 1k operation\(s\) over [1-9]\d* operation\(s\)/ },
]
const NO_GPU_WITNESS_GPU_SURFACE = /cdp-browser|gpu-probe|gpu-eval|witnessGpu|gpuLaunchArgs|use-angle|adapter-luid|WebGLRenderer|WebGPURenderer/
const NO_GPU_VERDICT_RE = /^(?:\[[^\]]*\]\s*)?RESULT:\s+(PASS|FAIL)(?![A-Za-z0-9_])/
const NO_GPU_WITNESS_ECHO_LINES = 6
const NO_GPU_WITNESS_CAUSE_RE = /RESULT: FAIL|\[FAIL\]|^FAIL |FATAL|Error:|AssertionError|error TS\d+|npm ERR!/i

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

function echoLines(text, limit) {
  const all = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '')
  const picked = []
  const shown = new Set()
  for (const line of all) {
    if (!NO_GPU_WITNESS_CAUSE_RE.test(line)) continue
    const key = line.trim()
    if (shown.has(key)) continue
    shown.add(key)
    picked.push(key)
    if (picked.length >= limit) break
  }
  for (const line of tailLines(text, limit)) {
    const key = line.trim()
    if (key === '' || shown.has(key)) continue
    shown.add(key)
    picked.push(key)
    if (picked.length >= limit) break
  }
  return picked
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
  // The arm no longer exits at the first red witness: one failure used to hide every sibling after
  // it plus both post-arm gates, so a lane could not tell its own status from CI's output. Each
  // witness is an independent process with its own timeout, verdict regex and `must` regex, so a
  // failure is recorded and the arm runs on; the build still fails, but on the complete list.
  let noGpuMs = 0
  const noGpuFailures = []
  async function runNoGpuWitnesses(list, timeoutMs) {
    for (const spec of list) {
      const rel = join('scripts', spec.file)
      let source = ''
      try {
        source = readFileSync(rel, 'utf8')
      } catch (e) {
        noGpuFailures.push({ file: spec.file, code: null, reasons: [`unreadable (${e.message}), so its assertions never ran`], echo: [] })
        console.error(`check: gpu-free witness ${spec.file} FAILED (never ran, unreadable) -- recorded; the arm runs every witness so the failure list is complete`)
        continue
      }
      const gpuHit = NO_GPU_WITNESS_GPU_SURFACE.exec(source)
      if (gpuHit !== null) {
        noGpuFailures.push({ file: spec.file, code: null, reasons: [`reaches the "${gpuHit[0]}" surface, so it cannot run where CI has no GPU -- move it behind SPOINT_GPU_WITNESS`], echo: [] })
        console.error(`check: gpu-free witness ${spec.file} FAILED (never ran, reaches the "${gpuHit[0]}" surface) -- recorded; the arm runs every witness so the failure list is complete`)
        continue
      }
      const started = Date.now()
      let stdout = ''
      let stderr = ''
      let code = 0
      let killed = false
      try {
        const done = await execFileAsync(process.execPath, [rel, ...(spec.args ?? [])], { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs })
        stdout = done.stdout
      } catch (e) {
        stdout = (e && e.stdout) || ''
        stderr = (e && e.stderr) || ''
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
        noGpuFailures.push({ file: spec.file, code, reasons: witnessFailures, echo: echoLines(`${stdout}\n${stderr}`, NO_GPU_WITNESS_ECHO_LINES) })
        console.error(`check: gpu-free witness ${spec.file} FAILED (${(ms / 1000).toFixed(1)} s, exit ${code}): ${witnessFailures.join('; ')} -- recorded; the arm runs every witness so the failure list is complete`)
      } else {
        console.log(`check: gpu-free witness ${spec.file} ${(ms / 1000).toFixed(1)} s, exit 0, ${verdict.line ?? 'no RESULT: line, so exit 0 is the verdict'}`)
      }
    }
  }
  await runNoGpuWitnesses(NO_GPU_WITNESSES, NO_GPU_WITNESS_TIMEOUT_MS)
  await runNoGpuWitnesses(SLOW_NO_GPU_WITNESSES, SLOW_WITNESS_TIMEOUT_MS)
  const noGpuCount = NO_GPU_WITNESSES.length + SLOW_NO_GPU_WITNESSES.length
  console.log(`check: ${noGpuCount} gpu-free witness(es) ran in ${(noGpuMs / 1000).toFixed(1)} s with no GPU required`)

  // These gates read committed state, not any witness's artefact, so a red witness above is no
  // reason to withhold their verdicts.
  const gateFailures = []
  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/fire-witness-gate.mjs'], { maxBuffer: 16 * 1024 * 1024 })
    for (const line of stdout.split('\n')) if (line.trim()) console.log(`check: ${line}`)
  } catch (e) {
    const out = (e.stdout || '').toString()
    for (const line of out.split('\n')) if (line.trim()) console.error(`check: ${line}`)
    gateFailures.push(`fire-witness-gate.mjs: ${(e.stderr || e.message || '').toString().trim()}`)
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/check-frame-time-baselines.mjs'])
    for (const line of stdout.split('\n')) if (line.trim()) console.log(line)
  } catch (e) {
    gateFailures.push(`check-frame-time-baselines.mjs: ${(e.stderr || e.stdout || e.message || '').toString().trim()}`)
  }
  const gpuArms = (process.env.SPOINT_GPU_WITNESS || '').split(',').map((s) => s.trim()).filter(Boolean)
  for (const gpu of gpuArms) {
    const keep = (line) => /^(\[veg-witness\]|RESULT:|  \[(PASS|FAIL)\])/.test(line)
    try {
      const { stdout } = await execFileAsync(process.execPath, ['scripts/veg-instance-browser-witness.mjs', `--gpu=${gpu}`, '--at=-15,-12.5', '--settle=15000', '--walk=45000'], { maxBuffer: 16 * 1024 * 1024 })
      for (const line of stdout.split('\n')) if (keep(line)) console.log(`check: ${line}`)
    } catch (e) {
      for (const line of ((e && e.stdout) || '').toString().split('\n')) if (keep(line)) console.error(`check: ${line}`)
      gateFailures.push(`veg-instance-browser-witness.mjs on ${gpu}: ${(e.stderr || e.message || '').toString().trim()}`)
    }
  }
  console.log(`check: ${imports.appCount} apps resolve every import through the worker path, ${imports.assetCount} asset references exist`)
  if (noGpuFailures.length > 0) {
    console.error(`check: ${noGpuFailures.length} of ${noGpuCount} gpu-free witness(es) failed -- all ${noGpuCount} ran, so this is the complete failure list:`)
    for (const f of noGpuFailures) {
      console.error(`  FAIL ${f.file} exit ${f.code === null ? 'never ran' : f.code}: ${f.reasons.join('; ')}`)
      for (const line of f.echo) console.error(`    ${f.file} out ${line}`)
    }
    console.error(`check: failing gpu-free witness(es): ${noGpuFailures.map((f) => f.file).join(', ')}`)
  }
  if (gateFailures.length > 0) {
    console.error(`check: ${gateFailures.length} post-arm gate(s) failed:`)
    for (const g of gateFailures) console.error(`  FAIL ${g}`)
  }
  if (noGpuFailures.length > 0 || gateFailures.length > 0) process.exit(1)
}

main().catch((e) => { console.error('check: harness error:', e); process.exit(2) })
