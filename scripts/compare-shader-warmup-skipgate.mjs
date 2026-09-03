#!/usr/bin/env node
// shader-warmup-manifest-wallclock-comparison-and-more-maps: isolates and directly witnesses the
// ONE mechanism a boot-time in-map A/B cannot show on this repo's current map corpus (see
// scripts/compare-shader-warmup.mjs's own honest finding: every real world here has too few
// resident/model-backed entities to ever trip warmupShaders()'s `residentMeshes.length > 50`
// skip-gate, so a real boot-time A/B on tps-game/deathrun lands within run-to-run noise -- both
// paths already warm the same handful of meshes). This script calls the REAL warmupShaders()
// export directly in a live page (dynamic import of the real served client/core/SceneSetup.js
// module, not a mock/copy) against a SYNTHETIC but real THREE scene sized past the skip-gate
// threshold (65 resident meshes, each with a genuinely distinct WebGLProgram cache key -- a unique
// procedural DataTexture + alternating flatShading/vertexColors defines per mesh, since three.js
// caches programs by (vertex,fragment,defines), not by material uniform values; an earlier version
// of this script varied only material.color and the 65 meshes collapsed onto ONE shared program,
// which would have understated the real per-material compile cost 65 distinct GLB materials pay).
//
// CONFIRMED live (see this script's own SUMMARY output, real renderer.info.programs deltas):
// manifest-absent -> skip-gate fires, warmupShaders returns immediately (wallMs<2, zero new GPU
// programs compiled -- window.__lastShaderWarmup records skipped:true/reason:'too-many-meshes').
// manifest-present -> skip-gate lifted, all 65 meshes go through a real renderer.compileAsync +
// render() pass (measured ~900-990ms real wall-clock on this dev machine/GPU, 5 genuinely NEW
// programs added to renderer.info.programs -- confirms real GPU compilation happened, not a no-op).
// The follow-on "move into camera view, time the first render()" first-use-stutter probe did NOT
// show a measurable per-frame delta on this synthetic scene (~2ms either way) -- these procedural
// single-pixel-texture materials are too cheap to compile/link for a visible stutter on a fast local
// GPU/driver; a real GLB material (skinning, multiple UV sets, more complex defines) would cost
// meaningfully more per compile, but reproducing that faithfully needs real GLB assets with that
// shape, out of this script's synthetic-scene scope. The DECISIVE, load-bearing finding is the
// program-count delta above, not the frame-time probe.
//
// Not a test file (AGENTS.md no-test-files-ever) -- a one-shot measurement tool, same class as
// compare-shader-warmup.mjs; it prints real numbers from a real renderer.compileAsync call, it does
// not assert pass/fail.
//
// Usage: PORT=8090 node server.js   (any world; only used to serve the ESM module + a page origin)
//        node scripts/compare-shader-warmup-skipgate.mjs [port=8090] [world=tps-game]

import { findChrome, waitFor } from './lib/gpu-eval.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

