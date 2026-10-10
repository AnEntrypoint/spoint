import { writeFileSync, renameSync, existsSync, readFileSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const DEFAULT_SESSION_ID = 'f73df536-0f66-49a1-8888-2a064d23416a'
const DEFAULT_TIMEOUT_MS = 180000
const DEFAULT_CHARS = 6000
const POLL_INTERVAL_MS = 250

function randomSuffix() {
  return Math.random().toString(36).slice(2, 10).padEnd(8, 'x')
}

function parseArgs(argv) {
  const positional = []
  const flags = new Map()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    if (equals !== -1) {
      flags.set(arg.slice(2, equals), arg.slice(equals + 1))
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next)
      i++
    } else {
      flags.set(arg.slice(2), 'true')
    }
  }
  return { positional, flags }
}

function numberFlag(flags, name, fallback) {
  if (!flags.has(name)) return fallback
  const value = Number(flags.get(name))
  return Number.isFinite(value) ? value : fallback
}

function findProjectRoot(start) {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, '.gm'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function writeInputAtomically(path, body) {
  const temporary = `${path}.tmp`
  try {
    writeFileSync(temporary, body, 'utf8')
    renameSync(temporary, path)
    return true
  } catch {
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch {}
    writeFileSync(path, body, 'utf8')
    return false
  }
}

function findOutput(spool, verb, suffix) {
  const outDir = join(spool, 'out')
  let names
  try { names = readdirSync(outDir) } catch { return null }
  const match = names.find(n => n.startsWith(`${verb}-`) && n.includes(suffix) && n.endsWith('.json'))
  return match ? join(outDir, match) : null
}

function sleep(ms) {
  return new Promise(done => setTimeout(done, ms))
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const verb = positional[0]
  if (!verb) {
    console.error('gm-dispatch: usage: node scripts/lib/gm-dispatch.mjs <verb> [body-json] [--cwd <project-root>] [--timeout-ms N] [--chars N]')
    process.exit(2)
  }
  const startDir = flags.get('cwd') ?? process.cwd()
  const projectRoot = findProjectRoot(startDir)
  if (!projectRoot) {
    console.error(`gm-dispatch: no .gm directory at or above ${resolve(startDir)}; pass --cwd <project root that holds .gm>`)
    process.exit(2)
  }
  const timeoutMs = numberFlag(flags, 'timeout-ms', DEFAULT_TIMEOUT_MS)
  const maxChars = numberFlag(flags, 'chars', DEFAULT_CHARS)
  const spool = join(projectRoot, '.gm', 'exec-spool')
  const sessionId = process.env.GM_SESSION_ID || DEFAULT_SESSION_ID
  const rawBody = positional[1]
  let body = rawBody && rawBody.trim() ? rawBody.trim() : '{}'
  const parsed = JSON.parse(body)
  if (parsed.session_id === undefined) parsed.session_id = sessionId
  body = JSON.stringify(parsed)

  const suffix = randomSuffix()
  const inDir = join(spool, 'in', verb)
  try { mkdirSync(inDir, { recursive: true }) } catch {}
  const inPath = join(inDir, `${sessionId}-${suffix}.txt`)
  const renamed = writeInputAtomically(inPath, body)

  const deadline = Date.now() + timeoutMs
  let outPath = null
  while (Date.now() < deadline) {
    outPath = findOutput(spool, verb, suffix)
    if (outPath) break
    await sleep(POLL_INTERVAL_MS)
  }
  if (!outPath) {
    console.error(`gm-dispatch: ${verb} dispatch ${suffix} produced no response within ${timeoutMs} ms; input left at ${inPath}`)
    process.exit(1)
  }
  let text = readFileSync(outPath, 'utf8')
  let truncated = false
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }
  console.log(`gm-dispatch: ${verb} ${suffix} root=${projectRoot} atomic-rename=${renamed} out=${outPath}`)
  if (truncated) console.log(`gm-dispatch: truncated to ${maxChars} char(s); full response at ${outPath}`)
  console.log(text)
}

main().catch(e => { console.error(`gm-dispatch: harness error: ${e?.message || e}`); process.exit(2) })
