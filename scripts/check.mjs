// Zero-dependency static guardrail: parse-check every source file with the
// Node parser (`node --check` semantics via vm.compileFunction is unreliable for
// ESM, so we spawn `node --check` per file). Catches syntax errors and the
// trailing-NUL-byte corruption the Windows-mounted Edit/Write path can leave
// (recall: editor edits left 288 trailing NULs -> "Invalid or unexpected token").
// No eslint/tsc dependency: this prevents the bug CLASS this repo actually hits
// (a file that will not parse) without a kitchen-sink ruleset or a new install.
//
// Run: node scripts/check.mjs   (exits non-zero on any parse failure)

import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ROOTS = ['src', 'client', 'apps', 'scripts', 'bin']
const SKIP_DIRS = new Set(['node_modules', '.git', '.gm', 'basis', 'draco', 'maps'])
// Vendored third-party bundles that ship as-is and are not ours to gate.
const SKIP_FILE = /(\.min\.js$|basis_transcoder|draco_decoder|jolt-physics)/

function collect(dir, out) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) collect(full, out)
    } else if ((extname(name) === '.js' || extname(name) === '.mjs') && !SKIP_FILE.test(full)) {
      out.push(full)
    }
  }
  return out
}

async function main() {
  const files = []
  for (const r of ROOTS) collect(r, files)

  const failures = []
  // Bounded concurrency so we do not spawn hundreds of node processes at once.
  const LIMIT = 16
  let idx = 0
  async function worker() {
    while (idx < files.length) {
      const file = files[idx++]
      // A trailing-NUL file passes `node --check` on some platforms but throws at
      // import; check for it explicitly first since it is the known corruption.
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
  await Promise.all(Array.from({ length: Math.min(LIMIT, files.length) }, worker))

  if (failures.length) {
    console.error(`check: ${failures.length} of ${files.length} files failed to parse:`)
    for (const f of failures) console.error(`  ${f.file}: ${f.error}`)
    process.exit(1)
  }
  console.log(`check: ${files.length} source files parse cleanly`)

  // Guardrail (Principle 8) for the validation-bypass bug CLASS this review
  // surfaced: the server write-boundary files that accept client/app-supplied
  // transforms must route them through shared/vecGuard so a NaN/short-array can't
  // poison the authoritative snapshot to every client. Rather than a noisy
  // repo-wide `.position =` grep (which would flag the legitimate validated sites
  // and the SnapshotProcessor slot fills), this is a NARROW, named invariant:
  // these specific files import vecGuard. If a future edit reaches into them and
  // drops the import, this fails loudly with the reason.
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

  // Ensure apps-manifest.json stays synced when apps change
  try {
    await execFileAsync(process.execPath, ['scripts/bundle-apps-manifest.mjs', '--check'])
    console.log('check: apps-manifest.json is synced')
  } catch (e) {
    console.error('check: apps-manifest.json sync check failed:', e.stderr || e.message)
    process.exit(1)
  }
}

main().catch((e) => { console.error('check: harness error:', e); process.exit(2) })
