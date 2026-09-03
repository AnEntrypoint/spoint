#!/usr/bin/env node
// Runs `tsc -p tsconfig.sdk-check.json` (checkJs public-API drift detection for
// src/sdk/**/*.js + src/apps/AppContext.js) and filters its diagnostics down to only
// the files actually in scope.
//
// Why filtering is needed instead of relying on tsconfig `include` alone: TypeScript's
// `checkJs` mode type-checks every file the *program* resolves (imports followed
// transitively from the include set -- e.g. AppContext.js pulls in apps/_lib/*.js,
// src/apps/AppRuntime.js, src/physics/World.js, and so on), and reports diagnostics
// for ALL of them, not just the files named in `include`. There is no tsc compiler
// flag that restricts diagnostic *reporting* to a file subset independently of the
// program's resolved file set (verified live: `include` scoped tightly still surfaced
// 60+ files' worth of unrelated diagnostics from packages/streaming-gltf,
// src/physics/World.js, src/storage/*Adapter.js etc). So this script does the
// standard workaround: run the real compiler, then keep only diagnostic blocks whose
// leading `path(line,col): error ...` header is inside the scoped file set, including
// each diagnostic's wrapped continuation lines (a multi-line type-mismatch explanation
// has no per-line file prefix, so it must be captured until the next header or EOF).
//
// Usage: node scripts/check-sdk-types.mjs   (npm run check:sdk-types)
// Exit code: 0 if zero in-scope diagnostics, 1 otherwise (even if tsc itself exited
// non-zero only because of OUT-of-scope diagnostics elsewhere in the program).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const TSC_BIN = join(ROOT, 'node_modules/typescript/bin/tsc')
const TSCONFIG = join(ROOT, 'tsconfig.sdk-check.json')

// Diagnostic header lines look like: `src/sdk/ServerAPI.js(73,98): error TS2741: ...`
const HEADER_RE = /^(\S.*?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/
const IN_SCOPE_RE = /^(src[\\/]sdk[\\/]|src[\\/]apps[\\/]AppContext\.js)/

async function main() {
  if (!existsSync(TSC_BIN)) {
    console.error(`[check-sdk-types] tsc not found at ${TSC_BIN} -- is 'typescript' installed as a devDependency?`)
    process.exit(1)
  }
  if (!existsSync(TSCONFIG)) {
    console.error(`[check-sdk-types] missing ${TSCONFIG}`)
    process.exit(1)
  }

  let stdout = ''
  try {
    const r = await execFileAsync(process.execPath, [TSC_BIN, '-p', TSCONFIG], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    stdout = r.stdout
  } catch (e) {
    // tsc exits non-zero whenever ANY diagnostic (even out-of-scope) is reported --
    // that is expected here, we still need e.stdout to filter it.
    stdout = e.stdout || ''
    if (!stdout) { console.error(e.stderr || e.message || String(e)); process.exit(1) }
  }

  const lines = stdout.split(/\r?\n/)
  const blocks = []
  let current = null
  for (const line of lines) {
    const m = HEADER_RE.exec(line)
    if (m) {
      if (current) blocks.push(current)
      current = { file: relative(ROOT, join(ROOT, m[1])).replace(/\\/g, '/'), rawFile: m[1], lines: [line] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) blocks.push(current)

  const inScope = blocks.filter(b => IN_SCOPE_RE.test(b.rawFile.replace(/\\/g, '/')))

  if (inScope.length === 0) {
    console.log('[check-sdk-types] 0 diagnostics in src/sdk/**/*.js + src/apps/AppContext.js. Pass.')
    console.log(`[check-sdk-types] (${blocks.length - inScope.length} out-of-scope diagnostic(s) elsewhere in the resolved program were suppressed -- run "node node_modules/typescript/bin/tsc -p tsconfig.sdk-check.json" directly to see them.)`)
    process.exit(0)
  }

  console.log(`[check-sdk-types] ${inScope.length} diagnostic(s) in src/sdk/**/*.js + src/apps/AppContext.js:\n`)
  for (const b of inScope) console.log(b.lines.join('\n'))
  console.log(`\n[check-sdk-types] FAIL: ${inScope.length} in-scope diagnostic(s) (${blocks.length - inScope.length} out-of-scope diagnostic(s) elsewhere in the resolved program were suppressed).`)
  process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
