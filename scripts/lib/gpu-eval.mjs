import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VERB = 'crawl'
const SPOOL_IN = 'in/crawl'
const SPOOL_OUT = 'out'
const ENGINE_CDP = 'engine=cdp'
const DEFAULT_SCREENSHOT = 'gpu-eval-shot.png'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function spoolRoot() {
  return process.env.GM_SPOOL_ROOT
    ? path.resolve(process.env.GM_SPOOL_ROOT)
    : path.join(REPO_ROOT, '.gm', 'exec-spool')
}

function sessionId() {
  const s = process.env.SESSION_ID || process.env.GM_SESSION_ID
  if (!s) throw new Error('SESSION_ID is required: the crawl verb rejects an empty session. Export SESSION_ID=<id> before running this script.')
  return s
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))

function nextTaskId() {
  const lo = Number(process.env.GM_BROWSER_TASK_BASE || 39000)
  return lo + Math.floor(Math.random() * 900)
}

export async function serverUp(port) {
  try {
    const r = await fetch(`http://localhost:${port}/`, { method: 'HEAD' })
    return r.ok || r.status === 200
  } catch { return false }
}

function stripLineComment(line) {
  let out = ''
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      out += c
      if (c === '\\') { out += line[i + 1] || ''; i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue }
    if (c === '/' && line[i + 1] === '/') break
    out += c
  }
  return out
}

export function flattenScript(script) {
  return String(script == null ? '' : script)
    .split(/\r?\n/)
    .map(stripLineComment)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const VALUELESS_STATEMENT = /^(return|const|let|var|async|function|class|if|for|while|do|switch|try|catch|finally|else|throw|break|continue|import|export|with|debugger|case|default)\b/

function splitStatements(src) {
  const out = []
  let depth = 0
  let quote = null
  let cur = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      cur += c
      if (c === '\\') { cur += src[i + 1] || ''; i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    if (c === ')' || c === ']' || c === '}') depth--
    if (c === ';' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) out.push(cur)
  return out.map(s => s.trim()).filter(Boolean)
}

function peelTrailingExpression(src) {
  let depth = 0
  let quote = null
  let cut = -1
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '(' || c === '[' || c === '{') { depth++; continue }
    if (c === ')' || c === ']') { depth--; continue }
    if (c === '}' && --depth === 0) cut = i + 1
  }
  if (cut < 0) return [src, '']
  const tail = src.slice(cut).trim()
  return tail ? [src.slice(0, cut).trim(), tail] : [src, '']
}

export function evalStep(script) {
  const src = flattenScript(script).replace(/;+\s*$/, '')
  if (!src) return null
  let stmts = splitStatements(src)
  let last = stmts[stmts.length - 1]
  const [head, tail] = peelTrailingExpression(last)
  if (tail) { stmts = [...stmts.slice(0, -1), head, tail]; last = tail }
  const isValue = !VALUELESS_STATEMENT.test(last) && (!!tail || !last.startsWith('{'))
  const valued = isValue ? [...stmts.slice(0, -1), `return (${last})`] : stmts
  return `(async () => { ${valued.join('; ')} })()`
}

export function buildBody({ url, screenshot, script }) {
  const lines = [ENGINE_CDP]
  if (url) lines.push(`url=${url}`)
  if (screenshot) lines.push(`screenshot=${screenshot === true ? DEFAULT_SCREENSHOT : screenshot}`)
  const expr = evalStep(script)
  if (expr) lines.push(`eval=${expr}`)
  return lines.join('\n') + '\n'
}

export async function dispatchBrowser(body, opts = {}) {
  const attempts = Number(opts.attempts || process.env.GM_BROWSER_ATTEMPTS || 3)
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try { return await dispatchCrawlOnce(body, opts) }
    catch (e) {
      lastErr = e
      if (!/orphaned|poisoned Store|wasm_aborted|websocket error|navigated or closed/.test(e.message)) throw e
      process.stderr.write(`[crawl] transient daemon failure, retry ${i + 1}/${attempts - 1}: ${e.message.slice(0, 90)}\n`)
      await wait(5000)
    }
  }
  throw lastErr
}

