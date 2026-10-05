import { guardedGroundHeight } from '../terrain/PlanetFrame.js'

const DEEP_OCEAN_BELOW_M = -200
const BEACH_TOP_M = 8
const SNOWCAP_ABOVE_M = 2200
const ROCK_SNOW_BLEND_ABOVE_M = 1300
const UPLAND_ABOVE_M = 500

export function biomeColor(height, temp, humidity, seaLevel) {
  const h = height - seaLevel
  if (h < DEEP_OCEAN_BELOW_M) return [18, 42, 92]
  if (h < 0) return [42, 92, 158]
  if (h < BEACH_TOP_M) return [214, 199, 152]
  if (h > SNOWCAP_ABOVE_M) return [235, 238, 242]
  if (h > ROCK_SNOW_BLEND_ABOVE_M) {
    const t = Math.max(0, Math.min(1, (h - ROCK_SNOW_BLEND_ABOVE_M) / 900))
    return lerp3([120, 118, 108], [235, 238, 242], t)
  }
  if (h > UPLAND_ABOVE_M) return lerp3([96, 128, 74], [120, 118, 108], Math.max(0, Math.min(1, (h - UPLAND_ABOVE_M) / 800)))
  const dry = [176, 164, 108]
  const forest = [58, 108, 58]
  const grass = [104, 150, 76]
  let base = lerp3(dry, grass, Math.max(0, Math.min(1, humidity)))
  base = lerp3(base, forest, Math.max(0, Math.min(1, humidity - 0.5)) * 2 * Math.max(0, Math.min(1, (temp - 0.15) / 0.7)))
  return base
}
function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] }

const NEUTRAL_CLIMATE = { temp: 0.5, humidity: 0.5 }

const _guardedMinimapHeight = new WeakMap()

export function sampleMinimapCell(frame, anchorField, x, z, out, yGuess) {
  let guarded = _guardedMinimapHeight.get(frame)
  if (!guarded) { guarded = guardedGroundHeight('minimap cell', (px, pz, pg) => frame.groundHeightLocal(px, pz, pg), NaN); _guardedMinimapHeight.set(frame, guarded) }
  const h = guarded(x, z, yGuess)
  out[4] = h
  if (!Number.isFinite(h)) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; return NaN }
  const dir = frame.localToDir(x, z, h)
  const elevation = frame.elevationAtDir(dir)
  if (!Number.isFinite(elevation)) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; return NaN }
  const climate = anchorField && anchorField.sampleDir ? anchorField.sampleDir(dir) : NEUTRAL_CLIMATE
  const rgb = biomeColor(elevation, climate.temp || 0, climate.humidity || 0, 0)
  out[0] = rgb[0] | 0; out[1] = rgb[1] | 0; out[2] = rgb[2] | 0
  out[3] = elevation >= 0 ? 1 : 0
  return elevation
}

const SUN_RAW = [-0.55, 0.62, -0.56]
const SUN_LEN = Math.hypot(SUN_RAW[0], SUN_RAW[1], SUN_RAW[2])
const SUN_X = SUN_RAW[0] / SUN_LEN, SUN_Y = SUN_RAW[1] / SUN_LEN, SUN_Z = SUN_RAW[2] / SUN_LEN
const RELIEF_EXAGGERATION = 3
const LIGHT_GAIN = 0.55
const STEEP_FROM = 0.25, STEEP_TO = 1.2, STEEP_DARKEN = 0.22
const SHADE_MIN = 0.5, SHADE_MAX = 1.3

export function reliefShade(dhdx, dhdz) {
  const gx = dhdx * RELIEF_EXAGGERATION, gz = dhdz * RELIEF_EXAGGERATION
  const lambert = (SUN_Y - gx * SUN_X - gz * SUN_Z) / Math.sqrt(gx * gx + 1 + gz * gz)
  const lit = 1 + LIGHT_GAIN * (lambert / SUN_Y - 1)
  const t = Math.max(0, Math.min(1, (Math.hypot(dhdx, dhdz) - STEEP_FROM) / (STEEP_TO - STEEP_FROM)))
  const shade = lit * (1 - STEEP_DARKEN * t * t * (3 - 2 * t))
  if (!Number.isFinite(shade)) return 1
  return shade < SHADE_MIN ? SHADE_MIN : shade > SHADE_MAX ? SHADE_MAX : shade
}

export function shadeHeightGrid(heights, rows, cols, spacingM, land, rgbIn, rgbOut, inChannels, outChannels, shadeOut) {
  for (let r = 0; r < rows; r++) {
    const up = r > 0 ? r - 1 : r, dn = r < rows - 1 ? r + 1 : r
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const ic = i * inChannels, oc = i * outChannels
      let m = 1
      if (land[i]) {
        const lf = c > 0 ? c - 1 : c, rt = c < cols - 1 ? c + 1 : c
        const dhdx = rt > lf ? (heights[r * cols + rt] - heights[r * cols + lf]) / ((rt - lf) * spacingM) : 0
        const dhdz = dn > up ? (heights[dn * cols + c] - heights[up * cols + c]) / ((dn - up) * spacingM) : 0
        m = reliefShade(dhdx, dhdz)
      }
      if (shadeOut) shadeOut[i] = m
      rgbOut[oc] = Math.min(255, rgbIn[ic] * m); rgbOut[oc + 1] = Math.min(255, rgbIn[ic + 1] * m); rgbOut[oc + 2] = Math.min(255, rgbIn[ic + 2] * m)
    }
  }
}
