#!/usr/bin/env node
// Grass distance-density FADE -- browser arm (visual + counted work units).
//
// PERF-grass-distance-density-fade-1013 pinned everything the gpu-free arm can see (instances,
// triangles, the draw ring, the near density, and the two no-pop invariants). What it cannot see is
// the criterion that needs pixels: that the drop-off reads as a GROWTH and not a step at near / mid /
// far, and that the enlarged, camera-facing far clumps still read as grass.
//
// This arm is the browser half. It boots the real page on a pinned adapter, asserts the renderer is
// WebGPURenderer on the webgpu backend (a silent fallback to WebGL would invalidate every number
// here), and then measures three things on ONE instrument:
//
//   1. the grass instance and triangle inventory, per DISTANCE band, read out of the live instancer
//      (window.__grass._cells), so the browser arm is comparable to the gpu-free arm's counts;
//   2. the per-band apparent density, as the number of pixels grass actually paints -- measured by
//      hiding the grass batches and diffing the same frame, against a NOISE floor measured by
//      diffing two grass-on frames. A band whose signal is under its own noise is reported as
//      inconclusive, never as a measured number;
//   3. popping, which frame time cannot see: every blade present in the instancer is matched frame
//      to frame by (chunk, slot) and a blade that LEAVES while its shader fade was still above zero
//      is a pop. Counted in the page, over a real walk, at the real streaming cadence.
//
// It reaches cdp-browser / WebGPU, so it rides behind SPOINT_GPU_WITNESS and never runs in the
// gpu-free arm of scripts/check.mjs. Run under scripts/gpulock.mjs:
//   SPOINT_GPU_WITNESS=1 node scripts/gpulock.mjs run grass-density-fade-visual -- \
//     node scripts/grass-density-fade-visual-witness.mjs --gpu=amd --rebuild-bundle
import { resolve, dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateSync, deflateSync } from 'node:zlib'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { gpuArgs, assertGpu } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import {
  assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE,
} from './lib/served-client-root.mjs'
import { flagNumber } from './lib/witness-args.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, 'data', 'perf-run')

if (process.env.SPOINT_GPU_WITNESS !== '1') {
  console.log('SKIP grass-density-fade-visual-witness: SPOINT_GPU_WITNESS is not 1 (reaches cdp-browser/WebGPU, not run in the gpu-free arm)')
  process.exit(0)
}

const argv = process.argv.slice(2)
const ARGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq > 0) ARGS.set(a.slice(2, eq), a.slice(eq + 1))
  else ARGS.set(a.slice(2), (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : true)
}
const flag = (n, d) => (ARGS.has(n) ? ARGS.get(n) : d)

const GPU = flag('gpu', 'amd')
const AT = String(flag('at', '-15,-12.5'))
const LABEL = String(flag('label', 'run'))
const TOD_FRACTION = flagNumber(flag, 'tod', 0.34, argv)
const SETTLE_MS = flagNumber(flag, 'settle', 25000, argv)
const WALK_MS = flagNumber(flag, 'walk', 20000, argv)
const WALK_SPEED = flagNumber(flag, 'walk-speed', 7, argv)
const VIEWPORT_W = flagNumber(flag, 'w', DEFAULT_VIEWPORT.width, argv)
const VIEWPORT_H = flagNumber(flag, 'h', DEFAULT_VIEWPORT.height, argv)
const BANDS = String(flag('bands', '16,40,80')).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
const EXPECT_VENDOR = flag('expect-vendor', GPU)
const DIFF_CODE = flagNumber(flag, 'diff-code', 12, argv)  // summed |dr|+|dg|+|db| that counts as a changed pixel
const SHELL_M = flagNumber(flag, 'shell', 4, argv)            // distance shell of the continuity profile
const SHELL_JUMP_MAX = flagNumber(flag, 'shell-jump-max', 2.5, argv)
// Sampling every Nth frame: the audit walks every placed blade, and a sample that costs more than a
// frame steals the input rate the walk needs, which slows the player instead of the instrument.
const AUDIT_EVERY = flagNumber(flag, 'audit-every', 6, argv)
// Samples a cell's present count must hold still before an absent blade in it counts as a pop.
const AUDIT_SETTLE_SAMPLES = flagNumber(flag, 'audit-settle-samples', 20, argv)
const STEP_M = flagNumber(flag, 'step', 1, argv)              // relocation step of the fallback travel
const TELEPORT_STEPS = flagNumber(flag, 'steps', 40, argv)
const STEP_WAIT_MS = flagNumber(flag, 'step-wait', 450, argv)
const STEP_SAMPLES = flagNumber(flag, 'step-samples', 1, argv)
const BASELINE_INSTANCES = flagNumber(flag, 'baseline-instances', 105188, argv)
const LAUNCH_ARGS = [...gpuArgs({ accelerated: true }), ...vendorPinArgs(GPU)]

// The fade law lives in src/terrain/GrassPlacement.js and is not reachable from the page, so the
// browser arm takes the real function's source instead of a second copy of the formula.
await installSpecifierHooks()
const GP = await import(pathToFileURL(resolve(ROOT, 'src', 'terrain', 'GrassPlacement.js')).href)
// It closes over GRASS_DENSITY, so the page gets that object too -- the real constants, not a copy.
const DENSITY_LITERAL = JSON.stringify({
  FULL_R: GP.GRASS_DENSITY.FULL_R, P: GP.GRASS_DENSITY.P, FADE_M: GP.GRASS_DENSITY.FADE_M,
  LEAD_M: GP.GRASS_DENSITY.LEAD_M, EDGE_M: GP.GRASS_DENSITY.EDGE_M,
})
const EDGE_SRC = `(function () { const GRASS_DENSITY = ${DENSITY_LITERAL}; return ${GP.grassBladeEdgeM.toString()} })()`
const FADE_M = GP.GRASS_DENSITY.FADE_M
const LEAD_M = GP.GRASS_DENSITY.LEAD_M
const PF_FLOATS = 7
const XF_FLOATS = 9

