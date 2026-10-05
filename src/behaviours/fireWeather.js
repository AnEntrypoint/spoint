function rainByteOf(w, config) {
  if (!w || !Number.isFinite(w.intensity)) return 0
  const intensity = Math.max(0, Math.min(1, w.intensity))
  if (w.type === 'rain') return Math.round(intensity * config.rainPerIntensity)
  if (w.type === 'snow') return Math.round(intensity * config.rainPerIntensity * config.snowRainFraction)
  return 0
}

export function createFireWeather({ config, readWeather, stepTicks }) {
  let rain = 0
  let moisture = 0
  let emittedRain = 0
  let emittedMoisture = 0

  function advance() {
    rain = rainByteOf(readWeather(), config)
    if (rain > 0) moisture = Math.min(config.maxMoisture, moisture + Math.ceil(config.wetPerStep * rain / 255))
    else moisture = Math.max(0, moisture - config.dryPerStep)
  }

  function pendingEmits(out) {
    out.rain = -1; out.moisture = -1
    if (rain !== emittedRain) out.rain = rain
    const edge = moisture === 0 || moisture === config.maxMoisture
    if (Math.abs(moisture - emittedMoisture) >= config.hysteresis || (edge && moisture !== emittedMoisture)) out.moisture = moisture
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
    get emittedRain() { return emittedRain },
    get emittedMoisture() { return emittedMoisture },
    markEmitted(r, m) { emittedRain = r; emittedMoisture = m },
  }
}