async function dispatchCrawlOnce(body, { pollMs = 2000, deadlineMs = 600000, timeoutMs = 0 } = {}) {
  const root = spoolRoot()
  const inDir = path.join(root, SPOOL_IN)
  const outDir = path.join(root, SPOOL_OUT)
  try { fs.mkdirSync(inDir, { recursive: true }) }
  catch (e) { throw new Error(`crawl spool inbox unusable at ${inDir} -- is the gm daemon running for this project? (${e.message})`) }

  const session = sessionId()
  let id = nextTaskId()
  const inName = () => `${session}-${id}.txt`
  const outName = () => `${VERB}-${session}-${id}.json`
  while (fs.existsSync(path.join(outDir, outName())) || fs.existsSync(path.join(inDir, inName()))) id++

  const tmp = path.join(inDir, `${inName()}.tmp`)
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, path.join(inDir, inName()))

  const outFile = path.join(outDir, outName())
  const wallDeadline = Date.now() + (Number(timeoutMs) > 0 ? Number(timeoutMs) : deadlineMs)
  const t0 = Date.now()
  while (Date.now() - t0 < deadlineMs && Date.now() < wallDeadline) {
    if (fs.existsSync(outFile)) {
      let parsed
      try { parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')) }
      catch { await wait(250); continue }
      if (parsed.error_code === 'dispatch_orphaned') throw new Error(`${VERB} verb orphaned (task ${id}): the daemon died mid-call. Re-run.`)
      if (parsed.error_code === 'unknown_verb') throw new Error(`${VERB} verb is not registered by this runner build: ${parsed.error}`)
      if (parsed.gate_denied) throw new Error(`${VERB} verb gate-denied: ${parsed.reason || 'unknown'}`)
      if (parsed.ok === false && parsed.error) throw new Error(`${VERB} verb error (task ${id}): ${parsed.error}`)
      if (parsed.timed_out) throw new Error(`${VERB} verb timed out (task ${id}) after ${parsed.duration_ms}ms`)
      if (typeof parsed.exit_code === 'number' && parsed.exit_code !== 0) throw new Error(`${VERB} verb failed (task ${id}): ${parsed.stderr || 'no stderr'}`)
      const evals = (parsed.pages || []).filter(p => p && p.op === 'eval')
      if (!evals.length && /\neval=/.test(`\n${body}`)) throw new Error(`${VERB} verb returned no eval result (task ${id}); pages=${JSON.stringify(parsed.pages || []).slice(0, 300)}`)
      const result = evals.length ? evals[evals.length - 1].value : null
      return { taskId: id, result, durationMs: parsed.duration_ms, debug: parsed.stderr ? { stderr: parsed.stderr } : null }
    }
    await wait(pollMs)
  }
  throw new Error(`${VERB} verb produced no response for task ${id} within ${Math.min(deadlineMs, Number(timeoutMs) > 0 ? Number(timeoutMs) : deadlineMs)}ms`)
}

export const TERRAIN_READY_SNIPPET = `
const __t0 = Date.now();
let __t = null;
while (Date.now() - __t0 < READY_MS) {
  __t = window.__terrain;
  if (__t && __t.planet && __t.frame) break;
  await new Promise(r => setTimeout(r, 1000));
}
if (!__t || !__t.frame) return { __error: 'terrain probe not ready', app: !!window.__app, terrain: !!window.__terrain };
const __R = __t.planet && __t.planet.render;
const __probeHeights = __t.planet && __t.planet.probeHeights;
const __backend = __R && __R.sampleGroundMSync ? 'legacygl' : (typeof __probeHeights === 'function' ? 'webgpu' : null);
if (!__backend) return { __error: 'no gpu height sampler on this backend', frame: true, isTSL: !!(__t.planet && __t.planet.isTSL), hasRender: !!__R, hasProbeHeights: typeof __probeHeights, legacyGlHint: 'height sampling needs planet.render.sampleGroundMSync (legacy GL boot) or planet.probeHeights (WebGPU/TSL boot)' };
async function __sampleHeights(dirs) {
  if (__backend === 'webgpu') return Array.from(await __probeHeights(dirs));
  const out = [];
  for (const d of dirs) {
    let v = __R.sampleGroundMSync(d);
    for (let k = 0; k < 8 && !(v != null && isFinite(v)); k++) {
      __R.sampleGroundM(d);
      await new Promise(r => requestAnimationFrame(r));
      v = __R.sampleGroundMSync(d);
    }
    out.push(v);
  }
  return out;
}
try {
  const __warm = await __sampleHeights([__t.frame.localToDir(0, 0)]);
  if (!__warm.length) return { __error: 'gpu height sampler returned no height', backend: __backend };
  if (!__warm.every(v => v != null && isFinite(v))) return { __error: 'gpu height sampler returned a non-finite height', backend: __backend, warm: String(__warm[0]) };
} catch (e) {
  return { __error: 'gpu height sampler failed on this backend (' + __backend + '): ' + ((e && e.message) || e) };
}
`.trim()

