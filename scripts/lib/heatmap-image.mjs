// heatmap-image.mjs -- renders a real playtest-bot heatmap grid (see apps/playtest-bot/index.js's
// getHeatmap onMessage / scripts/playtest-heatmap-run.mjs's aggregated heatmap.json shape) to a real
// PNG image, using `sharp` (package.json optionalDependencies) IF it is actually resolvable at
// runtime in this environment. sharp is optional and, as of this writing, is NOT installed in every
// worktree/environment this repo runs in -- so this module dynamic-imports it in a try/catch and
// returns null (with a clear console note explaining why) rather than crashing the caller or silently
// producing nothing without saying so. The JSON grid (already written by every caller) is always the
// real, always-available export path; the PNG is a best-effort visualization on top of it.
//
//   import { buildHeatmapPNG } from './lib/heatmap-image.mjs'
//   const wrote = await buildHeatmapPNG(heatmap, '/path/to/heatmap.png')   // heatmap = {cellSize, cells:[{x,z,count}]}
//   if (!wrote) { /* sharp unavailable -- JSON grid is still the real output */ }

export async function buildHeatmapPNG(heatmap, outPath, opts = {}) {
  const cells = heatmap?.cells || []
  if (cells.length === 0) {
    console.log('[heatmap-image] no cells in heatmap grid -- nothing to render')
    return false
  }

  let sharp
  try {
    ({ default: sharp } = await import('sharp'))
  } catch (e) {
    console.log(`[heatmap-image] sharp is not installed in this environment (optionalDependency, dynamic-import failed: ${e.message}) -- skipping PNG export, the JSON grid is the real data output`)
    return false
  }

  const cellPx = opts.cellPx ?? 6   // rendered pixels per grid cell, upscaled for visibility
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxCount = 0
  for (const c of cells) {
    if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x
    if (c.z < minZ) minZ = c.z; if (c.z > maxZ) maxZ = c.z
    if (c.count > maxCount) maxCount = c.count
  }
  const gridW = Math.max(1, maxX - minX + 1), gridH = Math.max(1, maxZ - minZ + 1)
  const imgW = gridW * cellPx, imgH = gridH * cellPx

  // Raw RGB buffer, filled with a dark background then each visited cell painted a heat color
  // (blue=low -> red=high, a simple linear ramp -- no external colormap dependency needed).
  const buf = Buffer.alloc(imgW * imgH * 3, 0x10)
  const heatColor = (t) => {
    // t in [0,1]: 0=blue(cold/low-visit), 0.5=green, 1=red(hot/high-visit)
    const r = Math.round(255 * Math.max(0, Math.min(1, (t - 0.5) * 2)))
    const b = Math.round(255 * Math.max(0, Math.min(1, (0.5 - t) * 2)))
    const g = Math.round(255 * (1 - Math.abs(t - 0.5) * 2))
    return [r, g, b]
  }
  for (const c of cells) {
    const t = maxCount > 0 ? c.count / maxCount : 0
    const [r, g, b] = heatColor(t)
    const gx = c.x - minX, gz = c.z - minZ
    for (let py = 0; py < cellPx; py++) {
      const rowY = gz * cellPx + py
      for (let px = 0; px < cellPx; px++) {
        const colX = gx * cellPx + px
        const idx = (rowY * imgW + colX) * 3
        buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b
      }
    }
  }

  await sharp(buf, { raw: { width: imgW, height: imgH, channels: 3 } }).png().toFile(outPath)
  return true
}

export default buildHeatmapPNG
