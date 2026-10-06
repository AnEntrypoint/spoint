import { FIRE_MAX_WIND_COMPONENT } from '../shared/fire/fireWire.js'

const WIND_AXES = 3

function rainByteOf(w, config) {
  if (!w || !Number.isFinite(w.intensity)) return 0
  const intensity = Math.max(0, Math.min(1, w.intensity))
  if (w.type === 'rain') return Math.round(intensity * config.rainPerIntensity)
  if (w.type === 'snow') return Math.round(intensity * config.rainPerIntensity * config.snowRainFraction)
  return 0
}

function windOf(w) {
  if (!w || !Array.isArray(w.wind) || w.wind.length !== WIND_AXES) return null
  const out = [0, 0, 0]
  for (let i = 0; i < WIND_AXES; i++) {
    if (!Number.isFinite(w.wind[i])) return null
    out[i] = Math.max(-FIRE_MAX_WIND_COMPONENT, Math.min(FIRE_MAX_WIND_COMPONENT, Math.round(w.wind[i])))
  }
  return out
}

export function createFireWeather({ config, readWeather, stepTicks, wind: initialWind = [0, 0, 0] }) {
  let rain = 0
  let moisture = 0
  let emittedRain = 0
  let emittedMoisture = 0
  const wind = [initialWind[0] | 0, initialWind[1] | 0, initialWind[2] | 0]
  const emittedWind = [wind[0], wind[1], wind[2]]

  function advance() {
    const w = readWeather()
    rain = rainByteOf(w, config)
    if (rain > 0) moisture = Math.min(config.maxMoisture, moisture + Math.ceil(config.wetPerStep * rain / 255))
    else moisture = Math.max(0, moisture - config.dryPerStep)
    const next = windOf(w)
    if (next !== null) { wind[0] = next[0]; wind[1] = next[1]; wind[2] = next[2] }
  }

  function pendingEmits(out) {
    out.rain = -1; out.moisture = -1; out.wind = null
    if (rain !== emittedRain) out.rain = rain
    const edge = moisture === 0 || moisture === config.maxMoisture
    if (Math.abs(moisture - emittedMoisture) >= config.hysteresis || (edge && moisture !== emittedMoisture)) out.moisture = moisture
    if (wind[0] !== emittedWind[0] || wind[1] !== emittedWind[1] || wind[2] !== emittedWind[2]) out.wind = [wind[0], wind[1], wind[2]]
    return out
  }

  return {
    step(simTick, out) {
      if (simTick % stepTicks !== 0) return null
      advance()
      return pendingEmits(out)
    },
    get rain() { return rain },
    get moisture() { return moisture },
    get wind() { return [wind[0], wind[1], wind[2]] },
    get emittedRain() { return emittedRain },
    get emittedMoisture() { return emittedMoisture },
    get emittedWind() { return [emittedWind[0], emittedWind[1], emittedWind[2]] },
    markEmitted(r, m, w) {
      emittedRain = r
      emittedMoisture = m
      if (Array.isArray(w) && w.length === WIND_AXES) { emittedWind[0] = w[0]; emittedWind[1] = w[1]; emittedWind[2] = w[2] }
    },
  }
}
