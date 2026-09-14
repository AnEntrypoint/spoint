import { createHeightSampler } from '../src/height-cpu.js'
import { encodePNGGray, toGray, crc32 } from './lab-png.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import WebSocket from 'ws'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'lab-out')
const LAND_REF = [0.4039, -0.6494, -0.6443]
const GOLDEN_ANGLE_RAD = 2.399963229728653

function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t.startsWith('--')) {
      const key = t.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) { a[key] = true }
      else { a[key] = next; i++ }
    } else a._.push(t)
  }
  return a
}
const num = (v, d) => (v === undefined || v === true ? d : Number(v))

function dirFromLatLon(latDeg, lonDeg) {
  const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180
  const cl = Math.cos(la)
  return [cl * Math.cos(lo), Math.sin(la), cl * Math.sin(lo)]
}

function sampleField(opts) {
  const res = Math.max(8, Math.round(num(opts.res, 256)))
  const radius = num(opts.radius, 6360000)
  const seed = opts.seed !== undefined ? (num(opts.seed, 1337) | 0) : undefined
  const sampler = createHeightSampler({ radius, seed })
  let w, h, latOf, lonOf
  if (opts.center) {
    const [clat, clon] = String(opts.center).split(',').map(Number)
    const span = num(opts.span, 20)
    w = res; h = res
    latOf = (px, py) => clat + (0.5 - py / (h - 1)) * span
    lonOf = (px, py) => clon + (px / (w - 1) - 0.5) * span
  } else {
    w = res * 2; h = res
    latOf = (px, py) => 90 - (py / (h - 1)) * 180
    lonOf = (px, py) => (px / (w - 1)) * 360 - 180
  }
  const elev = new Float64Array(w * h)
  let min = Infinity, max = -Infinity, sum = 0, land = 0
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const e = sampler.heightAt(dirFromLatLon(latOf(px, py), lonOf(px, py)))
      elev[py * w + px] = e
      if (e < min) min = e; if (e > max) max = e
      sum += e; if (e > 0) land++
    }
  }
  return { w, h, elev, min, max, mean: sum / (w * h), landFrac: land / (w * h), radius }
}

function ensureOutDir() { if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true }) }

function cmdHeightmap(args) {
  const field = sampleField(args)
  const gray = toGray(field, !!args.hillshade)
  ensureOutDir()
  const out = args.out ? path.resolve(String(args.out)) : path.join(OUT_DIR, 'heightmap.png')
  fs.writeFileSync(out, encodePNGGray(field.w, field.h, gray))
  const m = (v) => v.toFixed(1)
  console.log(JSON.stringify({
    ok: true, out, w: field.w, h: field.h, radiusM: field.radius,
    minM: +m(field.min), maxM: +m(field.max), meanM: +m(field.mean),
    reliefM: +m(field.max - field.min), landFrac: +field.landFrac.toFixed(3)
  }, null, 1))
  return 0
}

async function cmdBuild(args) {
  console.log('[lab] building CPU height (scripts/gen-height.mjs -> src/height-gen.js)')
  const gen = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-height.mjs')], { cwd: ROOT, encoding: 'utf8' })
  process.stdout.write(gen.stdout || ''); if (gen.stderr) process.stderr.write(gen.stderr)
  if (gen.status !== 0) { console.log(JSON.stringify({ ok: false, step: 'gen-height', status: gen.status })); return 1 }
  console.log('[lab] compile-checking the GLSL (headless SwiftShader)')
  return await cmdGlslCheck(args)
}

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  return cands.find(p => { try { return fs.existsSync(p) } catch { return false } }) || null
}
function waitFor(fn, ms, every = 200) {
  return new Promise((res, rej) => {
    const t0 = Date.now()
    const tick = async () => {
      try { const v = await fn(); if (v) return res(v) } catch {}
      if (Date.now() - t0 > ms) return rej(new Error('timeout'))
      setTimeout(tick, every)
    }
    tick()
  })
}
async function serverUp() { try { const r = await fetch('http://localhost:8080/planet.html', { method: 'HEAD' }); return r.ok || r.status === 200 } catch { return false } }

