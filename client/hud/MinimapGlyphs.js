import { GLYPH_STRIDE, GLYPH_ROCK, GLYPH_CLASS_COUNT } from './MinimapPlacements.js'

const GLYPH_RGB = [[43, 101, 38], [28, 74, 59], [147, 178, 60], [74, 138, 54], [102, 118, 58], [176, 176, 171]]
const SHADE_LEVELS = [0.62, 0.8, 0.95, 1.08, 1.22]
const SHADE_LEVEL_EDGES = [0.72, 0.88, 1.02, 1.15]
const GLYPH_FILL = GLYPH_RGB.map(rgb => SHADE_LEVELS.map(m => `rgb(${rgb.map(c => Math.min(255, Math.round(c * m))).join(',')})`))
const GLYPH_EDGE = 'rgba(8,16,8,0.35)'
const ROCK_EDGE = 'rgba(30,30,30,0.85)'
const MIN_GLYPH_PX = 1.1
const MODEL_FILL = 'rgba(255,138,36,0.42)'
const MODEL_EDGE = '#ffa040'
const MIN_MODEL_PX = 4

function shadeLevelOf(m) {
  let l = 0
  while (l < SHADE_LEVEL_EDGES.length && m > SHADE_LEVEL_EDGES[l]) l++
  return l
}

export function paintChunkGlyphs(ctx, packed, originX, originZ, pxPerMeter, dpr, relief) {
  const n = packed.length
  if (!n) return
  const minR = MIN_GLYPH_PX * dpr
  const cells = relief.cells, cellInv = 1 / relief.cellMeters
  ctx.lineWidth = 0.6 * dpr
  for (let cls = 0; cls < GLYPH_CLASS_COUNT; cls++) {
    for (let level = 0; level < SHADE_LEVELS.length; level++) {
      let any = false
      ctx.beginPath()
      for (let o = 0; o < n; o += GLYPH_STRIDE) {
        if (packed[o + 2] !== cls) continue
        const ci = Math.min(cells - 1, Math.max(0, ((packed[o] - originX) * cellInv) | 0))
        const cj = Math.min(cells - 1, Math.max(0, ((packed[o + 1] - originZ) * cellInv) | 0))
        if (shadeLevelOf(relief.shade[cj * cells + ci]) !== level) continue
        const x = (packed[o] - originX) * pxPerMeter, y = (packed[o + 1] - originZ) * pxPerMeter
        const r = Math.max(minR, packed[o + 3] * pxPerMeter)
        if (cls === GLYPH_ROCK) { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath() }
        else { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2) }
        any = true
      }
      if (!any) continue
      ctx.fillStyle = GLYPH_FILL[cls][level]
      ctx.strokeStyle = cls === GLYPH_ROCK ? ROCK_EDGE : GLYPH_EDGE
      ctx.fill(); ctx.stroke()
    }
  }
}

export function paintFootprints(ctx, corners, count, originX, originZ, pxPerMeter, dpr) {
  if (!count) return
  ctx.lineWidth = 1.4 * dpr
  ctx.fillStyle = MODEL_FILL
  ctx.strokeStyle = MODEL_EDGE
  const minHalf = MIN_MODEL_PX * dpr * 0.5
  for (let i = 0; i < count; i++) {
    const o = i * 8
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    ctx.beginPath()
    for (let c = 0; c < 4; c++) {
      const x = (corners[o + c * 2] - originX) * pxPerMeter, y = (corners[o + c * 2 + 1] - originZ) * pxPerMeter
      if (c === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
    }
    ctx.closePath()
    if (maxX - minX < 2 * minHalf && maxY - minY < 2 * minHalf) {
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
      ctx.beginPath(); ctx.rect(cx - minHalf, cy - minHalf, 2 * minHalf, 2 * minHalf)
    }
    ctx.fill(); ctx.stroke()
  }
}