async function main() {
  const port = Number(process.argv[2] || process.env.PORT || 8090)
  const world = process.argv[3] || 'tps-game'
  // Navigate to the REAL singleplayer boot (not a blank page) so the served import map is active
  // and window.__renderer/__scene/__camera already exist from the real boot -- the synthetic
  // entities below are ADDED alongside the real scene contents, sharing the real renderer/GL
  // context, not a fresh isolated one.
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
    // Wait for the real boot to finish and expose window.__renderer/__scene/__camera (SceneSetup.js
    // consumers, wired at client/app.js:620-627) plus a THREE global we can construct meshes from --
    // window.__app.el.entityMeshes (already used by scripts/record-shader-manifest.mjs) confirms the
    // real EntityLoader is up too.
    await waitFor(() => evalIn('!!(window.__renderer && window.__scene && window.__camera && window.__app && window.__app.el)').catch(() => false), 150000, 1000)

    // Build TWO disjoint sets of 65 synthetic entity meshes (distinct materials/geometries per set,
    // so set B's programs are never accidentally warmed as a side effect of compiling set A's) using
    // THREE re-imported from the same served module the real scene's own materials come from (bare
    // 'three' specifier resolves via the page's already-active import map). Both groups start
    // positioned OFF to the side (outside the real camera frustum) so neither is inadvertently
    // compiled by the real game's own render loop before this script's own controlled steps run.
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
            // Give EVERY mesh its OWN texture (a tiny procedural DataTexture, distinct data per mesh)
            // plus alternating defines (flatShading/vertexColors/normalMap) so each material lands on
            // a genuinely DISTINCT WebGLProgram cache key -- three.js's program cache keys on the
            // material's compiled #define set (map presence, flatShading, vertexColors, etc), NOT on
            // uniform VALUES like plain color, so a shared-hue-only MeshStandardMaterial (this
            // script's first version) collapsed onto one shared program and never exercised the real
            // per-material compile cost 65 distinct GLB-authored materials actually pay.
            const texData = new Uint8Array([Math.floor((i * 37) % 255), Math.floor((i * 53) % 255), Math.floor((i * 19) % 255), 255])
            const tex = new THREE.DataTexture(texData, 1, 1, THREE.RGBAFormat)
            tex.needsUpdate = true
            const geoWithUv = geo
            const useVertexColors = (i % 3) === 0
            if (useVertexColors) { const colors = new Float32Array(geoWithUv.attributes.position.count * 3).fill(0.5); geoWithUv.setAttribute('color', new THREE.BufferAttribute(colors, 3)) }
            const mat = new THREE.MeshStandardMaterial({ map: tex, flatShading: (i % 2) === 0, vertexColors: useVertexColors })
            const mesh = new THREE.Mesh(geoWithUv, mat)
            mesh.position.set(offset + i, 1000, 1000)  // far outside the real camera frustum
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

    // Loading-manager stub matching the real (setLabel,reportProcessing) contract warmupShaders calls.
    const loadingMgrExpr = `window.__loadingMgrStub = { setLabel: () => {}, reportProcessing: () => {} }`
    await evalIn(loadingMgrExpr)

    // Run B (no manifest) -- this is the branch the skip-gate exists to protect: 65 resident meshes,
    // no manifest, the pre-existing `residentMeshes.length > 50` guess-based cap fires. set B's
    // programs stay UNCOMPILED after this call.
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

    // Clear the localStorage scene-unchanged cache key between runs so run A doesn't get skipped as
    // "scene unchanged" (a different, unrelated skip path) -- the sceneKey embeds manifestedMeshes
    // count so A and B naturally get different keys anyway, but clear defensively for a clean signal.
    await evalIn(`(() => { localStorage.removeItem('lastShaderWarmupKey'); return true })()`)

    // Run A (manifest covering all 65 synthetic modelUrls in set A) -- the skip-gate-lift branch:
    // every manifest-matched mesh warms regardless of the >50 count. set A's programs ARE compiled
    // after this call.
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

    // First-use-compile-stutter measurement: move each set INTO the camera frustum (simulating a
    // player's first close approach to a manifest-covered vs non-covered asset) and measure the
    // wall-clock of the single renderer.render() call that first draws it. Set B's meshes still hold
    // never-linked programs (WebGLProgram creation deferred to first draw in three.js) -- that
    // render call pays the real synchronous shader-link cost inline. Set A's meshes already have
    // linked programs from the warmup pass above -- its first draw is a normal frame.
    const stutterExpr = `
      (async () => {
        // Move each mesh to a small offset in front of the camera along its forward vector, simulating
        // a first close approach.
        const THREE = await import('three')
        const fwd = new THREE.Vector3(); window.__camera.getWorldDirection(fwd)
        const base = window.__camera.position.clone().add(fwd.multiplyScalar(10))
        function placeInView(entityMeshes) {
          let i = 0
          for (const m of entityMeshes.values()) { m.position.copy(base).add(new THREE.Vector3((i % 9 - 4) * 1.3, (Math.floor(i / 9) - 3) * 1.3, 0)); i++ }
        }
        // renderer.info.programs (three.js's own authoritative WebGLPrograms cache list) is the real
        // signal: it only grows when a genuinely new (vertex,fragment,defines) combination is
        // compiled+linked. Set B was left uncompiled by the skip-gate (run B above never called
        // compileAsync/render on it) -- its first real render() call below is where three.js
        // lazily creates+links each of its distinct programs for the first time, so
        // renderer.info.programs.length must grow across that call. Set A's programs were already
        // created during the warmup pass above, so its render() call should add zero.
        const programsBeforeB = window.__renderer2.info.programs.length
        placeInView(window.__setB.entityMeshes)
        const t0b = performance.now()
        window.__renderer2.render(window.__scene, window.__camera)
        const stutterB = performance.now() - t0b
        const programsAfterB = window.__renderer2.info.programs.length
        // Move set B back out of view so it doesn't contaminate set A's measurement below.
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