async function withHeadless(fn) {
  const chrome = findChrome()
  if (!chrome) return { ok: false, err: 'no chromium found (set CHROME=/path/to/chrome); CPU heightmap/parity still work GPU-free' }
  const procs = []
  try {
    if (!(await serverUp())) {
      const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, PORT: '8080' }, stdio: 'ignore' })
      procs.push(srv)
      await waitFor(serverUp, 15000)
    }
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mapspinner-lab-'))
    const cr = spawn(chrome, ['--headless=new', '--use-angle=' + (process.env.LAB_ANGLE || 'swiftshader'), '--use-gl=angle',
      '--disable-gpu-sandbox', '--no-sandbox', '--remote-debugging-port=0',
      '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
    procs.push(cr)
    const portFile = path.join(profile, 'DevToolsActivePort')
    const port = await waitFor(() => fs.existsSync(portFile) ? Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]) : null, 15000)
    const ver = await (await fetch(`http://localhost:${port}/json/version`)).json()
    const ws = new WebSocket(ver.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let seq = 0; const pending = new Map()
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) } }
    const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })) })
    const { targetId } = await send('Target.createTarget', { url: 'http://localhost:8080/planet.html' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Runtime.enable', {}, sessionId)
    await send('Page.enable', {}, sessionId)
    const screenshot = async (p) => { const sr = await send('Page.captureScreenshot', { format: 'png' }, sessionId); fs.writeFileSync(p, Buffer.from(sr.data, 'base64')) }
    const evalIn = async (expr, awaitPromise = true) => {
      const r = await send('Runtime.evaluate', { expression: `(async()=>{ return (${expr}); })()`, awaitPromise, returnByValue: true }, sessionId)
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
      return r.result.value
    }
    const vendor = await evalIn('(()=>{const c=document.createElement("canvas");const gl=c.getContext("webgl2");const e=gl&&gl.getExtension("WEBGL_debug_renderer_info");return gl&&e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):(gl?"webgl2":"no-webgl2");})()').catch(() => '?')
    const orchDeadline = Date.now() + (Number(process.env.LAB_ORCH_TIMEOUT_MS) || 8 * 60 * 1000)
    let st = 'init', pageErr = null
    while (Date.now() < orchDeadline) {
      st = await evalIn('String(window.__planetOrchStatus || "init")').catch(() => 'navigating')
      pageErr = await evalIn('window.__pageErr ? String(window.__pageErr.message || window.__pageErr) : null').catch(() => null)
      if (st === 'ready' || st === 'error' || (typeof pageErr === 'string' && pageErr.length)) break
      await new Promise(r => setTimeout(r, 3000))
    }
    if (st !== 'ready') {
      try { ws.close() } catch {}
      return { ok: false, reason: pageErr ? 'page-error' : (st === 'error' ? 'orch-error' : 'orch-not-ready'),
        status: st, pageErr, vendor,
        note: 'SwiftShader software cold-compile of the full terrain shader is slow (minutes); raise LAB_ORCH_TIMEOUT_MS, or use a GPU/Windows chrome with --use-angle=d3d11 (CHROME env) for a fast compile-check.' }
    }
    const result = await fn(evalIn, screenshot)
    try { ws.close() } catch {}
    return { ok: true, vendor, ...result }
  } finally {
    for (const p of procs) { try { p.kill() } catch {} }
  }
}

