#!/usr/bin/env node
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
    const readyExpr = '!!(window.__app && window.__app.el && window.__app.el.entityMeshes)'
    const t0 = Date.now()
    while (Date.now() - t0 < 60000) {
      if (await evalIn(readyExpr).catch(() => false)) break
      await new Promise(r => setTimeout(r, 1000))
    }
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
