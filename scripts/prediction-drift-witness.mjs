#!/usr/bin/env node
import { chromium } from './lib/cdp-browser.mjs'
import { gpuLaunchArgs, gpuModeFlag, witnessGpu } from './lib/gpu-probe.mjs'

const PORT = 20000 + Math.floor(Math.random() * 20000)
const GPU_MODE = gpuModeFlag('gpu', 'accelerated')
const HOLD_MS = Number((process.argv.find(a => a.startsWith('--hold-ms=')) || '').slice(10) || 3000)
const SETTLE_MS = Number((process.argv.find(a => a.startsWith('--settle-ms=')) || '').slice(12) || 5000)
const WORLD = (process.argv.find(a => a.startsWith('--world=')) || '').slice(8) || 'e2e-ci-arena'

async function waitFor(page, fn, arg, { timeoutMs = 60000, intervalMs = 200, label = 'condition' } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await page.evaluate(fn, arg).catch(() => undefined)
    if (v) return v
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`)
}

const PROBE = () => {
  const c = window.__client
  const s = c?.state
  const local = c?.getLocalState?.()
  const pred = c?._msgHandler?.getPredEngine?.()
  const net = window.__net ? window.__net() : null
  const keys = s ? Object.keys(s) : []
  const tick = typeof s?.tick === 'number' ? s.tick : (typeof s?.serverTime === 'number' ? s.serverTime : null)
  return {
    t: Date.now(),
    frames: window.__vsync?.frameCount ?? null,
    tick,
    stateKeys: keys.slice(0, 40),
    local: local?.position ? [...local.position] : null,
    pred: pred?.localState?.position ? [...pred.localState.position] : null,
    server: pred?.lastServerState?.position ? [...pred.lastServerState.position] : null,
    unacked: pred ? (pred._inputSeq - 1 - (pred._lastAckedSeq ?? pred._inputSeq - 1)) : null,
    inputSeq: pred?._inputSeq ?? null,
    lastAckedSeq: pred?._lastAckedSeq ?? null,
    historyLen: pred?.inputHistory?.length ?? null,
    net,
  }
}

const METRIC_TICK_RE = /^spoint_tick (\d+)$/m

async function serverTick(base) {
  const body = await fetch(`${base}/metrics`).then(r => r.text()).catch(() => '')
  const m = METRIC_TICK_RE.exec(body)
  return m ? Number(m[1]) : null
}

async function main() {
  process.env.WORLD = WORLD
  process.env.PORT = String(PORT)
  process.env.SPOINT_SKIP_PREWARM = '1'
  process.env.SPOINT_NO_WATCH = '1'
  console.log(`[prediction-drift] booting server on ${PORT} world=${WORLD}`)
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()

  let browser
  let exitCode = 0
  try {
    browser = await chromium.launch({ headless: true, args: gpuLaunchArgs(GPU_MODE) })
    const ctxA = await browser.newContext({ viewport: { width: 800, height: 600 } })
    const ctxB = await browser.newContext({ viewport: { width: 640, height: 480 } })
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    const url = `http://localhost:${PORT}/?multiplayer&world=${WORLD}&predict=1`
    await Promise.all([pageA.goto(url, { waitUntil: 'domcontentloaded' }), pageB.goto(url, { waitUntil: 'domcontentloaded' })])
    const idA = await waitFor(pageA, () => window.__client?.connected && window.__client?.playerId, undefined, { label: 'A connect' })
    const idB = await waitFor(pageB, () => window.__client?.connected && window.__client?.playerId, undefined, { label: 'B connect' })
    const gpu = await witnessGpu(pageA, GPU_MODE)
    console.log(`[prediction-drift] rasterizer=${gpu.rasterizer} gpuMode=${GPU_MODE.mode} idA=${idA} idB=${idB}`)
    await waitFor(pageA, (id) => window.__client?.state?.players?.some(p => p.id === id), idB, { label: 'A sees B' })
    await waitFor(pageB, (id) => window.__client?.state?.players?.some(p => p.id === id), idA, { label: 'B sees A' })
    await waitFor(pageA, () => { const s = window.__client?.getLocalState?.(); return s?.onGround === true }, undefined, { label: 'A onGround', timeoutMs: 20000 }).catch(() => console.warn('[prediction-drift] A never reported onGround'))

    const WARMUP_FPS = Number((process.argv.find(a => a.startsWith('--warmup-fps=')) || '').slice(13) || 30)
    let warmFps = 0
    const warmStart = Date.now()
    while (Date.now() - warmStart < 180000) {
      const f0 = await pageA.evaluate(() => window.__vsync?.frameCount ?? 0)
      await new Promise(r => setTimeout(r, 1000))
      const f1 = await pageA.evaluate(() => window.__vsync?.frameCount ?? 0)
      warmFps = f1 - f0
      if (warmFps >= WARMUP_FPS) break
      await new Promise(r => setTimeout(r, 1000))
    }
    console.log(`[prediction-drift] steady-state warmup done after ${Math.round((Date.now() - warmStart) / 1000)}s at ${warmFps} fps (wanted >= ${WARMUP_FPS})`)

    const shape = await pageA.evaluate(PROBE)
    console.log(`[prediction-drift] state keys: ${JSON.stringify(shape.stateKeys)}`)
    console.log(`[prediction-drift] probe shape: ${JSON.stringify({ tick: shape.tick, frames: shape.frames, inputSeq: shape.inputSeq, lastAckedSeq: shape.lastAckedSeq, historyLen: shape.historyLen })}`)

    const base = `http://localhost:${PORT}`
    const start = await pageA.evaluate(PROBE)
    const tick0 = await serverTick(base)
    const tHold0 = Date.now()
    console.log(`[prediction-drift] holding KeyW for ${HOLD_MS}ms`)
    await pageA.keyboard.down('KeyW')
    const HOLD_SLICES = 10
    const holdSamples = []
    for (let i = 0; i < HOLD_SLICES; i++) {
      await new Promise(r => setTimeout(r, HOLD_MS / HOLD_SLICES))
      const p = await pageA.evaluate(PROBE)
      holdSamples.push(p)
      console.log(`  [hold] t=${((p.t - start.t) / 1000).toFixed(2)}s divergence=${p.net?.divergence === null ? 'null' : p.net.divergence.toFixed(3)} unacked=${p.unacked} serverTravel=${p.server && start.server ? Math.hypot(p.server[0] - start.server[0], p.server[2] - start.server[2]).toFixed(3) : 'null'}`)
    }
    const peakUnacked = Math.max(...holdSamples.map(p => p.unacked ?? 0))
    const peakDivergence = Math.max(...holdSamples.map(p => p.net?.divergence ?? 0))
    const lastUnacked = holdSamples.at(-1).unacked ?? 0
    await pageA.keyboard.up('KeyW')
    const released = await pageA.evaluate(PROBE)
    const tick1 = await serverTick(base)
    const serverTps = tick0 != null && tick1 != null ? (tick1 - tick0) / ((Date.now() - tHold0) / 1000) : null
    const holdSec = (released.t - start.t) / 1000
    const clientTravel = Math.hypot(released.local[0] - start.local[0], released.local[2] - start.local[2])
    const serverTravelAtRelease = Math.hypot(released.server[0] - start.server[0], released.server[2] - start.server[2])
    const frameRate = (released.frames - start.frames) / holdSec
    const UNACKED_CAP = Number((process.argv.find(a => a.startsWith('--unacked-cap=')) || '').slice(15) || 24)
    const DIVERGENCE_CAP_M = Number((process.argv.find(a => a.startsWith('--divergence-cap=')) || '').slice(18) || 3)
    console.log(`[prediction-drift] hold=${holdSec.toFixed(2)}s clientTravel=${clientTravel.toFixed(3)}m serverTravel=${serverTravelAtRelease.toFixed(3)}m ratio=${(serverTravelAtRelease / clientTravel).toFixed(3)}`)
    console.log(`[prediction-drift] inputsSent=${released.inputSeq - start.inputSeq} (${((released.inputSeq - start.inputSeq) / holdSec).toFixed(1)}/s) serverTps=${serverTps === null ? 'null' : serverTps.toFixed(1)} unacked=${released.unacked} historyLen=${released.historyLen}`)

    console.log(`[prediction-drift] settling ${SETTLE_MS}ms with no input`)
    const settleEnd = Date.now() + SETTLE_MS
    const trail = []
    while (Date.now() < settleEnd) {
      const p = await pageA.evaluate(PROBE)
      trail.push({ dt: p.t - released.t, div: p.net?.divergence, err: p.net?.errorOffset ? Math.hypot(...p.net.errorOffset) : null, rtt: p.net?.rtt, buf: p.net?.bufferHealth, unacked: p.unacked, his: p.historyLen })
      await new Promise(r => setTimeout(r, 200))
    }
    for (const s of trail) console.log(`  [settle] dt=${s.dt}ms divergence=${s.div === null ? 'null' : s.div.toFixed(3)} errorOffset=${s.err === null ? 'null' : s.err.toFixed(3)} rtt=${s.rtt} bufferHealth=${s.buf} unacked=${s.unacked} history=${s.his}`)

    const end = await pageA.evaluate(PROBE)
    const bView = await pageB.evaluate((id) => { const p = window.__client?.state?.players?.find(p => p.id === id); return p?.position ? [...p.position] : null }, idA)
    const serverTravelFinal = Math.hypot(end.server[0] - start.server[0], end.server[2] - start.server[2])
    const clientTravelFinal = Math.hypot(end.local[0] - start.local[0], end.local[2] - start.local[2])
    const residualDivergence = end.net?.divergence ?? null
    console.log(`[prediction-drift] final clientTravel=${clientTravelFinal.toFixed(3)}m serverTravel=${serverTravelFinal.toFixed(3)}m B-view-of-A=${JSON.stringify(bView)}`)
    console.log(`[prediction-drift] residual divergence after ${SETTLE_MS}ms of no input = ${residualDivergence === null ? 'null' : residualDivergence.toFixed(4)}m`)
    const lastDivs = trail.slice(-5).map(s => s.div)
    const decayed = lastDivs.length === 5 && lastDivs.every(d => d !== null && d < 0.5)
    const boundedLead = peakUnacked <= UNACKED_CAP && peakDivergence <= DIVERGENCE_CAP_M && lastUnacked <= UNACKED_CAP
    console.log(`[prediction-drift] peak unacked during the hold = ${peakUnacked} (cap ${UNACKED_CAP}), peak divergence = ${peakDivergence.toFixed(3)}m (cap ${DIVERGENCE_CAP_M}m), unacked at release = ${lastUnacked}`)
    const pass = decayed && boundedLead
    console.log(`[prediction-drift] RESULT: ${pass ? 'PASS' : 'FAIL'} (settled below 0.5m: ${JSON.stringify(lastDivs)}; lead bounded: ${boundedLead})`)
    if (!pass) exitCode = 1
    console.log(`[prediction-drift] DIAGNOSIS serverAppliedFraction=${(serverTravelFinal / clientTravelFinal).toFixed(3)} serverTps=${serverTps === null ? 'null' : serverTps.toFixed(1)} clientFramesPerSec=${frameRate.toFixed(2)}`)
    await ctxA.close()
    await ctxB.close()
  } catch (err) {
    console.error(err?.stack || err)
    exitCode = 1
  } finally {
    if (browser) await browser.close().catch(() => {})
    try { server.stop?.() } catch {}
  }
  process.exit(exitCode)
}

main().catch(err => { console.error(err?.stack || err); process.exit(1) })
