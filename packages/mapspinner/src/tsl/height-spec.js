export const CONTINENTAL_BIAS_AMP = 50.0
export const FRACTAL_HEIGHT_M = 750000.0
export const UNDERWATER_GAIN = 1.25
export const UNDERWATER_FLOOR_M = -350000.0
export const DEFAULT_BEACH_SHELF_M = 150.0

export const HASH_VERSION_FLOAT = 1
export const HASH_VERSION_INTEGER = 2
export const HASH_VERSIONS = [HASH_VERSION_FLOAT, HASH_VERSION_INTEGER]
export const MAX_TERRAIN_CARVES = 4

const LATTICE_MUL_X = 0x8da6b343
const LATTICE_MUL_Y = 0xd8163841
const LATTICE_MUL_Z = 0xcb1ab31f
const AVALANCHE_MUL_A = 0x7feb352d
const AVALANCHE_MUL_B = 0x846ca68b
const UNIT_24BIT = 1.0 / 16777216.0
const OCTAVE_ROTATION_STEP = 0.5236
export const OCTAVE_ROTATION_TABLE_SIZE = 32
export const OCTAVE_ROTATION_COS = Float32Array.from({ length: OCTAVE_ROTATION_TABLE_SIZE }, (_, i) => Math.cos(i * OCTAVE_ROTATION_STEP))
export const OCTAVE_ROTATION_SIN = Float32Array.from({ length: OCTAVE_ROTATION_TABLE_SIZE }, (_, i) => Math.sin(i * OCTAVE_ROTATION_STEP))

export function assertHashVersion(hashVersion) {
  if (!HASH_VERSIONS.includes(hashVersion)) throw new RangeError(`terrain hashVersion must be one of ${HASH_VERSIONS.join(', ')}, got ${hashVersion}`)
  return hashVersion
}

export function carveChord2(radiusM, planetRadiusM) {
  const a = radiusM / planetRadiusM
  return a * a
}

