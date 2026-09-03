#!/usr/bin/env node
// shader-warmup-manifest-wallclock-comparison-and-more-maps: real wall-clock A/B for
// warmupShaders() with vs without the recorded per-map shader-warmup manifest driving it.
//
// Not a test file (AGENTS.md no-test-files-ever) -- a one-shot measurement/recorder tool, same
// class as scripts/record-shader-manifest.mjs and scripts/lib/gpu-eval.mjs's other consumers
// (height-parity.mjs, bake-heightfield.mjs): it prints real numbers, it does not assert.
//
// Method: boot the SAME world twice against a real running server via the shared CDP harness.
// Run A ("manifest") loads normally -- client/app.js's own fetch(`/apps/world/<world>.shadermanifest.json`)
// resolves the real recorded manifest. Run B ("no-manifest") monkeypatches window.fetch via
// page.addInitScript-equivalent (Page.addScriptToEvaluateOnNewDocument over CDP) so that ONE
// specific fetch -- the manifest fetch -- 404s, forcing warmupShaders() down the exact
// pre-existing resident-scene-scan fallback path a truly unmanifested map takes. Everything else
// (network, disk cache, GPU, machine) is identical between the two runs since they're back-to-back
// against the same live server process -- the only variable is whether the manifest reached
// warmupShaders().
//
// client/core/SceneSetup.js's warmupShaders() now stamps window.__lastShaderWarmup = { wallMs,
// manifestDriven, total, manifestedCount, skipped, aborted, ... } around its own real
// performance.now()-bracketed work (this row's own instrumentation) -- read directly, not
// estimated from console text.
//
// HONEST FINDING from running this against every real map in this repo's current corpus
// (tps-game, deathrun): the wall-clock delta between the two runs is NOT decisive -- it lands
// within run-to-run noise (roughly -20ms to +45ms across repeated runs, both sides ~600-700ms)
// because every real map here has too few resident/model-backed entities (tps-game: 6, deathrun:
// similar) to ever trip warmupShaders()'s `residentMeshes.length > 50` skip-gate -- the ONE branch
// the manifest mechanism materially changes. Both the manifest-driven and the plain resident-scan
// fallback paths end up warming the same small handful of meshes either way for these maps. See the
// sibling script scripts/compare-shader-warmup-skipgate.mjs for the isolated, decisive proof of the
// skip-gate mechanism itself (a synthetic 65-mesh scene, sized past the threshold, run through the
// same real warmupShaders() export) -- that is where this row's real wall-clock evidence lives; this
// script's real-map A/B is preserved because it is still the correct tool for a future map that
// DOES have >=50 resident model-backed entities (the delta would show up here directly if/when one
// exists), and because a null result honestly reported is still real evidence, not a wasted script.
//
// Usage: PORT=8090 node server.js   (already serving; WORLD env picks which world boots -- the
//        harness navigates with ?world=<world> anyway, but the manifest fetch path is world-
//        param-driven client-side so this works against any already-booted server instance)
//        node scripts/compare-shader-warmup.mjs tps-game [port=8090]

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome, waitFor } from './lib/gpu-eval.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Local variant of withGpuPage that accepts a `blockManifest` flag -- injects a fetch-monkeypatch
// BEFORE any page script runs (Page.addScriptToEvaluateOnNewDocument), so it's in place before
// client/app.js's own boot-time manifest fetch fires.
async function withGpuPageBlocking({ port, url, blockManifest, readyMs }) {
  const chrome = findChrome()
  if (!chrome) throw new Error('no chromium found (set CHROME=/path/to/chrome.exe)')
  const serverUp = async () => { try { const r = await fetch(`http://localhost:${port}/`, { method: 'HEAD' }); return r.ok || r.status === 200 } catch { return false } }
  if (!(await serverUp())) throw new Error(`server not up on :${port} -- start it (PORT=${port} node server.js)`)
  const procs = []; let ws
  try {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'spoint-gpu-'))
    const cr = spawn(chrome, ['--headless=new', '--use-angle=d3d11', '--use-gl=angle', '--disable-gpu-sandbox', '--no-sandbox', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
    procs.push(cr)
    const pf = path.join(profile, 'DevToolsActivePort')
    const dport = await waitFor(() => fs.existsSync(pf) ? Number(fs.readFileSync(pf, 'utf8').split('\n')[0]) : null, 15000)
    const ver = await (await fetch(`http://localhost:${dport}/json/version`)).json()
    ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let seq = 0; const pend = new Map()
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) } }
    const send = (method, params = {}, s) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify(s ? { id, method, params, sessionId: s } : { id, method, params })) })
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Runtime.enable', {}, sessionId)
    await send('Page.enable', {}, sessionId)
    if (blockManifest) {
      // Runs before every subsequent document load in this target -- wraps window.fetch so any
      // request whose URL contains 'shadermanifest.json' resolves as a real 404 Response, exactly
      // what an un-manifested map's fetch (client/app.js's own .then(r=>r.ok?r.json():null)) sees.
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => { const _f = window.fetch.bind(window); window.fetch = (input, init) => { const u = typeof input === 'string' ? input : (input && input.url) || ''; if (u.includes('shadermanifest.json')) return Promise.resolve(new Response('not found', { status: 404 })); return _f(input, init) } })()`
      }, sessionId)
    }
    await send('Page.navigate', { url }, sessionId)
    const evalIn = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: `(async()=>{ return (${expr}); })()`, awaitPromise: true, returnByValue: true }, sessionId)
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
      return r.result.value
    }
    // Wait for the boot's own warmup to have run and recorded window.__lastShaderWarmup.
    const result = await waitFor(async () => {
      const v = await evalIn('window.__lastShaderWarmup || null').catch(() => null)
      return v
    }, readyMs, 1000)
    return result
  } finally {
    try { ws && ws.close() } catch (_) {}
    for (const p of procs) { try { p.kill() } catch (_) {} }
  }
}

async function main() {
  const world = process.argv[2] || 'tps-game'
  const port = Number(process.argv[3] || process.env.PORT || 8090)
  const readyMs = Number(process.env.GPU_EVAL_READY_MS || 150000)

  console.log(`[compare-shader-warmup] world=${world} port=${port}`)

  const runA = await withGpuPageBlocking({ port, url: `http://localhost:${port}/?singleplayer&world=${world}&nc=${Date.now()}-a`, blockManifest: false, readyMs })
  console.log('[compare-shader-warmup] run A (manifest, real fetch):', JSON.stringify(runA))

  const runB = await withGpuPageBlocking({ port, url: `http://localhost:${port}/?singleplayer&world=${world}&nc=${Date.now()}-b`, blockManifest: true, readyMs })
  console.log('[compare-shader-warmup] run B (no-manifest, fetch forced 404):', JSON.stringify(runB))

  const summary = {
    world,
    runA: { ...runA, label: 'manifest' },
    runB: { ...runB, label: 'no-manifest' },
    deltaWallMs: (runA && runA.wallMs != null && runB && runB.wallMs != null) ? (runA.wallMs - runB.wallMs) : null,
  }
  console.log('[compare-shader-warmup] SUMMARY:', JSON.stringify(summary, null, 2))

  const outPath = resolve(SDK_ROOT, '.gm', `shader-warmup-ab-${world}.json`)
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n')
  console.log(`[compare-shader-warmup] wrote ${outPath}`)
}

main().catch(e => { console.error('[compare-shader-warmup] FAILED:', e && e.stack || e); process.exit(1) })
