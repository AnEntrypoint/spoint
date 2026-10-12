// One derivation of the collider lattice, read by both sides of the terrain: the server's Jolt
// heightfield and the client's near-band rendered mesh. A near field coarser than the surface the
// engine already computes and holds is a decimation of work already paid for, so the spacing is not
// a dial either side may set: it is the finer of the configured lattice and the source the collider
// follows, from here, once.
//
// The rule mirrors src/terrain/HeightfieldStreamer.js's floorN exactly (same inputs, same
// expression). HeightfieldStreamer is the authority that BUILDS the field; this module is the one
// that ANSWERS what spacing that field has, so the renderer can built the same lattice without
// loading physics. scripts/nearfield-lattice-parity-witness.mjs asserts the two agree.

export const COLLIDER_DEFAULT_EXTENT_M = 510
export const COLLIDER_DEFAULT_RESOLUTION_M = 4

const FIELD_WASM_BYTES_PER_SAMPLE = 4
const FINE_FIELD_WASM_BUDGET_BYTES = 1024 * 1024
// The bound that keeps a fine field under a megabyte of samples; the streamer clamps its floor to
// the same number, so the two cannot disagree about what the lattice is.
const FINE_FIELD_MAX_N = Math.floor(Math.sqrt(FINE_FIELD_WASM_BUDGET_BYTES / FIELD_WASM_BYTES_PER_SAMPLE))

function positiveFinite(name, v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

function evenN(n) {
  return n % 2 === 0 ? n : n + 1
}

// A lattice coarser than the source it follows is a pure decimation, and that decimation is the
// whole of the collider's disagreement with the ground. So the answer is the FINER of the two, and
// a world that follows its source gets the source's spacing instead of the configured one.
export function colliderLatticeOf(tcfg, opts = {}) {
  const tphys = (tcfg && typeof tcfg === 'object' && tcfg.physics) || {}
  const extent = positiveFinite('physics.extent', tphys.extent) ?? COLLIDER_DEFAULT_EXTENT_M
  const resolution = positiveFinite('physics.resolution', tphys.resolution) ?? COLLIDER_DEFAULT_RESOLUTION_M
  const configuredN = evenN(Math.max(2, Math.round(extent / resolution)))
  const sourceSpacingM = positiveFinite('sourceSpacingM', opts.sourceSpacingM) ?? 0
  const followsSource = tphys.followSource !== false && sourceSpacingM > 0
  let N = configuredN
  let sourceN = 0
  if (followsSource) {
    // N-1 intervals of the source's spacing span the field, which lands the lattice ON the source's
    // own nodes instead of near them: measured on the default world, 1.0039 m nodes leave 0.0080 m
    // mean / 0.1667 m max of pure lattice error where 1.0000 m nodes leave 0.0002 m / 0.0005 m.
    sourceN = Math.min(Math.max(2, Math.round(extent / sourceSpacingM) + 1), FINE_FIELD_MAX_N)
    if (sourceN > N) N = sourceN
  }
  return Object.freeze({
    extentM: extent,
    resolutionM: resolution,
    configuredN,
    configuredSpacingM: extent / (configuredN - 1),
    sourceSpacingM,
    sourceN,
    N,
    spacingM: extent / (N - 1),
    followsSource,
    fineFieldMaxN: FINE_FIELD_MAX_N,
  })
}

// The spacing a baked artifact carries, read from the same artifact the server builds its field
// from. It is the source's own lattice, not the collider's: the collider is the finer of this and
// the configured resolution, which is what colliderLatticeOf answers.
export function sourceSpacingOfBake(baked) {
  if (!baked || !Number.isInteger(baked.N) || baked.N < 2) return 0
  const extent = positiveFinite('baked.extent', baked.extent)
  if (extent === null) return 0
  return extent / (baked.N - 1)
}

const COLLIDER_BAKE_READ_TIMEOUT_MS = 4000
const _isNode = typeof process !== 'undefined' && !!process.versions && !!process.versions.node
const _codecSpec = _isNode ? 'mapspinner/heightfield-codec' : '/node_modules/mapspinner/src/heightfield-codec.js'

// The spacing the collider actually builds at, resolved from the same baked artifact the server
// builds its field from. Only the artifact's sample count and extent are read -- no height is
// recomputed here -- so this cannot introduce a second height function. Where there is no bake, or
// it cannot be read, the configured lattice stands and the near band degrades to it; a lattice
// coarser than the collider is a no-op rather than a regression, because the near band never draws
// coarser than the leaf it replaces.
export async function colliderLatticeSpacingOf(tcfg) {
  const url = tcfg && tcfg.bakedHeightfield
  let sourceSpacingM = 0
  let kind = 'configured'
  if (url) {
    try {
      const { decodeHeightfield } = await import(_codecSpec)
      let buf = null
      if (_isNode) {
        const fs = await import('node:fs')
        const raw = fs.readFileSync(String(url).replace(/^\//, ''))
        buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
      } else {
        // Bounded: this runs on the boot path and a hung asset fetch must never hold up the planet.
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null
        const timer = ctrl ? setTimeout(() => ctrl.abort(), COLLIDER_BAKE_READ_TIMEOUT_MS) : null
        try {
          const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          buf = await res.arrayBuffer()
        } finally { if (timer) clearTimeout(timer) }
      }
      const spacing = sourceSpacingOfBake(decodeHeightfield(buf))
      if (spacing > 0) { sourceSpacingM = spacing; kind = 'bake' }
    } catch (e) {
      console.warn(`[terrain] near-field lattice: ${url} could not be read, so the near band takes the configured collider lattice instead of the baked one:`, (e && e.message) || e)
    }
  }
  const lattice = colliderLatticeOf(tcfg, { sourceSpacingM })
  return { ...lattice, kind }
}
