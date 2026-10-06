import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SPOOL_IN = 'in/browser'
const SPOOL_OUT = 'out'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function spoolRoot() {
  return process.env.GM_SPOOL_ROOT
    ? path.resolve(process.env.GM_SPOOL_ROOT)
    : path.join(REPO_ROOT, '.gm', 'exec-spool')
}

function sessionId() {
  const s = process.env.SESSION_ID || process.env.GM_SESSION_ID
  if (!s) throw new Error('SESSION_ID is required: the browser verb rejects an empty session. Export SESSION_ID=<id> before running this script.')
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

export function buildBody({ url, timeoutMs, screenshot, script }) {
  const lines = []
  if (timeoutMs) lines.push(`timeout=${timeoutMs}`)
  if (url) lines.push(`url=${url}`)
  if (screenshot) lines.push(screenshot === true ? 'screenshot' : `screenshot=${screenshot}`)
  lines.push(script)
  return lines.join('\n')
}

export async function dispatchBrowser(body, opts = {}) {
  const attempts = Number(opts.attempts || process.env.GM_BROWSER_ATTEMPTS || 3)
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try { return await dispatchBrowserOnce(body, opts) }
    catch (e) {
      lastErr = e
      if (!/orphaned|poisoned Store|wasm_aborted|websocket error|navigated or closed/.test(e.message)) throw e
      process.stderr.write(`[browser] transient daemon failure, retry ${i + 1}/${attempts - 1}: ${e.message.slice(0, 90)}\n`)
      await wait(5000)
    }
  }
  throw lastErr
}

async function dispatchBrowserOnce(body, { pollMs = 2000, deadlineMs = 600000 } = {}) {
  const root = spoolRoot()
  const inDir = path.join(root, SPOOL_IN)
  const outDir = path.join(root, SPOOL_OUT)
  if (!fs.existsSync(inDir)) throw new Error(`browser spool inbox missing at ${inDir} -- is the gm daemon running for this project?`)

  let id = nextTaskId()
  while (fs.existsSync(path.join(outDir, `browser-${id}.json`)) || fs.existsSync(path.join(inDir, `${id}.txt`))) id++

  sessionId()
  fs.writeFileSync(path.join(inDir, `${id}.txt`), body)

  const outFile = path.join(outDir, `browser-${id}.json`)
  const t0 = Date.now()
  while (Date.now() - t0 < deadlineMs) {
    if (fs.existsSync(outFile)) {
      let parsed
      try { parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')) }
      catch { await wait(250); continue }
      if (parsed.error_code === 'dispatch_orphaned') throw new Error(`browser verb orphaned (task ${id}): the daemon died mid-call. Re-run.`)
      if (parsed.gate_denied) throw new Error(`browser verb gate-denied: ${parsed.reason || 'unknown'}`)
      if (parsed.ok === false && parsed.error) throw new Error(`browser verb error (task ${id}): ${parsed.error}`)
      const d = parsed.data || parsed
      if (d.timed_out) throw new Error(`browser verb timed out (task ${id}) after ${d.duration_ms}ms`)
      if (d.exit_code !== 0) throw new Error(`browser verb failed (task ${id}): ${d.stderr || 'no stderr'}${d.debug && d.debug.hint ? ` [hint: ${d.debug.hint}]` : ''}`)
      return { taskId: id, result: d.result, durationMs: d.duration_ms, debug: d.debug || null }
    }
    await wait(pollMs)
  }
  throw new Error(`browser verb produced no response for task ${id} within ${deadlineMs}ms`)
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
if (!__R || !__R.sampleGroundMSync) return { __error: 'no gpu height sampler on this backend', frame: true, isTSL: !!(__t.planet && __t.planet.isTSL), hasRender: !!__R, hasProbeHeights: typeof (__t.planet && __t.planet.probeHeights), legacyGlHint: 'the gpu height sampler lives on planet.render, which only the legacy GL boot builds' };
__R.sampleGroundM(__t.frame.localToDir(0, 0));
await new Promise(r => requestAnimationFrame(r));
`.trim()

export const GPU_PROBE_SCRIPT = `
const __c = document.createElement('canvas');
let __renderer = null, __vendor = null;
try { const __gl = __c.getContext('webgl2') || __c.getContext('webgl'); const __d = __gl && __gl.getExtension('WEBGL_debug_renderer_info'); if (__d) { __renderer = __gl.getParameter(__d.UNMASKED_RENDERER_WEBGL) || null; __vendor = __gl.getParameter(__d.UNMASKED_VENDOR_WEBGL) || null; } } catch (e) {}
const __haystack = [__renderer, __vendor].filter(Boolean).join(' | ');
return { renderer: __renderer, vendor: __vendor, haystack: __haystack, accelerated: __haystack.length > 0 && !/swiftshader|llvmpipe|softwarerasterizer|basic render|mesa offscreen|subzero/i.test(__haystack) };
`.trim()

export const GPU_ARGS_UNSUPPORTED = 'the gm browser verb takes no launch args, so a rasterizer cannot be selected here; drive scripts/lib/gpu-probe.mjs (CDP, real Chrome) when the rasterizer class must be pinned'

export function drainedSampleGroundMExpr(expr) {
  const evaluated = `await (${expr})`
  return [`${evaluated};`, 'await new Promise(r => requestAnimationFrame(r));', `return ${evaluated};`].join('\n')
}

export function terrainScript(userScript, { readyMs = 90000 } = {}) {
  return `${TERRAIN_READY_SNIPPET.replace('READY_MS', String(readyMs))}\n${userScript}`
}

export const HEIGHT_SAMPLER_BACKENDS = ['legacygl', 'webgpu']
export const HEIGHT_SAMPLER_ONLY_ON_LEGACY_GL = 'planet.render.sampleGroundM/Sync exists only on the legacy GL path; the WebGPU/TSL boot exposes planet.probeHeights instead, so height sampling must run with backend=legacygl'

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
    const body = buildBody({
      url: extra.url === undefined ? url : extra.url,
      timeoutMs: extra.timeoutMs || timeoutMs,
      screenshot: extra.screenshot,
      script: useProbe ? terrainScript(script, { readyMs }) : script,
    })
    const r = await dispatchBrowser(body, { deadlineMs: (extra.timeoutMs || timeoutMs) + 120000 })
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