// ---------------------------------------------------------------- PNG (no dependency, no native module)
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let p = 8
  let w = 0, h = 0, depth = 0, color = 0
  const idat = []
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported here')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  if (depth !== 8 || (color !== 2 && color !== 6)) throw new Error(`unsupported PNG: depth=${depth} colorType=${color}`)
  const ch = color === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(stride * h)
  let q = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[q++]
    const line = raw.subarray(q, q + stride)
    q += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0
      const b = prev ? prev[i] : 0
      const c = (prev && i >= ch) ? prev[i - ch] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[i] = v & 0xff
    }
  }
  return { w, h, ch, pixels: out }
}
function encodePNG(w, h, rgba) {
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const chunk = (type, data) => {
    const b = Buffer.alloc(8 + data.length + 4)
    b.writeUInt32BE(data.length, 0)
    b.write(type, 4, 'ascii')
    data.copy(b, 8)
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length)
    return b
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}
function cropRGBA(img, x0, y0, cw, chh) {
  const out = Buffer.alloc(cw * chh * 4, 0)
  for (let y = 0; y < chh; y++) {
    const sy = y0 + y
    if (sy < 0 || sy >= img.h) continue
    for (let x = 0; x < cw; x++) {
      const sx = x0 + x
      if (sx < 0 || sx >= img.w) continue
      const s = (sy * img.w + sx) * img.ch
      const d = (y * cw + x) * 4
      out[d] = img.pixels[s]; out[d + 1] = img.pixels[s + 1]; out[d + 2] = img.pixels[s + 2]; out[d + 3] = img.ch === 4 ? img.pixels[s + 3] : 255
    }
  }
  return { w: cw, h: chh, ch: 4, pixels: out }
}
// A pixel is "grass painted" when hiding the grass batches changed it. The noise floor is the same
// diff between two frames in which nothing was hidden, so animated weather and water cannot be
// counted as grass.
function diffCount(a, b, threshold) {
  if (a.w !== b.w || a.h !== b.h) throw new Error('diff of two different-sized images')
  let n = 0
  const px = a.w * a.h
  for (let i = 0; i < px; i++) {
    const oa = i * a.ch, ob = i * b.ch
    const d = Math.abs(a.pixels[oa] - b.pixels[ob]) + Math.abs(a.pixels[oa + 1] - b.pixels[ob + 1]) + Math.abs(a.pixels[oa + 2] - b.pixels[ob + 2])
    if (d > threshold) n++
  }
  return { changed: n, pixels: px, frac: px ? n / px : 0 }
}