async function cmdShot(args) {
  ensureOutDir()
  if (args.d3d11) process.env.LAB_ANGLE = 'd3d11'
  const out = args.out ? path.resolve(String(args.out)) : path.join(OUT_DIR, 'shot.png')
  const altKm = num(args.alt, 4.0)
  const pitch = num(args.pitch, 0.4)
  const dir = args.dir ? ('[' + String(args.dir) + ']') : 'null'
  const r = await withHeadless(async (evalIn, screenshot) => {
    const parked = await evalIn(`(async()=>{
      const d = window.__diag || {}, p = window.__planet;
      window.__landDir = ${JSON.stringify(LAND_REF)};   // reliable LAND reference for parkAboveGround's default dir
      if (p && p.cam && p.cam.sunLatBase!==undefined) p.cam.sunLatBase = 0.35;   // oblique sun -> relief shading
      if (d.parkAboveGround) { try { const r = await d.parkAboveGround(${altKm}, ${dir}, ${pitch}); return (typeof r==='object')?JSON.stringify(r).slice(0,220):String(r); } catch(e){ return 'pag-err:'+e.message; } }
      if (d.landWitness) { try { await d.landWitness(${altKm}, ${pitch}); return 'landWitness'; } catch(e){ return 'lw-err:'+e.message; } }
      return 'no-park-fn';
    })()`)
    await evalIn('(async()=>{ const f=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); for(let i=0;i<8;i++) await f(); return 1; })()')
    const info = await evalIn('({ glErr:(window.__lastGLRender&&window.__lastGLRender.checkGlError)?window.__lastGLRender.checkGlError():"x", kept:window.__cullStats?window.__cullStats.kept:null, altM:window.__cullStats?window.__cullStats.altM:null })')
    await screenshot(out)
    return { parked, ...info }
  })
  console.log(JSON.stringify({ out, ...r }, null, 1))
  return r.ok ? 0 : 1
}

async function cmdAbFs(args) {
  if (args.d3d11) process.env.LAB_ANGLE = 'd3d11'
  ensureOutDir()
  const tmp = path.join(OUT_DIR, '_abfs.png')
  const hashFile = () => { const b = fs.readFileSync(tmp); let s = 0; for (let i = 0; i < b.length; i++) s = (s * 16777619 ^ b[i]) >>> 0; return (s >>> 0) + ':' + b.length }
  const L = [
    ['biomeTint', 1.0], ['texBright', 0.3], ['texSat', 3.0], ['texMix', 0], ['hazeMul', 4.0],
    ['exposure', 3.0], ['lookSat', 3.0], ['lookContrast', 3.0], ['reliefShade', 8.0], ['vertexAO', 3.0],
    ['aoAmt', 3.0], ['variationAmt', 0.8], ['biomeWarp', 5.0], ['nrmLow', 4.0], ['triSharp', 16],
    ['texWarp', 2.0], ['texPhoto', 1.0], ['texPhotoNear', 1.0], ['flatNormal', 1.0], ['skyFill', 2.0],
    ['terminatorGlow', 2.0], ['nightLights', 3.0], ['nightFloor', 1.0], ['termWidth', 2.0], ['texNrmK', 5.0],
    ['diffWrap', 1.0], ['beachTop', 3000], ['beachWidth', 60], ['bandWarp', 9000], ['texFar0', 60000],
    ['texFar1', 90000], ['xSoft', 3.0], ['xFinger', 12], ['ordPush', 3.0], ['xFade0', 0], ['xFade1', 80],
    ['nrmFade0', 0], ['nrmFade1', 90], ['colorVar', 2.0], ['biomeSat', 0], ['texTile', 8.0],
  ]
  const FR = 'const f=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); for(let i=0;i<5;i++) await f();'
  const r = await withHeadless(async (evalIn, screenshot) => {
    await evalIn(`(async()=>{ window.__landDir=${JSON.stringify(LAND_REF)}; const d=window.__diag; if(d&&d.parkAboveGround) await d.parkAboveGround(${num(args.alt, 4)}, null, 0.4); const f=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); for(let i=0;i<10;i++) await f(); return 1; })()`)
    await screenshot(tmp); const base = hashFile()
    const changed = [], noEffect = []
    for (const [name, val] of L) {
      await evalIn(`(async()=>{ window.__${name} = ${JSON.stringify(val)}; ${FR} return 1; })()`)
      await screenshot(tmp); const h = hashFile()
      await evalIn(`(async()=>{ try { delete window.__${name}; } catch(e){} ${FR} return 1; })()`);
      (h !== base ? changed : noEffect).push(name)
    }
    const RAMP = [
      ['bcRock', [1, 0, 0]], ['bcGrass', [1, 0, 1]], ['bcSnow', [1, 0, 0]], ['bcShore', [1, 0, 0]], ['bcLowland', [0, 0, 1]],
      ['bandEdgesLo', [0, 50]], ['bandEdgesHi', [50, 120]], ['snowEdges', [0, 200]], ['slopeRock', [0, 0.05]], ['seaDepthM', 100],
    ]
    for (const [name, val] of RAMP) {
      await evalIn(`(async()=>{ window.__gen=window.__gen||{state:{}}; window.__gen.state=window.__gen.state||{}; window.__gen.state.biome=window.__gen.state.biome||{}; window.__gen.state.biome.${name}=${JSON.stringify(val)}; ${FR} return 1; })()`)
      await screenshot(tmp); const h = hashFile()
      await evalIn(`(async()=>{ try{ delete window.__gen.state.biome.${name}; }catch(e){} ${FR} return 1; })()`);
      (h !== base ? changed : noEffect).push('biome.' + name)
    }
    return { baseHash: base, changedCount: changed.length, noEffectCount: noEffect.length, noEffect, changed }
  })
  console.log(JSON.stringify(r, null, 1))
  return r.ok ? 0 : 1
}

