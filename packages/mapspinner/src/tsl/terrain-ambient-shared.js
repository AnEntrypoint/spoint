export const INV_PI = 1 / Math.PI

export const SUN_IRRADIANCE_GAIN = 1.25
export const SKY_IRRADIANCE_SCALE = 0.075
export const SKY_BALANCE_TO_GREY = 0.35
export const SKY_FILL_TINT = [0.85, 0.92, 1.10]
export const TERMINATOR_TINT = [1.0, 0.55, 0.34]
export const NIGHT_FILL = [0.06, 0.075, 0.11]
export const AMBIENT_FLOOR_ALBEDO = 0.14
export const AMBIENT_FLOOR_ADD = [0.020, 0.026, 0.038]
export const AP_GATE_KM = [3.0, 120.0]
export const SUN_DARK_LUMINANCE = 1e-4
export const SHADOW_CASCADE_NAME_PREFIX = 'shadowCascade'
export const RAYLEIGH_SKY_TINT = 0.4
export const SKY_DAY_MU = [-0.10, 0.25]
export const TERMINATOR_FADE_SIN = Math.sin(10 * Math.PI / 180)

export const LUMA = [0.2126, 0.7152, 0.0722]

export function luma(rgb) {
  return LUMA[0] * rgb[0] + LUMA[1] * rgb[1] + LUMA[2] * rgb[2]
}

export const ACES_FILMIC = [2.51, 0.03, 2.43, 0.59, 0.14]
export const DISPLAY_GAMMA_INV = 1 / 2.2

export function acesFilmicChannel(x) {
  const c = Math.min(1, Math.max(0, x))
  const mapped = c * (c * ACES_FILMIC[0] + ACES_FILMIC[1]) / (c * (c * ACES_FILMIC[2] + ACES_FILMIC[3]) + ACES_FILMIC[4])
  return Math.min(1, Math.max(0, mapped))
}

export function terrainGrade(rgb, { dayShade = 1, nightFill = [0, 0, 0], exposure = 1, lookSat = 1, lookContrast = 1 } = {}) {
  const c = [0, 0, 0]
  for (let i = 0; i < 3; i++) c[i] = (rgb[i] * dayShade + nightFill[i]) * exposure
  const mapped = [acesFilmicChannel(c[0]), acesFilmicChannel(c[1]), acesFilmicChannel(c[2])]
  const grey = luma(mapped)
  const graded = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const sat = grey + (mapped[i] - grey) * lookSat
    graded[i] = Math.pow(Math.min(1, Math.max(0, (sat - 0.5) * lookContrast + 0.5)), DISPLAY_GAMMA_INV)
  }
  return graded
}

function smoothstepUnit(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

export function terrainSkyIrradiance({ muS, ndotUp = 1, skyFill, solar, rayleigh }) {
  const hemi = (ndotUp + 1) * 0.5
  const day = smoothstepUnit(SKY_DAY_MU[0], SKY_DAY_MU[1], muS)
  const tint = rayleigh.map((c) => 1 + (c / rayleigh[0] - 1) * RAYLEIGH_SKY_TINT)
  const scaled = [solar[0] * SKY_IRRADIANCE_SCALE, solar[1] * SKY_IRRADIANCE_SCALE, solar[2] * SKY_IRRADIANCE_SCALE]
  const irr = [0, 0, 0]
  for (let c = 0; c < 3; c++) irr[c] = scaled[c] * day * tint[c] * hemi
  const grey = luma(irr)
  const out = [0, 0, 0]
  for (let c = 0; c < 3; c++) out[c] = (grey + (irr[c] - grey) * SKY_BALANCE_TO_GREY) * skyFill * SKY_FILL_TINT[c]
  return out
}

export function terrainNightAmount(muS, termWidth) {
  return 1 - smoothstepUnit(-termWidth, 0, muS)
}

export function terrainDayShade(muS, { termWidth, nightFloor }) {
  return nightFloor + (1 - nightFloor) * smoothstepUnit(-termWidth, termWidth, muS)
}

export function vegetationAmbientDelta({ muS, ndotUp = 1, skyFill, solar, rayleigh, ambIrr, termWidth, nightFloor }) {
  const sky = terrainSkyIrradiance({ muS, ndotUp, skyFill, solar, rayleigh })
  const nightAmt = terrainNightAmount(muS, termWidth)
  const dayAmt = 1 - nightAmt
  const albedoMul = [0, 0, 0]
  const add = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    albedoMul[c] = sky[c] * INV_PI + dayAmt * (AMBIENT_FLOOR_ALBEDO - ambIrr[c])
    add[c] = AMBIENT_FLOOR_ADD[c] * dayAmt
  }
  return { albedoMul, add, nightAmt, dayShade: terrainDayShade(muS, { termWidth, nightFloor }), sky }
}

export function surfaceAmbientComparison({ muS, ndotUp = 1, skyFill, solar, rayleigh, ambIrr, termWidth, nightFloor, albedo }) {
  const nightAmt = terrainNightAmount(muS, termWidth)
  const dayAmt = 1 - nightAmt
  const sky = terrainSkyIrradiance({ muS, ndotUp, skyFill, solar, rayleigh })
  const terrain = [0, 0, 0]
  const vegetation = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    terrain[c] = albedo * sky[c] * INV_PI + albedo * (AMBIENT_FLOOR_ALBEDO + (ambIrr[c] - AMBIENT_FLOOR_ALBEDO) * nightAmt) + AMBIENT_FLOOR_ADD[c] * dayAmt
    vegetation[c] = albedo * ambIrr[c]
  }
  return { terrain, vegetation, sky, nightAmt, dayShade: terrainDayShade(muS, { termWidth, nightFloor }) }
}