// ---------------------------------------------------------------- in-page probe
// Installed before any page script runs, so it sees the device three creates.
const PROBE = `(() => {
  const W = window
  W.__gdfv = { installed: true, errors: [], audit: null }
  const P = W.GPUDevice && GPUDevice.prototype
  if (P && !P.__gdfvHooked) {
    P.__gdfvHooked = true
    // three assigns device.onuncapturederror = fn; a WebGPU pipeline that fails validation
    // dispatches nothing and surfaces nothing else, so this is the only place it can be seen.
    Object.defineProperty(P, 'onuncapturederror', {
      configurable: true,
      get() { return this.__gdfvUncap },
      set(fn) {
        this.__gdfvUncap = function (e) {
          try { W.__gdfv.errors.push(String((e && e.error && e.error.message) || (e && e.message) || e)) } catch (_) {}
          return typeof fn === 'function' ? fn.call(this, e) : undefined
        }
      },
    })
  }
  const vec = (x, y, z) => ({
    x, y, z,
    applyMatrix4(m) {
      const e = m.elements
      const X = this.x, Y = this.y, Z = this.z
      const w = 1 / (e[3] * X + e[7] * Y + e[11] * Z + e[15])
      this.x = (e[0] * X + e[4] * Y + e[8] * Z + e[12]) * w
      this.y = (e[1] * X + e[5] * Y + e[9] * Z + e[13]) * w
      this.z = (e[2] * X + e[6] * Y + e[10] * Z + e[14]) * w
      return this
    },
  })
  // Screen row of a world point, from the camera the frame was rendered with.
  W.__gdfvProject = function (x, y, z, vw, vh) {
    const cam = W.__camera
    if (!cam || !cam.projectionMatrix || !cam.matrixWorldInverse) return null
    const v = vec(x, y, z)
    v.applyMatrix4(cam.matrixWorldInverse); v.applyMatrix4(cam.projectionMatrix)
    return { sx: (v.x * 0.5 + 0.5) * vw, sy: (1 - (v.y * 0.5 + 0.5)) * vh, z: v.z }
  }
  W.__gdfvStartAudit = function (opts) {
    const G = W.__grass
    if (!G) return { ok: false, why: 'window.__grass is absent' }
    const edgeOf = new Function('return ' + opts.edgeSrc)()
    const st = { frames: 0, samples: 0, samplesSettled: 0, popOut: 0, popOutAtRest: 0, popOutMoving: 0, popOutWorstFade: 0, missingVisible: 0, missingVisibleAtRest: 0, missingVisibleMoving: 0, nearNotFull: 0, nearNotFullSettled: 0, overreach: 0, worstOverreachM: -Infinity, maxFadeAtRemoval: 0, lastX: NaN, lastZ: NaN }
    const prev = new Map()
    // A chunk the ring has only just delivered is allowed time to instance the blades it placed: an
    // absent blade in a cell that is still filling is streaming lag, not a pop. A cell carries the
    // claim only once its own present count has stopped changing for o.settleSamples -- not once it
    // has merely been seen for a few samples, which is a fraction of the time a chunk needs.
    const cellState = new Map()
    let started = false
    const step = () => {
      requestAnimationFrame(step)
      st.frames++
      if (st.frames % opts.every !== 0) return
      const g = W.__grass
      if (!g || !g._cells) return
      const ss = g.streamState ? g.streamState() : null
      const focus = ss ? ss.focus : null
      if (!focus || !Number.isFinite(focus[0])) return
      const moved = started && (Math.abs(focus[0] - st.lastX) > 0.01 || Math.abs(focus[1] - st.lastZ) > 0.01)
      st.lastX = focus[0]; st.lastZ = focus[1]
      // A sample taken while the ring is still streaming is not a verdict on the fade: a blade the
      // chunk has not delivered yet is absent for a reason that has nothing to do with the law, so
      // the settled counters are the ones that carry the claim.
      const loading = !!(ss && ((ss.missing || 0) > 0 || (ss.deferred || 0) > 0))
      const px = focus[0], pz = focus[1]
      const fullR = g.densityFullR, capM = g.densityEdgeM
      let placed = 0, present = 0
      if (st.samples % 50 === 0) for (const k of cellState.keys()) if (!g._cells.has(k)) cellState.delete(k)
      for (const [key, cell] of g._cells) {
        if (!cell || !cell.xf || !cell.pf || !cell.on) continue
        let cs = cellState.get(key)
        if (!cs) { cs = { count: -1, stable: 0 }; cellState.set(key, cs) }
        const resident = !loading && cs.stable >= opts.settleSamples
        let presentInCell = 0
        const n = cell.on.length
        for (let i = 0; i < n; i++) {
          const bOff = i * opts.xfFloats
          const dx = cell.xf[bOff] - px, dz = cell.xf[bOff + 2] - pz
          const d = Math.sqrt(dx * dx + dz * dz)
          const edge = edgeOf(cell.pf[i * opts.pfFloats], fullR, capM)
          let fade = (edge - d) / opts.fadeM
          fade = fade < 0 ? 0 : (fade > 1 ? 1 : fade)
          const isPresent = cell.on[i] === 1
          placed++
          if (isPresent) { present++; presentInCell++ }
          const id = key * 100000 + i
          // Only blades the shader is still showing can pop: a blade past its own fade is invisible
          // by construction, so it is dropped from the map instead of being tracked. That keeps the
          // per-sample cost (and therefore the frame rate it steals from the page) on the transition
          // shell alone -- a full map of every placed blade throttled the page to a handful of fps,
          // which starved the input loop and slowed the walk to a crawl.
          if (fade <= 0) { prev.delete(id) }
          else {
            const prevV = prev.get(id)
            if (prevV !== undefined) {
              const prevPresent = prevV > 0
              const prevFade = Math.abs(prevV) - 1
              // A blade that leaves the instancer while the shader was still showing it is a pop.
              if (prevPresent && !isPresent && prevFade > 1e-3) {
                st.popOut++
                if (moved) st.popOutMoving++
                else st.popOutAtRest++
                if (prevFade > st.popOutWorstFade) st.popOutWorstFade = prevFade
              }
            }
            prev.set(id, isPresent ? fade + 1 : -(fade + 1))
          }
          if (fade > 0 && !isPresent) {
            st.missingVisible++
            if (moved) st.missingVisibleMoving++
            else st.missingVisibleAtRest++
          }
          if (d <= fullR) { if (fade < 1) { st.nearNotFull++; if (!loading) st.nearNotFullSettled++ } }
          if (isPresent) {
            const over = d - (edge + opts.leadM)
            if (over > st.worstOverreachM) st.worstOverreachM = over
            if (over > opts.slackM) st.overreach++
          }
        }
        if (presentInCell === cs.count) cs.stable++
        else { cs.count = presentInCell; cs.stable = 0 }
      }
      st.samples++
      if (!loading) st.samplesSettled++
      st.placed = placed
      st.present = present
      started = true
    }
    requestAnimationFrame(step)
    W.__gdfv.audit = st
    return { ok: true, started }
  }
})()`

const port = String(20000 + Math.floor(Math.random() * 20000))
process.env.WORLD = process.env.WORLD || 'tps-game'
process.env.PORT = port
process.env.SPOINT_NO_WATCH = '1'

rebuildIfRequested('grass-density-fade-visual')
const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
const server = await boot()
console.log('[grass-fade-visual] server on ' + port)

let browser
let failed = 0
const reasons = []
const checks = []
const expect = (name, ok, detail) => {
  checks.push({ check: name, ok: !!ok, detail })
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name + ': ' + detail)
  if (!ok) { failed++; reasons.push(name + ': ' + detail) }
}