async function cmdGlslCheck() {
  const r = await withHeadless(async (evalIn) => {
    const vendor = await evalIn('(()=>{ const c=document.createElement("canvas"); const gl=c.getContext("webgl2"); const e=gl&&gl.getExtension("WEBGL_debug_renderer_info"); return gl&&e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):(gl?"webgl2-no-dbg":"no-webgl2"); })()')
    const probe = await evalIn('(window.__planetOrch && window.__planetOrch.render && window.__planetOrch.render.sampleGroundM)? window.__planetOrch.render.sampleGroundM([0,1,0]) : "no-probe"')
    const pageErr = await evalIn('window.__pageErr || null')
    return { compiled: pageErr === null, vendor, probe, pageErr }
  })
  console.log(JSON.stringify(r, null, 1))
  return r.ok && r.compiled ? 0 : 1
}

async function cmdParity(args) {
  const n = Math.max(1, Math.round(num(args.n, 64)))
  const dirs = []
  for (let i = 0; i < n; i++) {
    const y = 1 - (i + 0.5) / n * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const th = i * GOLDEN_ANGLE_RAD
    dirs.push([r * Math.cos(th), y, r * Math.sin(th)])
  }
  const r = await withHeadless(async (evalIn) => {
    const pageR = Number(await evalIn('window.__WEBGL2_TERRAIN_R_M || 63600')) || 63600
    const sampler = createHeightSampler({ radius: pageR })
    const sg = 'window.__planetOrch && window.__planetOrch.render && window.__planetOrch.render.sampleGroundM'
    const warm = await waitFor(async () => {
      const v = await evalIn(`(()=>{ const o=window.__planetOrch, p=o&&o.render&&o.render.sampleGroundM; if(!p) return null; const h=p([0,1,0]); return (h!=null && isFinite(h))? h : null; })()`).catch(() => null)
      return v != null
    }, Number(process.env.LAB_PROBE_TIMEOUT_MS) || 4 * 60 * 1000, 2000).then(() => true).catch(() => false)
    if (!warm) return { samples: 0, note: 'sampleGroundM probe never warmed (lazy program compile too slow on SwiftShader; try --use-angle=d3d11 / a GPU chrome, or raise LAB_PROBE_TIMEOUT_MS)' }
    const gpu = await evalIn(`(()=>{
      const p = window.__planetOrch.render.sampleGroundMSync;
      const out = [];
      for (const d of ${JSON.stringify(dirs)}) { const h = p(d); out.push((h != null && isFinite(h)) ? h : null); }
      return out;
    })()`)
    if (gpu == null) return { samples: 0, note: 'sampleGroundMSync probe unavailable (orch.render not ready)' }
    let maxAbs = 0, sumAbs = 0, cnt = 0
    for (let i = 0; i < dirs.length; i++) {
      if (gpu[i] == null || !isFinite(gpu[i])) continue
      const cpu = sampler.heightAt(dirs[i])
      const d = Math.abs(cpu - gpu[i])
      maxAbs = Math.max(maxAbs, d); sumAbs += d; cnt++
    }
    return { pageRadiusM: pageR, samples: cnt, maxAbsM: +maxAbs.toFixed(3), meanAbsM: +(sumAbs / Math.max(1, cnt)).toFixed(3),
      note: 'EXACT (sampleGroundMSync, one call per dir, no frame-spacing/staleness). The AUTHORITATIVE CPU height-shape regression lock is still the live-witness golden-sample check in the height-cpu witness script (see AGENTS.md live-witness convention, no-test-files-ever rule); this sweep is now a tight CPU==GPU cross-check, not just a coarse sanity check.' }
  })
  const tolM = num(args.tol, 50)
  const ran = r.ok && r.samples > 0
  const withinTol = ran && r.maxAbsM <= tolM
  console.log(JSON.stringify({ ...r, tolM, withinTol, ran }, null, 1))
  if (args.soft) return ran ? 0 : 1
  return (ran && withinTol) ? 0 : 1
}

