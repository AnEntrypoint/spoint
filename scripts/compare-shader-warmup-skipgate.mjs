#!/usr/bin/env node
import { findChrome, waitFor } from './lib/gpu-eval.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

async function main() {
  const port = Number(process.argv[2] || process.env.PORT || 8090)
  const world = process.argv[3] || 'tps-game'
  const url = `http://localhost:${port}/?singleplayer&world=${world}&nc=${Date.now()}`

  console.log(`[compare-shader-warmup-skipgate] port=${port} world=${world}`)

  const chrome = findChrome()
  if (!chrome) throw new Error('no chromium found')
  const serverUp = async () => { try { const r = await fetch(`http://localhost:${port}/`, { method: 'HEAD' }); return r.ok || r.status === 200 } catch { return false } }
  if (!(await serverUp())) throw new Error(`server not up on :${port}`)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'spoint-gpu-'))
  const cr = spawn(chrome, ['--headless=new', '--use-angle=d3d11', '--use-gl=angle', '--disable-gpu-sandbox', '--no-sandbox', '--remote-debugging-port=0', '--user-data-dir=' + profile, url], { stdio: 'ignore' })
  try {
    const pf = path.join(profile, 'DevToolsActivePort')
    const dport = await waitFor(() => fs.existsSync(pf) ? Number(fs.readFileSync(pf, 'utf8').split('\n')[0]) : null, 15000)
    const ver = await (await fetch(`http://localhost:${dport}/json/version`)).json()
    const ws = new WebSocket(ver.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let seq = 0; const pend = new Map()
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) } }
    const send = (method, params = {}, s) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify(s ? { id, method, params, sessionId: s } : { id, method, params })) })
    const { targetId } = await send('Target.createTarget', { url })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Runtime.enable', {}, sessionId)
    const evalIn = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: `(async()=>{ return (${expr}); })()`, awaitPromise: true, returnByValue: true }, sessionId)
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
      return r.result.value
    }
    await waitFor(() => evalIn('!!(window.__renderer && window.__scene && window.__camera && window.__app && window.__app.el)').catch(() => false), 150000, 1000)

    const setupExpr = `
      (async () => {
        const THREE = await import('three')
        const { warmupShaders } = await import('/core/SceneSetup.js')
        const renderer = window.__renderer, scene = window.__scene, camera = window.__camera
        const N = 65
        function buildSet(tag, offset) {
          const entityMeshes = new Map()
          const group = new THREE.Group()
          for (let i = 0; i < N; i++) {
            const geo = new THREE.BoxGeometry(1, 1, 1)
            const texData = new Uint8Array([Math.floor((i * 37) % 255), Math.floor((i * 53) % 255), Math.floor((i * 19) % 255), 255])
            const tex = new THREE.DataTexture(texData, 1, 1, THREE.RGBAFormat)
            tex.needsUpdate = true
            const geoWithUv = geo
            const useVertexColors = (i % 3) === 0
            if (useVertexColors) { const colors = new Float32Array(geoWithUv.attributes.position.count * 3).fill(0.5); geoWithUv.setAttribute('color', new THREE.BufferAttribute(colors, 3)) }
            const mat = new THREE.MeshStandardMaterial({ map: tex, flatShading: (i % 2) === 0, vertexColors: useVertexColors })
            const mesh = new THREE.Mesh(geoWithUv, mat)
            mesh.position.set(offset + i, 1000, 1000)
            mesh.userData.modelUrl = './apps/maps/synthetic_' + tag + '_' + (i % 5) + '.glb'
            group.add(mesh)
            entityMeshes.set('synthetic-' + tag + '-' + i, mesh)
          }
          scene.add(group)
          return { group, entityMeshes }
        }
        const setB = buildSet('b', 1000)
        const setA = buildSet('a', 2000)
        window.__setB = setB; window.__setA = setA
        window.__renderer2 = renderer; window.__warmupShaders2 = warmupShaders
        return { meshCountB: setB.entityMeshes.size, meshCountA: setA.entityMeshes.size, programsAfterBuild: renderer.info.programs.length }
      })()
    `
    const setupResult = await evalIn(setupExpr)
    console.log('[compare-shader-warmup-skipgate] scenes built:', JSON.stringify(setupResult))

    const loadingMgrExpr = `window.__loadingMgrStub = { setLabel: () => {}, reportProcessing: () => {} }`
    await evalIn(loadingMgrExpr)

    const runBExpr = `
      (async () => {
        const t0 = performance.now()
        await window.__warmupShaders2(window.__renderer2, window.__scene, window.__camera, window.__setB.entityMeshes, new Map(), window.__loadingMgrStub, null, null)
        return { wallMs: performance.now() - t0, lastRecord: window.__lastShaderWarmup }
      })()
    `
    const runB = await evalIn(runBExpr)
    const programsAfterRunB = await evalIn('window.__renderer2.info.programs.length')
    console.log('[compare-shader-warmup-skipgate] run B (65 resident meshes, NO manifest -- skip-gate should fire, set B stays uncompiled):', JSON.stringify(runB), 'programs after run B call:', programsAfterRunB)

    await evalIn(`(() => { localStorage.removeItem('lastShaderWarmupKey'); return true })()`)

    const runAExpr = `
      (async () => {
        const manifest = { world: 'synthetic', modelUrls: ['./apps/maps/synthetic_a_0.glb','./apps/maps/synthetic_a_1.glb','./apps/maps/synthetic_a_2.glb','./apps/maps/synthetic_a_3.glb','./apps/maps/synthetic_a_4.glb'] }
        const t0 = performance.now()
        await window.__warmupShaders2(window.__renderer2, window.__scene, window.__camera, window.__setA.entityMeshes, new Map(), window.__loadingMgrStub, null, manifest)
        return { wallMs: performance.now() - t0, lastRecord: window.__lastShaderWarmup }
      })()
    `
    const runA = await evalIn(runAExpr)
    const programsAfterRunA = await evalIn('window.__renderer2.info.programs.length')
    console.log('[compare-shader-warmup-skipgate] run A (65 resident meshes, WITH manifest -- skip-gate should be LIFTED, all 65 warm, set A pre-compiled):', JSON.stringify(runA), 'programs after run A call:', programsAfterRunA, '(delta from run B:', programsAfterRunA - programsAfterRunB, ')')

    const stutterExpr = `
      (async () => {
        const THREE = await import('three')
        const fwd = new THREE.Vector3(); window.__camera.getWorldDirection(fwd)
        const base = window.__camera.position.clone().add(fwd.multiplyScalar(10))
        function placeInView(entityMeshes) {
          let i = 0
          for (const m of entityMeshes.values()) { m.position.copy(base).add(new THREE.Vector3((i % 9 - 4) * 1.3, (Math.floor(i / 9) - 3) * 1.3, 0)); i++ }
        }
        const programsBeforeB = window.__renderer2.info.programs.length
        placeInView(window.__setB.entityMeshes)
        const t0b = performance.now()
        window.__renderer2.render(window.__scene, window.__camera)
        const stutterB = performance.now() - t0b
        const programsAfterB = window.__renderer2.info.programs.length
        for (const m of window.__setB.entityMeshes.values()) m.position.set(1000, 1000, 1000)
        const programsBeforeA = window.__renderer2.info.programs.length
        placeInView(window.__setA.entityMeshes)
        const t0a = performance.now()
        window.__renderer2.render(window.__scene, window.__camera)
        const stutterA = performance.now() - t0a
        const programsAfterA = window.__renderer2.info.programs.length
        return { firstDrawMsUncompiled: stutterB, firstDrawMsPrewarmed: stutterA, programsBeforeB, programsAfterB, newProgramsB: programsAfterB - programsBeforeB, programsBeforeA, programsAfterA, newProgramsA: programsAfterA - programsBeforeA }
      })()
    `
    const stutter = await evalIn(stutterExpr)
    console.log('[compare-shader-warmup-skipgate] first-use-draw wall-clock (single renderer.render() call):', JSON.stringify(stutter))

    const summary = {
      runB_noManifest: runB,
      runA_withManifest: runA,
      firstUseDrawStutter: stutter,
      skipGateLiftConfirmed: runB.lastRecord?.skipped === true && runB.lastRecord?.reason === 'too-many-meshes' && runA.lastRecord?.total === 65,
      stutterEliminated: stutter && stutter.firstDrawMsPrewarmed < stutter.firstDrawMsUncompiled,
    }
    console.log('[compare-shader-warmup-skipgate] SUMMARY:', JSON.stringify(summary, null, 2))

    try { ws.close() } catch (_) {}
  } finally {
    try { cr.kill() } catch (_) {}
  }
}

main().catch(e => { console.error('[compare-shader-warmup-skipgate] FAILED:', e && e.stack || e); process.exit(1) })