try {
  browser = await chromium.launch({ args: LAUNCH_ARGS })
  const page = await browser.newPage({ viewport: { width: VIEWPORT_W, height: VIEWPORT_H } })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String((e && e.stack) || (e && e.message) || e)))
  await page._send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })
  const url = `http://localhost:${port}/?singleplayer&world=tps-game&at=${encodeURIComponent(AT)}&v=${Date.now()}`
  console.log('[grass-fade-visual] ' + url)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

  const servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: 'grass-fade-visual' })
  console.log(`[grass-fade-visual] served ${clientRootTag(servedRoot)} required=${CLIENT_ROOT_BUNDLE}`)

  const t0 = Date.now()
  let revealedAt = null
  while (Date.now() - t0 < 300000) {
    const r = await page.evaluate(() => ({ revealedAt: (window.__app && window.__app.revealedAt) || 0 })).catch(() => null)
    if (r && r.revealedAt) { revealedAt = r.revealedAt; break }
    await new Promise((r2) => setTimeout(r2, 250))
  }
  if (!revealedAt) { failed = 1; reasons.push('scenery never built, so no frame was captured') }
  console.log('[grass-fade-visual] scenery-built at ' + revealedAt + 'ms')

  const renderer = await page.evaluate(() => {
    const ri = window.__rendererInfo || null
    const r = (window.__app && (window.__app.renderer || (window.__app.engine && window.__app.engine.renderer))) || null
    return {
      info: ri,
      isWebGPURenderer: r ? !!r.isWebGPURenderer : null,
      backendIsWebGPU: r && r.backend ? !!r.backend.isWebGPUBackend : null,
      probeInstalled: !!(window.__gdfv && window.__gdfv.installed),
    }
  }).catch((e) => ({ error: e.message }))
  console.log('[grass-fade-visual] renderer ' + JSON.stringify(renderer))
  // A silent fallback to the WebGL backend of WebGPURenderer, or to the legacy WebGLRenderer, would
  // run a different shader path and invalidate every number below.
  expect('the page really runs WebGPURenderer on the webgpu backend',
    renderer.info && renderer.info.class === 'WebGPURenderer' && renderer.info.backend === 'webgpu' && renderer.backendIsWebGPU === true,
    `window.__rendererInfo class=${renderer.info && renderer.info.class} backend=${renderer.info && renderer.info.backend}, renderer.backend.isWebGPUBackend=${renderer.backendIsWebGPU}`)
  expect('the uncaptured-error hook is installed before the device', renderer.probeInstalled === true,
    'window.__gdfv.installed is ' + renderer.probeInstalled)

  const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: EXPECT_VENDOR })
  console.log('[grass-fade-visual] gpu ' + JSON.stringify({ rasterizer: gpu.rasterizer, renderer: gpu.renderer, vendor: gpu.adapter }))

  const tod = await page.evaluate((frac) => {
    const api = window.__timeOfDayApi
    if (!api) return { api: false }
    try { api.setPaused(true); api.setFraction(frac) } catch (_) {}
    return { api: true, fraction: api.getFraction ? api.getFraction() : null }
  }, TOD_FRACTION).catch((e) => ({ error: e.message }))
  console.log('[grass-fade-visual] time-of-day ' + JSON.stringify(tod))
  if (!tod.api) { failed = 1; reasons.push('window.__timeOfDayApi is absent, so the two captures are not comparable') }

  // Governor off: its own ticking would re-shed the tier between the captures.
  const frozen = await page.evaluate(() => {
    const rc = window.__renderControls
    if (rc && typeof rc.set === 'function') rc.set('qualityGovernorOff', true)
    // Wind would move every blade between the two frames of a diff, so it is pinned for the capture
    // window only. It is a page-local knob, never a code change.
    window.__grassWind = 0
    return { off: !!window.__qualityGovernorOff, wind: window.__grassWind }
  }).catch((e) => ({ error: e.message }))
  console.log('[grass-fade-visual] governor/wind ' + JSON.stringify(frozen))
  if (!frozen.off) { failed = 1; reasons.push('qualityGovernorOff could not be set, so a capture can be re-shed before it is read') }

  const tSettle = Date.now()
  while (Date.now() - tSettle < SETTLE_MS) await new Promise((r2) => setTimeout(r2, 2500))

  // ---- inventory, per distance band, out of the live instancer
  const inv = await page.evaluate((o) => {
    const g = window.__grass
    if (!g) return { ok: false, why: 'window.__grass is absent' }
    const tris = (im) => { const idx = im && im.geometry && im.geometry.index; return idx ? idx.count / 3 : null }
    const nearTris = tris(g._im), midTris = tris(g._imMid)
    const focus = g.streamState().focus
    const px = focus[0], pz = focus[1]
    const edges = o.bands.slice().sort((a, b) => a - b)
    const mk = () => edges.map(() => 0).concat([0])
    const placedB = mk(), presentB = mk(), fadeSumB = mk(), nearFullB = mk()
    const shellFade = [], shellCount = []
    let placed = 0, present = 0, maxPresentM = 0, maxFade1M = 0
    const edgeOf = new Function('return ' + o.edgeSrc)()
    for (const cell of g._cells.values()) {
      if (!cell || !cell.xf || !cell.pf || !cell.on) continue
      const n = cell.on.length
      for (let i = 0; i < n; i++) {
        const oo = i * o.xfFloats
        const dx = cell.xf[oo] - px, dz = cell.xf[oo + 2] - pz
        const d = Math.sqrt(dx * dx + dz * dz)
        let b = 0
        for (let k = 0; k < edges.length; k++) if (d >= edges[k]) b = k + 1
        const edge = edgeOf(cell.pf[i * o.pfFloats], g.densityFullR, g.densityEdgeM)
        let fade = (edge - d) / o.fadeM
        fade = fade < 0 ? 0 : (fade > 1 ? 1 : fade)
        const isPresent = cell.on[i] === 1
        placed++; placedB[b]++
        if (isPresent) {
          present++; presentB[b]++
          if (d > maxPresentM) maxPresentM = d
          if (fade >= 1 && d > maxFade1M) maxFade1M = d
        }
        fadeSumB[b] += fade
        if (fade >= 1) nearFullB[b]++
        // The growth-vs-step question, binned: every blade contributes its own fade to the shell it
        // stands in, so the profile below is what the eye reads as density on the way out. A step in
        // the law would show as a jump between two neighbouring shells; a growth does not.
        const s = Math.floor(d / o.shellM)
        shellFade[s] = (shellFade[s] || 0) + (isPresent ? fade : 0)
        shellCount[s] = (shellCount[s] || 0) + (isPresent ? 1 : 0)
      }
    }
    return {
      ok: true, focus: [px, pz], totalInstances: g.totalInstances, nearInstances: g.nearInstances,
      renderDistance: g.renderDistance, densityFullR: g.densityFullR, densityEdgeM: g.densityEdgeM,
      densityReachM: g.densityReachM, nearTris, midTris, placed, present, maxPresentM, maxFade1M,
      bands: edges, placedB, presentB, fadeSumB, nearFullB, shellFade, shellCount,
      triangles: g.nearInstances * nearTris + (g.totalInstances - g.nearInstances) * midTris,
    }
  }, { edgeSrc: EDGE_SRC, fadeM: FADE_M, leadM: LEAD_M, pfFloats: PF_FLOATS, xfFloats: XF_FLOATS, bands: BANDS, shellM: SHELL_M }).catch((e) => ({ ok: false, why: e.message }))
  console.log('[grass-fade-visual] inventory ' + JSON.stringify(inv))
  expect('the browser arm sees the grass instancer', inv.ok === true && inv.totalInstances > 0,
    inv.ok ? `totalInstances=${inv.totalInstances} nearInstances=${inv.nearInstances} ring=${inv.renderDistance}m` : `window.__grass unreadable: ${inv.why}`)

  // The drop-off, shell by shell: a step is a jump between two neighbouring shells, a growth is not.
  // Both shells have to carry a population worth comparing (5% of the peak shell) or the comparison
  // is a ratio of two numbers that are both going to zero at the ring.
  let worstShellJump = null
  if (inv.ok && Array.isArray(inv.shellFade)) {
    // Blades per square metre, not per shell: a shell at radius r holds a ring of area proportional
    // to r, so the raw count climbs to the full-density radius even when nothing about the law
    // changes there. The last stretch is the fade itself -- every blade's own edge is capped at
    // densityEdgeM and its fade is (edge - d)/FADE_M, so the profile has to fall to zero across
    // those metres by design, and a jump there is the fade working, not a step in the law.
    const sf = inv.shellFade.map((v) => v || 0)
    const density = sf.map((v, i) => {
      const r0 = i * SHELL_M, r1 = (i + 1) * SHELL_M
      return v / (Math.PI * (r1 * r1 - r0 * r0))
    })
    const reachShell = Math.max(2, Math.floor((inv.maxFade1M - SHELL_M) / SHELL_M))
    const peak = Math.max(...density.slice(0, reachShell))
    let worst = null
    for (let i = 0; i + 1 < Math.min(reachShell, density.length); i++) {
      const a = density[i], b = density[i + 1]
      if (a < peak * 0.05 || b < peak * 0.05) continue
      const jump = Math.max(a, b) / Math.min(a, b)
      if (!worst || jump > worst.jump) worst = { jump, fromM: i * SHELL_M, toM: (i + 1) * SHELL_M, a: +a.toFixed(3), b: +b.toFixed(3) }
    }
    worstShellJump = worst
    console.log('[grass-fade-visual] shell density (blade/m2 per ' + SHELL_M + 'm shell): ' +
      density.map((v, i) => `${i * SHELL_M}m=${v.toFixed(2)}`).join(' '))
  }
  expect('the drop-off is a growth and not a step',
    worstShellJump !== null && worstShellJump.jump <= SHELL_JUMP_MAX,
    worstShellJump ? `worst neighbouring-shell jump ${worstShellJump.jump.toFixed(2)}x between ${worstShellJump.fromM}m and ${worstShellJump.toM}m (${worstShellJump.a} -> ${worstShellJump.b} blade/m2), inside the ${inv.maxFade1M.toFixed(1)}m full-fade reach, budget ${SHELL_JUMP_MAX}x`
      : 'no two neighbouring shells both carried a population worth comparing, so the profile says nothing')

  // ---- which screen rows ARE each band: project the blades themselves, never a guessed pitch
  const rows = await page.evaluate((o) => {
    const g = window.__grass
    if (!g) return { ok: false }
    const cam = window.__camera
    if (!cam) return { ok: false, why: 'no window.__camera' }
    const focus = g.streamState().focus
    const px = focus[0], pz = focus[1]
    const edges = o.bands.slice().sort((a, b) => a - b)
    const acc = edges.map(() => []).concat([[]])
    let sampled = 0
    for (const cell of g._cells.values()) {
      if (!cell || !cell.xf || !cell.on) continue
      const n = cell.on.length
      for (let i = 0; i < n; i += o.stride) {
        if (cell.on[i] !== 1) continue
        const oo = i * o.xfFloats
        const dx = cell.xf[oo] - px, dz = cell.xf[oo + 2] - pz
        const d = Math.sqrt(dx * dx + dz * dz)
        const p = window.__gdfvProject(cell.xf[oo], cell.xf[oo + 1], cell.xf[oo + 2], o.vw, o.vh)
        if (!p || p.z > 1 || p.sy < 0 || p.sy >= o.vh || p.sx < 0 || p.sx >= o.vw) continue
        let b = 0
        for (let k = 0; k < edges.length; k++) if (d >= edges[k]) b = k + 1
        acc[b].push(p.sy)
        sampled++
      }
    }
    const q = (arr, f) => { if (!arr.length) return null; const s = arr.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(1) }
    return { ok: true, sampled, perBand: acc.map((a) => ({ n: a.length, p05: q(a, 0.05), p50: q(a, 0.5), p95: q(a, 0.95) })) }
  }, { bands: BANDS, xfFloats: XF_FLOATS, stride: 4, vw: VIEWPORT_W, vh: VIEWPORT_H }).catch((e) => ({ ok: false, why: e.message }))
  console.log('[grass-fade-visual] screen rows ' + JSON.stringify(rows))

  // ---- capture: two grass-on frames (the noise floor) then one with the grass batches hidden
  mkdirSync(OUT_DIR, { recursive: true })
  const shot = async (name) => {
    const p = resolve(OUT_DIR, `grass-fade-visual-${LABEL}-${name}.png`)
    const buf = await page.screenshot({ path: p })
    return { path: p, img: decodePNG(buf) }
  }
  const visible = (v) => page.evaluate((on) => {
    const g = window.__grass
    if (!g) return false
    for (const im of [g._im, g._imMid]) { const o = im && (im.mesh || im); if (o) o.visible = on }
    return true
  }, v)
  const frameA1 = await shot('a1')
  await new Promise((r2) => setTimeout(r2, 400))
  const frameA2 = await shot('a2')
  await visible(false)
  await new Promise((r2) => setTimeout(r2, 400))
  const frameB = await shot('nogras')
  await visible(true)
  await new Promise((r2) => setTimeout(r2, 400))
  const frameA3 = await shot('a3')

  // ---- per-band apparent density
  const bandRows = []
  const edges = BANDS.slice().sort((a, b) => a - b)
  // Farther blades sit higher on the screen, so the bands' rows descend with distance. Each band
  // owns the rows between the midpoints of its own median row and its neighbours': the windows are
  // then disjoint and each one is centred on the band it names, rather than sharing rows with it.
  const p50 = rows.ok ? rows.perBand.map((b) => b.p50) : null
  const windows = []
  if (p50 && p50.every((v) => v !== null)) {
    const bnd = []
    for (let i = 0; i + 1 < p50.length; i++) bnd.push(Math.round((p50[i] + p50[i + 1]) / 2))
    // Above the farthest blade there is no ground left to paint, so the outer band stops at the
    // highest row any blade reached instead of counting sky as "no grass here".
    const top = Math.max(0, Math.floor(Math.min(...rows.perBand.map((b) => (b.p05 === null ? Infinity : b.p05)))))
    for (let i = 0; i < p50.length; i++) {
      const hi = i === 0 ? VIEWPORT_H - 1 : bnd[i - 1] - 1
      const lo = i === p50.length - 1 ? Math.min(top, hi - 8) : bnd[i]
      windows.push({ lo: Math.max(0, lo), hi: Math.min(VIEWPORT_H - 1, hi) })
    }
  }
  const bandStats = []
  for (let i = 0; i < windows.length; i++) {
    const win = windows[i]
    const h = win.hi - win.lo
    const label = i === 0 ? `near [0,${edges[0]})m`
      : i < edges.length ? `[${edges[i - 1]},${edges[i]})m`
        : `far-beyond [${edges[edges.length - 1]},ring]m`
    if (h < 8) { bandStats.push({ band: label, rows: win, inconclusive: 'the band covers fewer than 8 screen rows at this pose' }); continue }
    const cA1 = cropRGBA(frameA1.img, 0, win.lo, VIEWPORT_W, h)
    const cA2 = cropRGBA(frameA2.img, 0, win.lo, VIEWPORT_W, h)
    const cB = cropRGBA(frameB.img, 0, win.lo, VIEWPORT_W, h)
    const noise = diffCount(cA1, cA2, DIFF_CODE)
    const signal = diffCount(cA2, cB, DIFF_CODE)
    const restored = diffCount(cA2, cropRGBA(frameA3.img, 0, win.lo, VIEWPORT_W, h), DIFF_CODE)
    const png = resolve(OUT_DIR, `grass-fade-visual-${LABEL}-band${i}.png`)
    writeFileSync(png, encodePNG(cA2.w, cA2.h, cA2.pixels))
    const row = {
      band: label, rows: win, pixels: signal.pixels,
      instances: inv.ok ? inv.presentB[i] : null,
      triangles: inv.ok ? inv.presentB[i] * (i === 0 ? inv.nearTris : inv.midTris) : null,
      grassPixels: signal.changed, grassFrac: +signal.frac.toFixed(5),
      noisePixels: noise.changed, noiseFrac: +noise.frac.toFixed(5),
      restoredPixels: restored.changed,
      signalOverNoise: noise.changed > 0 ? +(signal.changed / noise.changed).toFixed(2) : null,
      png,
    }
    bandStats.push(row)
    console.log(`[grass-fade-visual] band ${label} rows ${win.lo}..${win.hi}: instances=${row.instances} triangles=${row.triangles} grassPixels=${row.grassPixels} (${(row.grassFrac * 100).toFixed(2)}%) noise=${row.noisePixels} signal/noise=${row.signalOverNoise}`)
  }

  // ---- popping, over a real walk, counted in the page
  const auditStart = await page.evaluate((o) => (window.__gdfvStartAudit ? window.__gdfvStartAudit(o) : { ok: false, why: 'probe missing' }),
    { edgeSrc: EDGE_SRC, fadeM: FADE_M, leadM: LEAD_M, pfFloats: PF_FLOATS, xfFloats: XF_FLOATS, every: AUDIT_EVERY, settleSamples: AUDIT_SETTLE_SAMPLES, slackM: 8 }).catch((e) => ({ ok: false, why: e.message }))
  console.log('[grass-fade-visual] audit start ' + JSON.stringify(auditStart))
  if (!auditStart.ok) { failed = 1; reasons.push('the in-page fade audit could not start: ' + auditStart.why) }

  let walkedM = 0
  let pathM = 0
  let teleported = 0
  const pathSamples = []
  let preFlight = null
  let sentMove = null
  if (WALK_MS > 0) {
    // Real keyboard input, the way a player moves. __spoint.route's walk mode drives the app's input
    // bucket through a walker the input loop feeds, and a page that never armed one drives nothing
    // while still reporting ok -- so the movement is verified below, never assumed. The page also has
    // to be the front target or the key events go nowhere.
    await page._send('Page.bringToFront').catch(() => {})
    preFlight = await page.evaluate(() => ({
      focus: document.hasFocus(),
      connected: !!(window.__client && window.__client.connected),
      onGround: (window.__client && window.__client.getLocalState && window.__client.getLocalState().onGround) || null,
      boot: window.__spointBoot || null,
    })).catch((e) => ({ error: e.message }))
    const readPos = () => page.evaluate(() => (window.__client && window.__client.getLocalState ? window.__client.getLocalState().position : null)).catch(() => null)
    const start = await readPos()
    console.log('[grass-fade-visual] pre-flight ' + JSON.stringify(preFlight) + ' start=' + JSON.stringify(start))
    // Four legs, because one direction can be blocked by scenery: the audit needs the player to
    // actually travel, not to stand against a rock pressing W.
    const LEGS = ['KeyW', 'KeyA', 'KeyW', 'KeyD']
    const LEG_MS = Math.max(1000, Math.round(WALK_MS / LEGS.length))
    let prev = start
    for (const leg of LEGS) {
      await page.keyboard.down(leg)
      const tLeg = Date.now()
      while (Date.now() - tLeg < LEG_MS) {
        await new Promise((r2) => setTimeout(r2, 1000))
        const p = await readPos()
        if (p && prev) pathM += Math.hypot(p[0] - prev[0], p[2] - prev[2])
        if (p) { prev = p; pathSamples.push([+p[0].toFixed(2), +p[2].toFixed(2)]) }
        if (!sentMove) {
          sentMove = await page.evaluate(() => {
            const i = (window.__app || {}).sentInput || null
            return i ? { forward: !!i.forward, backward: !!i.backward, left: !!i.left, right: !!i.right } : null
          }).catch(() => null)
        }
      }
      await page.keyboard.up(leg)
    }
    // If the legs carried nobody -- a blocked pose, an input rate the page cannot sustain -- the arm
    // relocates in 8 m steps instead. Relocation is not a walk, but it is the one thing guaranteed
    // to move the focus, and an audit that never moved its focus says nothing about popping.
    let teleportedLocal = 0
    if (pathM < 20) {
      console.log('[grass-fade-visual] legs carried only ' + pathM.toFixed(1) + 'm -- relocating in ' + STEP_M + 'm steps instead')
      for (let i = 1; i <= TELEPORT_STEPS; i++) {
        // The target carries its own altitude: the relocation path otherwise asks the planet frame
        // for a ground height, and at this pose it answers none, which refuses every step.
        const target = { x: start[0], y: start[1], z: start[2] - i * STEP_M }
        const r = await page.evaluate((t) => {
          const s = window.__spoint
          if (!s || typeof s.teleport !== 'function') return { ok: false, why: 'window.__spoint.teleport is absent' }
          return s.teleport(t, { settle: false }).then((rep) => ({ ok: true, placed: rep.placed })).catch((e) => ({ ok: false, why: String((e && e.message) || e) }))
        }, target).catch((e) => ({ ok: false, why: e.message }))
        if (!r.ok) { console.log('[grass-fade-visual] relocation ' + i + ' failed: ' + r.why); break }
        teleportedLocal++
        teleported++
        for (let k = 0; k < STEP_SAMPLES; k++) {
          await new Promise((r2) => setTimeout(r2, STEP_WAIT_MS))
          const p = await readPos()
          if (p && prev) pathM += Math.hypot(p[0] - prev[0], p[2] - prev[2])
          if (p) { prev = p; pathSamples.push([+p[0].toFixed(2), +p[2].toFixed(2)]) }
        }
      }
    }
    const end = prev
    if (start && end) walkedM = Math.hypot(end[0] - start[0], end[2] - start[2])
    console.log('[grass-fade-visual] walk path ' + JSON.stringify(pathSamples) + ' end=' + JSON.stringify(end) + ' sentMove=' + JSON.stringify(sentMove))
  }
  const audit = await page.evaluate(() => (window.__gdfv && window.__gdfv.audit ? JSON.parse(JSON.stringify(window.__gdfv.audit)) : null)).catch((e) => ({ error: e.message }))
  const gpuErrors = await page.evaluate(() => (window.__gdfv ? window.__gdfv.errors.slice(0, 20) : [])).catch(() => [])
  console.log('[grass-fade-visual] audit ' + JSON.stringify(audit))
  console.log('[grass-fade-visual] uncaptured GPU errors: ' + gpuErrors.length + (gpuErrors.length ? ' first=' + String(gpuErrors[0]).slice(0, 200) : ''))

  const walkAudit = audit || {}
  expect('the walk actually carried the player along its legs', pathM > 20,
    `pathM=${pathM.toFixed(1)} netM=${walkedM.toFixed(1)}, ${pathSamples.length} sample(s), sentMove=${JSON.stringify(sentMove)}, preFlight=${JSON.stringify(preFlight)}`)
  expect('the fade audit sampled settled frames while the player moved', (walkAudit.samplesSettled || 0) > 30,
    `settled samples=${walkAudit.samplesSettled} of ${walkAudit.samples} over ${walkAudit.frames} frame(s)`)
  expect('no blade left the instancer while the shader was still showing it',
    (walkAudit.popOut || 0) === 0,
    `popOut=${walkAudit.popOut} (at rest ${walkAudit.popOutAtRest}, moving ${walkAudit.popOutMoving}) worst fade at removal ${(walkAudit.popOutWorstFade || 0).toFixed(4)}`)
  expect('no blade is absent while it should be visible', (walkAudit.missingVisibleAtRest || 0) === 0,
    `missingVisibleAtRest=${walkAudit.missingVisibleAtRest} of ${walkAudit.missingVisible} over ${pathM.toFixed(1)}m of travel in ${teleported} relocation step(s) of ${STEP_M}m` +
    ` -- the moving count ${walkAudit.missingVisibleMoving} is measured after a ${STEP_M}m jump of the focus, which is catch-up of the LOD revisit budget and not a pop, and it is reported, never gated`)
  expect('every blade inside the full-density radius is at full fade', (walkAudit.nearNotFullSettled || 0) === 0 && (walkAudit.nearNotFull || 0) === 0,
    `nearNotFull=${walkAudit.nearNotFull} (settled ${walkAudit.nearNotFullSettled}) inside ${inv.densityFullR}m`)
  expect('no blade is held past its own edge plus the lead', (walkAudit.overreach || 0) === 0,
    `overreach=${walkAudit.overreach}, worst overshoot ${(walkAudit.worstOverreachM === null || walkAudit.worstOverreachM === undefined ? 'n/a' : walkAudit.worstOverreachM.toFixed(2))}m of ${LEAD_M}m lead plus 8m of slack`)
  expect('no WebGPU pipeline failed validation', gpuErrors.length === 0, `${gpuErrors.length} uncaptured error(s)`)
  expect('the page raised no error', pageErrors.length === 0, `${pageErrors.length} page error(s)` + (pageErrors.length ? ': ' + pageErrors[0].slice(0, 160) : ''))

  for (const b of bandStats) {
    if (b.inconclusive) { failed = 1; reasons.push(`band ${b.band}: ${b.inconclusive}`); continue }
    if (!(b.instances > 0)) { failed = 1; reasons.push(`band ${b.band}: ${b.instances} grass instance(s) present, so the band says nothing about apparent density`) }
    if (!(b.grassPixels > 0)) { failed = 1; reasons.push(`band ${b.band}: hiding the grass batches changed ${b.grassPixels} pixel(s), so grass paints nothing there`) }
    if (b.noisePixels !== null && !(b.signalOverNoise === null || b.signalOverNoise >= 2)) {
      failed = 1
      reasons.push(`band ${b.band}: grass signal ${b.grassPixels} pixel(s) against a ${b.noisePixels}-pixel noise floor (${b.signalOverNoise}x), so the band's apparent density is not separable from animation`)
    }
  }

  const meta = {
    label: LABEL, url, at: AT, tod, gpu: { rasterizer: gpu.rasterizer, renderer: gpu.renderer, vendor: gpu.adapter },
    renderer, servedClientRoot: servedRoot.sha256, viewport: [VIEWPORT_W, VIEWPORT_H],
    baselineInstances: BASELINE_INSTANCES, inventory: inv, rows, bandStats, audit, worstShellJump,
    gpuErrors, pageErrors: pageErrors.slice(0, 5), walkedM: +walkedM.toFixed(2), pathM: +pathM.toFixed(2),
    pathSamples, preFlight, sentMove,
  }
  const metaPath = resolve(OUT_DIR, `grass-fade-visual-${LABEL}.json`)
  writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  console.log('[grass-fade-visual] meta ' + metaPath)
  if (inv.ok) {
    console.log(`[grass-fade-visual] MEASURED browser grass inventory: instances ${BASELINE_INSTANCES} -> ${inv.totalInstances} (near ${inv.nearInstances}), triangles ${inv.triangles}, ring ${inv.renderDistance}m, full size to ${inv.maxFade1M.toFixed(1)}m, last blade at ${inv.maxPresentM.toFixed(1)}m`)
  }
  console.log(`[grass-fade-visual] MEASURED drop-off: worst neighbouring-shell jump ${worstShellJump ? worstShellJump.jump.toFixed(2) + 'x at ' + worstShellJump.fromM + '-' + worstShellJump.toM + 'm' : 'n/a'} over ${SHELL_M}m shells, budget ${SHELL_JUMP_MAX}x`)
  for (const b of bandStats) {
    console.log(`[grass-fade-visual] MEASURED band ${b.band}: instances=${b.instances} triangles=${b.triangles} grassPixels=${b.grassPixels}/${b.pixels} (${(b.grassFrac * 100).toFixed(2)}%) noise=${b.noisePixels} signal/noise=${b.signalOverNoise} png=${b.png || 'none'}`)
  }
  console.log(`[grass-fade-visual] MEASURED popping: popOut=${walkAudit.popOut} (atRest=${walkAudit.popOutAtRest} moving=${walkAudit.popOutMoving}) missingVisible=${walkAudit.missingVisible} (atRest=${walkAudit.missingVisibleAtRest} moving=${walkAudit.missingVisibleMoving}) nearNotFull=${walkAudit.nearNotFull} overreach=${walkAudit.overreach} over ${pathM.toFixed(1)}m of travel in ${teleported} relocation step(s) of ${STEP_M}m, samples=${walkAudit.samples}`)
} catch (e) {
  failed = 1
  reasons.push(String((e && e.stack) || e))
} finally {
  if (browser) await browser.close().catch((e) => console.log('[grass-fade-visual] browser.close: ' + ((e && e.message) || e)))
  try { await server.stop() } catch (e) { console.log('[grass-fade-visual] server.stop: ' + ((e && e.message) || e)) }
}
for (const r of reasons) console.log('FAIL: ' + r)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} label=${LABEL} -- ${checks.length} check(s), ${reasons.length} failure(s)`)
process.exit(failed ? 1 : 0)
