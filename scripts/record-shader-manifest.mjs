#!/usr/bin/env node
// shader-warmup-manifest-per-map: records the real, live "which distinct model assets became
// resident in the first N seconds of a real play session" ground truth for one map, and writes it
// to apps/world/<world>.shadermanifest.json -- the checked-in manifest client/core/SceneSetup.js's
// warmupShaders() reads to drive an accurate, bounded warmup pass instead of guessing from
// whatever happens to be resident at cold-boot-plus-warmup-call time.
//
// Uses the shared headless-chromium CDP harness (scripts/lib/gpu-eval.mjs, the same one
// height-parity.mjs/bake-heightfield.mjs use) against a REAL running server -- this is a recorder
// tool, not a test file (AGENTS.md no-test-files-ever): its output IS the manifest artifact, there
// are no assertions.
//
// Usage: PORT=8090 node server.js   (in one terminal, already serving the target world)
//        node scripts/record-shader-manifest.mjs tps-game [seconds=60] [port=8090]
//
// Identity key: mesh.userData.modelUrl (stamped by client/EntityLoader.js's _tagMesh from
// entityState.model), the source GLB/glTF path -- stable across reloads/re-bakes, unlike
// material.uuid (regenerated per load).

import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withGpuPage } from './lib/gpu-eval.mjs'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const world = process.argv[2] || 'tps-game'
  const seconds = parseFloat(process.argv[3] || '60')
  const port = Number(process.argv[4] || process.env.PORT || 8090)
  const url = `http://localhost:${port}/?singleplayer&world=${world}&nc=${Date.now()}`

  console.log(`[record-shader-manifest] recording world=${world} for ${seconds}s real wall-clock via ${url}`)

  const { result } = await withGpuPage({ port, url, requireProbe: false, readyMs: 240000 }, async (evalIn) => {
    // Wait for the entity loader to exist and have at least started spawning entities.
    const readyExpr = '!!(window.__app && window.__app.el && window.__app.el.entityMeshes)'
    const t0 = Date.now()
    while (Date.now() - t0 < 60000) {
      if (await evalIn(readyExpr).catch(() => false)) break
      await new Promise(r => setTimeout(r, 1000))
    }
    // Poll every second for `seconds` real seconds, unioning every distinct modelUrl seen resident
    // on any entityMeshes root at each sample point. A plain single end-of-window snapshot would
    // MISS an asset that streamed in and was later evicted/replaced within the window; sampling
    // repeatedly is the honest way to capture "seen at any point in the first N seconds", not just
    // "resident at exactly second N".
    const samples = Math.max(1, Math.round(seconds))
    for (let i = 0; i < samples; i++) {
      await new Promise(r => setTimeout(r, 1000))
      await evalIn(`(()=>{ window.__shaderManifestUrls = window.__shaderManifestUrls || new Set();
        for (const m of window.__app.el.entityMeshes.values()) { const u = m && m.userData && m.userData.modelUrl; if (u) window.__shaderManifestUrls.add(u) }
        return window.__shaderManifestUrls.size; })()`)
    }
    const urls = await evalIn('Array.from(window.__shaderManifestUrls || [])')
    const entityCount = await evalIn('window.__app.el.entityMeshes.size')
    return { urls: (urls || []).sort(), entityCount }
  })

  const modelUrls = result.urls
  if (modelUrls.length === 0) {
    console.warn('[record-shader-manifest] WARNING: captured zero model URLs -- world may have no model-backed entities, or _tagMesh/modelUrl stamping is broken. Not writing a manifest.')
    process.exit(1)
  }

  const manifest = {
    world,
    recordedAt: new Date().toISOString(),
    windowSeconds: seconds,
    entityCountAtEnd: result.entityCount,
    modelUrls,
  }
  const outPath = resolve(SDK_ROOT, 'apps/world', `${world}.shadermanifest.json`)
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`[record-shader-manifest] wrote ${outPath}: ${modelUrls.length} distinct model URLs (of ${result.entityCount} resident entities at capture end)`)
  for (const u of modelUrls) console.log('  -', u)
}

main().catch(e => { console.error('[record-shader-manifest] FAILED:', e && e.message || e); process.exit(1) })
