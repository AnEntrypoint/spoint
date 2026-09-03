import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { processGLB, detectDraco, MAX_TEX } from './glb-processor.js'

async function optimizeDir(dir) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const fp = join(dir, e.name)
    if (e.isDirectory()) { await optimizeDir(fp); continue }
    if (!e.isFile() || (!e.name.endsWith('.glb') && !e.name.endsWith('.vrm'))) continue
    await optimizePath(fp)
  }
}

async function optimizePath(p) {
  let stat
  try { stat = statSync(p) } catch { console.warn(`[optimize] not found: ${p}`); return }
  if (stat.isDirectory()) { await optimizeDir(p); return }
  if (!p.endsWith('.glb') && !p.endsWith('.vrm')) return
  const original = readFileSync(p)
  const t0 = Date.now()
  const optimized = await processGLB(original)
  if (optimized) {
    writeFileSync(p, optimized)
    const savedKB = (original.length - optimized.length) / 1024
    const dracoNote = detectDraco(original) ? ' + stripped Draco' : ''
    console.log(`[optimize] ${basename(p)}: ${(original.length/1024).toFixed(0)}KB -> ${(optimized.length/1024).toFixed(0)}KB (${savedKB > 0 ? '-' : '+'}${Math.abs(savedKB).toFixed(0)}KB)${dracoNote} in ${Date.now()-t0}ms`)
  } else {
    console.log(`[optimize] ${basename(p)}: already optimized, skipped`)
  }
}

const paths = process.argv.slice(2)
if (paths.length === 0) { console.error('Usage: node scripts/optimize-models.js <dir|file> [...]'); process.exit(1) }
console.log(`[optimize] GPU memory optimization: downscaling textures >${MAX_TEX}px, stripping Draco...`)
for (const p of paths) await optimizePath(p)
console.log('[optimize] done')
