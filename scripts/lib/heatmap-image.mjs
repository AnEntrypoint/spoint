const DARK_BACKGROUND_BYTE = 0x10

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

  const cellPx = opts.cellPx ?? 6
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxCount = 0
  for (const c of cells) {
    if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x
    if (c.z < minZ) minZ = c.z; if (c.z > maxZ) maxZ = c.z
    if (c.count > maxCount) maxCount = c.count
  }
  const gridW = Math.max(1, maxX - minX + 1), gridH = Math.max(1, maxZ - minZ + 1)
  const imgW = gridW * cellPx, imgH = gridH * cellPx

  const buf = Buffer.alloc(imgW * imgH * 3, DARK_BACKGROUND_BYTE)
  const heatColor = (t) => {
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