export const GPU_PROBE_SCRIPT = `
const __c = document.createElement('canvas');
let __renderer = null, __vendor = null;
try { const __gl = __c.getContext('webgl2') || __c.getContext('webgl'); const __d = __gl && __gl.getExtension('WEBGL_debug_renderer_info'); if (__d) { __renderer = __gl.getParameter(__d.UNMASKED_RENDERER_WEBGL) || null; __vendor = __gl.getParameter(__d.UNMASKED_VENDOR_WEBGL) || null; } } catch (e) {}
const __haystack = [__renderer, __vendor].filter(Boolean).join(' | ');
return { renderer: __renderer, vendor: __vendor, haystack: __haystack, accelerated: __haystack.length > 0 && !/swiftshader|llvmpipe|softwarerasterizer|basic render|mesa offscreen|subzero/i.test(__haystack) };
`.trim()

export const GPU_ARGS_UNSUPPORTED = 'the gm crawl verb takes no launch args, so a rasterizer cannot be selected here; drive scripts/lib/gpu-probe.mjs (CDP, real Chrome) when the rasterizer class must be pinned'

export function drainedSampleGroundMExpr(expr) {
  const evaluated = `await (${expr})`
  return [`${evaluated};`, 'await new Promise(r => requestAnimationFrame(r));', `return ${evaluated};`].join('\n')
}

export function terrainScript(userScript, { readyMs = 90000 } = {}) {
  return `${TERRAIN_READY_SNIPPET.replace('READY_MS', String(readyMs))}\n${userScript}`
}

export const HEIGHT_SAMPLER_BACKENDS = ['legacygl', 'webgpu']
export const HEIGHT_SAMPLER_BACKEND_SHIM = 'the ready snippet exposes __sampleHeights(dirs) -> Promise<number[]> on both boots: planet.probeHeights on WebGPU/TSL, planet.render.sampleGroundM/Sync with an eight-frame harvest retry on legacy GL'

export async function withGpuPage(opts, fn) {
  const {
    port = Number(process.env.PORT || 8090),
    requireProbe = true,
    readyMs = Number(process.env.GPU_EVAL_READY_MS || 90000),
    timeoutMs = Number(process.env.GPU_EVAL_TIMEOUT_MS || 300000),
    angle = null,
    backend = 'legacygl',
  } = opts || {}
  if (!HEIGHT_SAMPLER_BACKENDS.includes(backend)) throw new Error(`backend must be one of ${HEIGHT_SAMPLER_BACKENDS.join('|')}, got '${backend}'`)
  const url = (opts && opts.url) || `http://localhost:${port}/?singleplayer${backend === 'legacygl' ? '&legacygl=1' : ''}&nc=${Date.now()}`

  if (angle) throw new Error(GPU_ARGS_UNSUPPORTED)
  if (!(await serverUp(port))) throw new Error(`server not up on :${port} -- start it (PORT=${port} node server.js)`)

  const run = async (script, extra = {}) => {
    const useProbe = extra.probe === undefined ? requireProbe : extra.probe
    const budgetMs = extra.timeoutMs || timeoutMs
    const body = buildBody({
      url: extra.url === undefined ? url : extra.url,
      screenshot: extra.screenshot,
      script: useProbe ? terrainScript(script, { readyMs }) : script,
    })
    const r = await dispatchBrowser(body, { deadlineMs: budgetMs + 120000, timeoutMs: budgetMs })
    if (r.result && r.result.__error) throw new Error(`${r.result.__error} (app=${r.result.app}, terrain=${r.result.terrain})`)
    return r.result
  }

  const screenshot = (file) => run('', { screenshot: file || true, probe: false })
  const probeGpu = async () => {
    const gpu = await run(GPU_PROBE_SCRIPT, { probe: false })
    if (!gpu || typeof gpu !== 'object') throw new Error(`gpu probe returned ${JSON.stringify(gpu)} instead of a probe object`)
    return gpu
  }

  return fn(run, { screenshot, probeGpu, url, port })
}
