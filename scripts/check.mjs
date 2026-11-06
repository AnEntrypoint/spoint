import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { checkAppImports } from './check-app-imports.mjs'
import { ensureWorkspaceLinks, formatReport } from './ensure-workspace-links.mjs'

const execFileAsync = promisify(execFile)

const ROOTS = ['src', 'client', 'apps', 'scripts', 'bin']
const SKIP_DIRS = new Set(['basis', 'draco', 'maps'])
const SKIP_VENDORED_FILE = /(\.min\.js$|basis_transcoder|draco_decoder|jolt-physics)/
const MAX_PARALLEL_CHECKS = 16
const GUARDED = ['src/netcode/NetworkState.js', 'src/sdk/EditorHandlers.js', 'src/apps/AppContext.js']

function collect(out) {
  for (const root of ROOTS) walk(root, out)
  return out
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|cjs)$/.test(name) && !SKIP_VENDORED_FILE.test(name)) out.push(full)
  }
}

async function main() {
  const files = collect([])
  const missingRoots = ROOTS.filter((r) => !existsSync(r))
  if (missingRoots.length) {
    console.error(`check: source root(s) absent, so ${files.length} file(s) were scanned: ${missingRoots.join(', ')}`)
    process.exit(1)
  }
  if (files.length === 0) {
    console.error(`check: 0 tracked source files collected from ${ROOTS.join(', ')} -- an empty parse scan is not a pass`)
    process.exit(1)
  }
  console.log(`check: parsing ${files.length} source file(s) under ${ROOTS.join(', ')}`)

  const failures = []

  const links = ensureWorkspaceLinks()
  if (links.refused.length) {
    for (const line of formatReport(links)) console.error(line)
    console.error(`check: workspace-link repair refused ${links.refused.length} link(s) that resolve outside this tree; the gate stopped before writing`)
    process.exit(1)
  }
  for (const c of links.created) console.log(`check: workspace link node_modules/${c.name} was missing and is now created -> packages/${c.dir}`)
  for (const r of links.repaired) {
    const kept = r.movedTo === null ? '' : ` -- the install it displaced is kept at ${r.movedTo}`
    console.log(`check: workspace link node_modules/${r.name} was ${r.kind} (not a link into packages/) and is now relinked -> packages/${r.dir}${kept}`)
  }
  for (const detail of links.failed) failures.push(`workspace link ${detail} -- run: node scripts/ensure-workspace-links.mjs`)

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

  const guardFails = []
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

  const steps = [
    ['relative import resolution', 'scripts/check-relative-imports.mjs', (out) => `check: ${out}`],
    ['bake code-version closure', 'scripts/check-cache-keys.mjs', (out) => out],
    ['three export-name resolution', 'scripts/check-tsl-imports.mjs', (out) => `check: ${out}`],
    ['SES preflight refusals', 'scripts/check-ses-preflight.mjs', (out) => `check: ${out}`],
  ]
  for (const [label, file, fmt] of steps) {
    try {
      const { stdout } = await execFileAsync(process.execPath, [file])
      for (const line of stdout.split('\n')) if (line.trim()) console.log(fmt(line))
    } catch (e) {
      console.error(`check: ${label}:`, (e.stderr || e.message || '').toString().trim())
      process.exit(1)
    }
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
  console.log(`check: ${imports.count ?? 'all'} app(s) resolve every import`)
}

main().catch((e) => { console.error('check: harness error:', e); process.exit(2) })