function cmdHelp() {
  console.log(`mapspinner CLI testing lab (scripts/lab.mjs)

  heightmap [--res N=256] [--center lat,lon] [--span deg=20] [--radius m=6360000]
            [--hillshade] [--seed N] [--out file.png]
                 Render the CPU height field (src/height-cpu.js) to a grayscale PNG + print stats.
  build          Regenerate the CPU height (gen-height.mjs) + compile-check the GLSL (SwiftShader).
  glsl-check     Headless SwiftShader Chromium: assert terrain.glsl compiles, report the GL backend.
  parity [--n N=64] [--tol m=50] [--soft]
                 CPU heightAt vs GPU _PROBE_ sampleGroundM divergence sweep (the parity gate). Exits
                 non-zero when maxAbsM exceeds --tol (a real CI-failing gate); pass --soft to report
                 only (exit 0 whenever the sweep ran, regardless of withinTol -- old behavior).
  shot [--alt km=4] [--pitch 0..1=0.4] [--dir x,y,z] [--d3d11] [--out f.png]
                 Headless RENDER of the terrain over land at an oblique pitch (parkAboveGround: ground
                 fills the frame) -> PNG to inspect. --d3d11 = real AMD/FXC backend (else SwiftShader).
  ab-fs [--d3d11] [--alt km=4]
                 A/B every FS material/color/biome lever (window.__* + __gen.state.biome): perturb each,
                 render, hash the framebuffer vs baseline -> reports any lever with NO pixel effect (dead).
                 Needs LAND in frame (run warm; changedCount high = good frame).
  help

Backend: CPU heights = pure node (no GPU). GLSL = headless Chromium --use-angle=swiftshader
(GPU-free). For the ANGLE/FXC witness, run chrome with --use-angle=d3d11 on Windows instead.`)
  return 0
}

export { parseArgs, dirFromLatLon, sampleField, crc32, encodePNGGray, toGray }

