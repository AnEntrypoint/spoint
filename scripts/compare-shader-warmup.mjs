#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome, waitFor } from './lib/gpu-eval.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
