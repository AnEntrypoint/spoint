#!/usr/bin/env node
// Edge deploy prep (edge-cf-draco-glb-collider-not-yet-edge-safe): make GLB collider assets safe to
// load on a Cloudflare Worker/Durable Object runtime BEFORE the edge target ever tries to fetch/parse
// them.
//
// src/physics/DracoDecompressor.js's getDracoDecoder() imports the real npm package `draco3dgltf`,
// whose own bundled Emscripten glue (draco_decoder_gltf_nodejs.js) has UNCONDITIONAL top-level
// `require('fs')`/`require('path')` calls with zero browser/edge fallback of its own -- unlike
// jolt-physics/mapspinner/xstate/msgpackr (all fixed this session via a specifier-built-at-runtime
// trick that defeats esbuild's static resolution), there is no equivalent escape hatch for a pre-built
// pure-JS npm package's own top-level require() calls. A specifier-built-at-runtime fix on
// DracoDecompressor.js's own import() makes an edge/DO BUILD succeed for any world that never actually
// calls getDracoDecoder(), but the function itself genuinely cannot run on the edge if reached.
//
// Real fix (option (a) from the row): a build-time-only Draco decode step, so the edge runtime never
// needs draco3dgltf at all -- src/physics/GLBLoader.js's readGLBAsync/extractAllMeshesFromGLBAsync only
// calls decompressDracoMesh when `prim.extensions?.KHR_draco_mesh_compression` is actually present on
// the asset; if every GLB an edge deploy serves has already had that extension stripped (a plain,
// uncompressed mesh baked back in, same technique scripts/glb-processor.js's stripDraco already uses
// for the gh-pages static-asset pipeline via optimize-models.js), the Draco code path is simply never
// reached at runtime on the edge, no matter what world/collider config is loaded.
//
// This script is the edge-target equivalent of optimize-models.js: walks a GLB tree (default apps/,
// where every collider-source map/prop GLB lives) and re-writes any Draco-compressed file in place with
// its Draco extension stripped (mesh data re-encoded as plain, uncompressed accessors) via the SAME
// gltf-transform NodeIO pipeline glb-processor.js's stripDraco already uses (verified round-trip via a
// real 'draco3d' Node decode+encode). Unlike optimize-models.js it does NOT touch textures (that stays
// the gh-pages-only concern) -- this is scoped purely to the edge-Draco-collider hazard.
//
// Usage: node scripts/prep-edge-collider-assets.mjs [dir ...]   (default: apps)
//        node scripts/prep-edge-collider-assets.mjs --check [dir ...]   (dry-run: report only, exit
//        non-zero if any Draco-compressed GLB is found -- for a CI/deploy-gate use, matching this row's
//        own 'a real live wrangler dev workerd build+boot ... is the decisive witness either way' ask:
//        run --check as a pre-deploy gate so a fresh Draco-compressed asset can never regress this fix)
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { detectDraco, stripDraco } from './glb-processor.js'

function log(msg) { console.log(`[prep-edge-collider-assets] ${msg}`) }

async function walk(dir, check, hits) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const fp = join(dir, e.name)
    if (e.isDirectory()) { await walk(fp, check, hits); continue }
    if (!e.isFile() || !e.name.endsWith('.glb')) continue
    await prepFile(fp, check, hits)
  }
}

async function prepFile(fp, check, hits) {
  let buf
  try { buf = readFileSync(fp) } catch { log(`WARNING: could not read ${fp}, skipped`); return }
  if (!detectDraco(buf)) return
  hits.push(fp)
  if (check) { log(`DRACO-COMPRESSED (would strip): ${fp}`); return }
  const t0 = Date.now()
  const stripped = await stripDraco(buf)
  writeFileSync(fp, stripped)
  const savedKB = (buf.length - stripped.length) / 1024
  log(`${basename(fp)}: ${(buf.length/1024).toFixed(0)}KB -> ${(stripped.length/1024).toFixed(0)}KB (${savedKB > 0 ? '-' : '+'}${Math.abs(savedKB).toFixed(0)}KB) in ${Date.now()-t0}ms`)
}

async function main() {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const dirs = argv.filter(a => !a.startsWith('--'))
  const targets = dirs.length ? dirs : ['apps']
  const hits = []
  log(`scanning [${targets.join(', ')}] for Draco-compressed GLB collider assets${check ? ' (--check, dry-run)' : ''}...`)
  for (const d of targets) await walk(d, check, hits)
  if (hits.length === 0) { log('no Draco-compressed GLBs found -- edge-safe.'); return }
  if (check) {
    log(`FAILED: ${hits.length} Draco-compressed GLB(s) found -- not yet edge-safe. Run without --check to strip them.`)
    process.exit(1)
  }
  log(`done -- stripped Draco from ${hits.length} file(s).`)
}

main().catch(err => { console.error('[prep-edge-collider-assets] FAILED:', err); process.exit(1) })