export function defineHeightSpec(o, { hashVersion = HASH_VERSION_FLOAT, carveCount = 0 } = {}) {
  assertHashVersion(hashVersion)
  if (!Number.isInteger(carveCount) || carveCount < 0 || carveCount > MAX_TERRAIN_CARVES) throw new RangeError(`terrain carveCount must be an integer 0..${MAX_TERRAIN_CARVES}, got ${carveCount}`)
  if (carveCount > 0 && hashVersion === HASH_VERSION_FLOAT) throw new RangeError('terrain carves need hashVersion 2: the legacy GLSL terrain (hashVersion 1) has no carve term, so a carve would split physics from the rendered ground')
  const floatHash = o.fn('msH3', [['p', 'vec3']], 'float', (p) => {
    const q0 = o.fract(o.mul(p, o.v3(0.1031, 0.1030, 0.0973)))
    const q = o.add(q0, o.dot(q0, o.add(o.swz(q0, 'yxz'), 33.33)))
    return o.sub(o.mul(o.fract(o.mul(o.add(o.x(q), o.y(q)), o.z(q))), 2.0), 1.0)
  })

  const integerHash = o.fn('msH3i', [['p', 'vec3']], 'float', (p) => {
    const mixed = o.uxor(o.uxor(o.umul(o.u32(o.x(p)), LATTICE_MUL_X), o.umul(o.u32(o.y(p)), LATTICE_MUL_Y)), o.umul(o.u32(o.z(p)), LATTICE_MUL_Z))
    const a = o.umul(o.uxor(mixed, o.ushr(mixed, 16)), AVALANCHE_MUL_A)
    const b = o.umul(o.uxor(a, o.ushr(a, 15)), AVALANCHE_MUL_B)
    const h = o.uxor(b, o.ushr(b, 16))
    return o.sub(o.mul(o.mul(o.ufloat(o.ushr(h, 8)), UNIT_24BIT), 2.0), 1.0)
  })

  const h3 = hashVersion === HASH_VERSION_INTEGER ? integerHash : floatHash

  const snoise3 = o.fn('msSnoise3', [['P', 'vec3']], 'float', (P) => {
    const fl = o.floor(P)
    const f = o.sub(P, fl)
    const u = o.mul(o.mul(o.mul(f, f), f), o.add(o.mul(f, o.sub(o.mul(f, 6.0), 15.0)), 10.0))
    const i1 = o.add(fl, 1.0)
    const x0 = o.x(fl), y0 = o.y(fl), z0 = o.z(fl)
    const x1 = o.x(i1), y1 = o.y(i1), z1 = o.z(i1)
    const ux = o.x(u), uy = o.y(u), uz = o.z(u)
    const n000 = h3(fl)
    const n100 = h3(o.v3(x1, y0, z0))
    const n010 = h3(o.v3(x0, y1, z0))
    const n110 = h3(o.v3(x1, y1, z0))
    const n001 = h3(o.v3(x0, y0, z1))
    const n101 = h3(o.v3(x1, y0, z1))
    const n011 = h3(o.v3(x0, y1, z1))
    const n111 = h3(i1)
    const x00 = o.mix(n000, n100, ux), x10 = o.mix(n010, n110, ux)
    const x01 = o.mix(n001, n101, ux), x11 = o.mix(n011, n111, ux)
    return o.mix(o.mix(x00, x10, uy), o.mix(x01, x11, uy), uz)
  })

  const octaveRotation = hashVersion === HASH_VERSION_INTEGER
    ? (i) => o.octaveRotation(i)
    : (i) => { const angle = o.mul(i, OCTAVE_ROTATION_STEP); return [o.cos(angle), o.sin(angle)] }

  const rotateDomain = (p, i) => {
    const [c, s] = octaveRotation(i)
    return o.v3(o.sub(o.mul(c, o.x(p)), o.mul(s, o.z(p))), o.y(p), o.add(o.mul(s, o.x(p)), o.mul(c, o.z(p))))
  }

  const valueFbm = (x, gain, octaves) => {
    const [v, , norm] = o.fold(octaves, [0.0, 1.0, 0.0, x], (i, [v, a, n, p]) => [
      o.add(v, o.mul(a, snoise3(p))), o.mul(a, gain), o.add(n, a), o.mul(p, 2.0),
    ])
    return o.div(v, norm)
  }

  const valueRidgedFbmRot = (x, gain, octaves, offset, exponent) => {
    const [v, , norm] = o.fold(octaves, [0.0, 1.0, 0.0, 1.0, x], (i, [v, w, n, a, p]) => {
      const signal = o.let(o.pow(o.max(o.sub(offset, o.abs(snoise3(p))), 0.0), exponent))
      return [
        o.add(v, o.mul(o.mul(signal, w), a)), o.clamp(signal, 0.0, 1.0), o.add(n, a), o.mul(a, gain),
        rotateDomain(o.mul(p, 2.0), i),
      ]
    })
    return o.div(v, o.max(norm, 1e-5))
  }

  const layerRidgedBase = (p) => valueRidgedFbmRot(p, 0.5, 10, 1.064, 1.005)
  const layerFbm = (p) => o.add(-2.0, o.mul(4.0, o.add(o.mul(valueFbm(p, 0.5, 18), 0.5), 0.5)))
  const layerRidged = (p) => o.add(-2.0, o.mul(4.0, valueRidgedFbmRot(p, 0.5, 18, 1.064, 1.1)))

  const sampleFractalTerrain = (p) => {
    const h0 = o.let(layerRidgedBase(p))
    const warped = o.let(o.add(p, o.mul(o.mul(p, 1.6), h0)))
    return o.div(o.add(o.add(h0, layerFbm(warped)), layerRidged(warped)), 3.0)
  }

  const fractalTerrainH = (dir0) => {
    const dirN = o.normalize(dir0)
    const p = o.mul(dirN, 3.0)
    const h = o.let(o.mul(o.sub(sampleFractalTerrain(p), 0.17), 0.6))
    const pmix = o.add(o.mul(snoise3(o.add(o.mul(p, 0.53), o.v3(123.0, 456.0, 789.0))), 0.5), 0.5)
    const e = o.mul(0.8, o.mix(0.95, 1.3, pmix))
    const shaped = o.mul(o.sel(o.gt(h, 0.0), 1.0, -1.0), o.pow(o.abs(h), e))
    const cRatio = o.clamp(o.add(o.mul(snoise3(o.mul(dirN, 4.0)), 0.5), 0.7), 0.3, 1.0)
    return o.mul(shaped, cRatio)
  }

  const cubeFaceUV = (dIn) => {
    const d = o.normalize(dIn)
    const dx = o.x(d), dy = o.y(d), dz = o.z(d)
    const ax = o.abs(dx), ay = o.abs(dy), az = o.abs(dz)
    const onX = o.and(o.ge(ax, ay), o.ge(ax, az))
    const onY = o.and(o.not(onX), o.ge(ay, az))
    const sx = o.div(1.0, ax), sy = o.div(1.0, ay), sz = o.div(1.0, az)
    const face = o.sel(onX, o.sel(o.gt(dx, 0.0), 0.0, 1.0), o.sel(onY, o.sel(o.gt(dy, 0.0), 2.0, 3.0), o.sel(o.gt(dz, 0.0), 4.0, 5.0)))
    const u = o.sel(onX, o.mul(o.sel(o.gt(dx, 0.0), o.neg(dz), dz), sx), o.sel(onY, o.mul(dx, sy), o.mul(o.sel(o.gt(dz, 0.0), dx, o.neg(dx)), sz)))
    const v = o.sel(onX, o.mul(dy, sx), o.sel(onY, o.mul(o.sel(o.gt(dy, 0.0), o.neg(dz), dz), sy), o.mul(dy, sz)))
    return [face, o.add(o.mul(u, 0.5), 0.5), o.add(o.mul(v, 0.5), 0.5)]
  }

  const quintic = (t) => o.mul(o.mul(o.mul(t, t), t), o.add(o.mul(t, o.sub(o.mul(t, 6.0), 15.0)), 10.0))

  const hpfSample = (dir) => {
    const [face, fu, fv] = cubeFaceUV(dir)
    const denom = o.sub(o.param('hpfRes'), 1.0)
    const tx = o.mul(fu, denom), ty = o.mul(fv, denom)
    const fx0 = o.floor(tx), fy0 = o.floor(ty)
    const wx = quintic(o.sub(tx, fx0)), wy = quintic(o.sub(ty, fy0))
    const x0 = o.clamp(fx0, 0.0, denom), y0 = o.clamp(fy0, 0.0, denom)
    const x1 = o.min(o.add(x0, 1.0), denom), y1 = o.min(o.add(y0, 1.0), denom)
    const s00 = o.hpfTexel(face, x0, y0), s10 = o.hpfTexel(face, x1, y0)
    const s01 = o.hpfTexel(face, x0, y1), s11 = o.hpfTexel(face, x1, y1)
    const ea = o.add(s00, o.mul(o.sub(s10, s00), wx))
    const eb = o.add(s01, o.mul(o.sub(s11, s01), wx))
    return o.add(ea, o.mul(o.sub(eb, ea), wy))
  }

  const shapeHeight = (frac, cbias) => {
    const h = o.let(o.add(o.add(o.mul(frac, FRACTAL_HEIGHT_M), o.mul(cbias, CONTINENTAL_BIAS_AMP)), o.param('landBias')))
    const beachParam = o.param('beachShelfM')
    const shelf = o.sel(o.gt(beachParam, 1.0), beachParam, DEFAULT_BEACH_SHELF_M)
    const shelved = o.sel(o.lt(h, shelf), o.mul(o.div(o.mul(h, h), shelf), o.sub(2.0, o.div(h, shelf))), h)
    const underwater = o.max(o.mul(h, UNDERWATER_GAIN), UNDERWATER_FLOOR_M)
    return o.sel(o.lt(h, 0.0), underwater, shelved)
  }

  const applyReliefScale = (h) => {
    const reliefParam = o.param('reliefScale')
    return o.mul(h, o.sel(o.gt(reliefParam, 0.0), reliefParam, 1.0))
  }

  const carveTerrain = (dir0, h) => {
    if (carveCount === 0) return h
    const dir = o.normalize(dir0)
    const [carved] = o.fold(carveCount, [h], (i, [hPrev]) => {
      const [center, innerChord2, outerChord2, targetH] = o.carve(i)
      const offset = o.sub(dir, center)
      const t = o.clamp(o.div(o.sub(o.dot(offset, offset), innerChord2), o.sub(outerChord2, innerChord2)), 0.0, 1.0)
      return [o.mix(targetH, hPrev, o.mul(o.mul(t, t), o.sub(3.0, o.mul(2.0, t))))]
    })
    return carved
  }

  const naturalHeight = (dir0) => shapeHeight(fractalTerrainH(dir0), o.x(hpfSample(dir0)))
  const composeHeight = (dir0) => applyReliefScale(carveTerrain(dir0, naturalHeight(dir0)))

  return { hashVersion, carveCount, h3, snoise3, fractalTerrainH, hpfSample, naturalHeight, composeHeight, cubeFaceUV }
}
