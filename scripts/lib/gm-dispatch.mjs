import { writeFileSync, renameSync, existsSync, readFileSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_SESSION_ID = 'f73df536-0f66-49a1-8888-2a064d23416a'
const DEFAULT_TIMEOUT_MS = 180000
const DEFAULT_CHARS = 6000
const POLL_INTERVAL_MS = 250

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SPOOL = join(REPO_ROOT, '.gm', 'exec-spool')

function randomSuffix() {
  return Math.random().toString(36).slice(2, 10).padEnd(8, 'x')
}

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const value = Number(process.argv[i + 1])
  return Number.isFinite(value) ? value : fallback
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

function findOutput(verb, suffix) {
  const outDir = join(SPOOL, 'out')
  let names
  try { names = readdirSync(outDir) } catch { return null }
  const match = names.find(n => n.startsWith(`${verb}-`) && n.includes(suffix) && n.endsWith('.json'))
  return match ? join(outDir, match) : null
}

function sleep(ms) {
  return new Promise(done => setTimeout(done, ms))
}

async function main() {
  const positional = process.argv.slice(2).filter(a => !a.startsWith('--'))
  const verb = positional[0]
  if (!verb) {
    console.error('gm-dispatch: usage: node scripts/lib/gm-dispatch.mjs <verb> [body-json] [--timeout-ms N] [--chars N]')
    process.exit(2)
  }
  const timeoutMs = flag('timeout-ms', DEFAULT_TIMEOUT_MS)
  const maxChars = flag('chars', DEFAULT_CHARS)
  const sessionId = process.env.GM_SESSION_ID || DEFAULT_SESSION_ID
  const rawBody = positional[1]
  let body = rawBody && rawBody.trim() ? rawBody.trim() : '{}'
  const parsed = JSON.parse(body)
  if (parsed.session_id === undefined) parsed.session_id = sessionId
  body = JSON.stringify(parsed)

  const suffix = randomSuffix()
  const inDir = join(SPOOL, 'in', verb)
  try { mkdirSync(inDir, { recursive: true }) } catch {}
  const inPath = join(inDir, `${sessionId}-${suffix}.txt`)
  const renamed = writeInputAtomically(inPath, body)

  const deadline = Date.now() + timeoutMs
  let outPath = null
  while (Date.now() < deadline) {
    outPath = findOutput(verb, suffix)
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
  console.log(`gm-dispatch: ${verb} ${suffix} atomic-rename=${renamed} out=${outPath}`)
  if (truncated) console.log(`gm-dispatch: truncated to ${maxChars} char(s); full response at ${outPath}`)
  console.log(text)
}

main().catch(e => { console.error(`gm-dispatch: harness error: ${e?.message || e}`); process.exit(2) })
