import { readFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { checkAppImports } from './check-app-imports.mjs'
import { ensureWorkspaceLinks } from './ensure-workspace-links.mjs'

const execFileAsync = promisify(execFile)

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
