import { waterlineLocalY } from '../terrain/PlanetFrame.js'

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

export function sampleMinimapCell(frame, anchorField, x, z, out) {
  const h = frame.groundHeightLocal(x, z)
  const climate = anchorField && anchorField.sampleDir ? anchorField.sampleDir(frame.localToDir(x, z)) : NEUTRAL_CLIMATE
  const rgb = biomeColor(h, climate.temp || 0, climate.humidity || 0, waterlineLocalY(frame, x, z))
  out[0] = rgb[0] | 0; out[1] = rgb[1] | 0; out[2] = rgb[2] | 0
  return h
}
