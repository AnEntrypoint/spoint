import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ROOTS = ['src', 'client', 'apps', 'scripts', 'bin']
const SKIP_DIRS = new Set(['node_modules', '.git', '.gm', 'basis', 'draco', 'maps'])
const SKIP_VENDORED_FILE = /(\.min\.js$|basis_transcoder|draco_decoder|jolt-physics)/

function collect(dir, out) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) collect(full, out)
    } else if ((extname(name) === '.js' || extname(name) === '.mjs') && !SKIP_VENDORED_FILE.test(full)) {
      out.push(full)
    }
  }
  return out
}

async function main() {
  const files = []
  for (const r of ROOTS) collect(r, files)

  const failures = []
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
  for (const rel of GUARDED) {
    const full = join(...rel.split('/'))
    let txt = ''
    try { txt = readFileSync(full, 'utf8') } catch { continue }
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
    await execFileAsync(process.execPath, ['scripts/bundle-apps-manifest.mjs', '--check'])
    console.log('check: apps-manifest.json is synced')
  } catch (e) {
    console.error('check: apps-manifest.json sync check failed:', e.stderr || e.message)
    process.exit(1)
  }
}

main().catch((e) => { console.error('check: harness error:', e); process.exit(2) })