import { pathToFileURL } from 'node:url'
async function cmdParityPatch(args) {
  const explicitR = args.radius != null ? num(args.radius, NaN) : null
  const A = args.anchor ? String(args.anchor).split(',').map(Number) : [-0.641, 0.2558, 0.7237]
  const reach = num(args.reach, 320)
  const grid = Math.max(2, Math.round(num(args.grid, 7)))
  const settleFrames = Math.max(3, Math.round(num(args.settle, 8)))
  const nrm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l] }
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
  const up = nrm(A)
  const ref = Math.abs(up[1]) < 0.99 ? [0,1,0] : [1,0,0]
  const east = nrm(cross(ref, up)); const north = cross(east, up)
  const localToDir = (R, x, z) => nrm([ up[0] + (east[0]*x + north[0]*z)/R, up[1] + (east[1]*x + north[1]*z)/R, up[2] + (east[2]*x + north[2]*z)/R ])
  const detail = (args.detail != null) ? num(args.detail, 50) : null
  const r = await withHeadless(async (evalIn) => {
    const R = Number.isFinite(explicitR) ? explicitR : ((Number(await evalIn('window.__WEBGL2_TERRAIN_R_M || 6360'))) || 6360)
    const samples = []
    for (let i = 0; i < grid; i++) for (let j = 0; j < grid; j++) {
      const x = (i/(grid-1)*2-1)*reach, z = (j/(grid-1)*2-1)*reach
      samples.push({ x, z, dir: localToDir(R, x, z) })
    }
    const sampler = createHeightSampler({ radius: R, uniforms: detail != null ? { uDetailOverlay: detail } : undefined })
    if (detail != null) await evalIn(`(()=>{ window.__detailOverlay = ${detail}; return 1; })()`)
    const cpuH = (dir) => sampler.heightAt(dir)
    const warm = await waitFor(async () => {
      const v = await evalIn(`(()=>{ const o=window.__planetOrch, p=o&&o.render&&o.render.sampleGroundM; if(!p) return null; const h=p([0,1,0]); return (h!=null&&isFinite(h))?h:null; })()`).catch(() => null)
      return v != null
    }, Number(process.env.LAB_PROBE_TIMEOUT_MS) || 4*60*1000, 2000).then(() => true).catch(() => false)
    if (!warm) return { samples: 0, note: 'probe never warmed' }
    const dirs = samples.map(s => s.dir)
    const gpu = await evalIn(`(()=>{
      const p = window.__planetOrch.render.sampleGroundMSync;
      const out = [];
      for (const d of ${JSON.stringify(dirs)}) { const h = p(d); out.push((h!=null&&isFinite(h))?h:null); }
      return out;
    })()`)
    if (gpu == null) return { samples: 0, note: 'probe unavailable' }
    const rows = []
    let maxAbs = 0, sumAbs = 0, cnt = 0
    for (let i = 0; i < samples.length; i++) {
      if (gpu[i] == null || !isFinite(gpu[i])) continue
      const cpu = cpuH(samples[i].dir)
      const d = Math.abs(cpu - gpu[i]); maxAbs = Math.max(maxAbs, d); sumAbs += d; cnt++
      rows.push({ x: samples[i].x, z: samples[i].z, cpu: +cpu.toFixed(2), gpu: +gpu[i].toFixed(2), diff: +(gpu[i]-cpu).toFixed(2) })
    }
    return { pageRadiusM: R, anchor: A, reachM: reach, settleFrames, samples: cnt, maxAbsM: +maxAbs.toFixed(3), meanAbsM: +(sumAbs/Math.max(1,cnt)).toFixed(3), rows }
  })
  console.log(JSON.stringify(r, null, 1))
  return r.ok && r.samples > 0 ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0] || 'help'
  const table = { heightmap: cmdHeightmap, build: cmdBuild, 'glsl-check': cmdGlslCheck, parity: cmdParity, 'parity-patch': cmdParityPatch, shot: cmdShot, 'ab-fs': cmdAbFs, help: cmdHelp }
  const fn = table[cmd]
  if (!fn) { console.error(`unknown command: ${cmd}`); cmdHelp(); process.exit(2) }
  try { process.exit((await fn(args)) | 0) }
  catch (e) { console.error('[lab] error:', e && e.stack || e); process.exit(1) }
}
