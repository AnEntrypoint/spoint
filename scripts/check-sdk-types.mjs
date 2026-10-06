#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const TSC_BIN = join(ROOT, 'node_modules/typescript/bin/tsc')
const TSCONFIG = join(ROOT, 'tsconfig.sdk-check.json')

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

  const missingScope = ['src/sdk', 'src/apps/AppContext.js'].filter((p) => !existsSync(join(ROOT, p)))
  if (missingScope.length) {
    console.error(`[check-sdk-types] in-scope path(s) absent: ${missingScope.join(', ')} -- nothing was type-checked`)
    process.exit(1)
  }

  let tsconfigRaw = ''
  try { tsconfigRaw = readFileSync(TSCONFIG, 'utf8') } catch (e) {
    console.error(`[check-sdk-types] unreadable ${TSCONFIG} (${e.message})`)
    process.exit(1)
  }
  let tsconfig = null
  try { tsconfig = JSON.parse(tsconfigRaw) } catch (e) {
    console.error(`[check-sdk-types] ${TSCONFIG} does not parse as JSON (${e.message}) -- its include list cannot be verified`)
    process.exit(1)
  }
  const includeList = Array.isArray(tsconfig.include) ? tsconfig.include : []
  const sdkIncluded = includeList.some((p) => String(p).replace(/\\/g, '/').startsWith('src/sdk'))
  if (!sdkIncluded) {
    console.error(`[check-sdk-types] ${TSCONFIG} includes no "src/sdk" pattern -- src/sdk/**/*.js is not in the type-checked program`)
    process.exit(1)
  }
  const appContextIncluded = includeList.some((p) => String(p).replace(/\\/g, '/').includes('AppContext'))
  if (!appContextIncluded) {
    console.error(`[check-sdk-types] ${TSCONFIG} includes no AppContext.js pattern -- src/apps/AppContext.js is not in the type-checked program`)
    process.exit(1)
  }

  let stdout = ''
  let tscExit = 0
  try {
    const r = await execFileAsync(process.execPath, [TSC_BIN, '-p', TSCONFIG], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    stdout = r.stdout
  } catch (e) {
    stdout = e.stdout || ''
    tscExit = typeof e.code === 'number' ? e.code : 1
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

  if (tscExit !== 0 && blocks.length === 0) {
    console.error(`[check-sdk-types] tsc exited ${tscExit} without a parseable diagnostic -- the type check did not run:\n${stdout.trim() || '(no output)'}`)
    process.exit(1)
  }

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
