
export const COLLIDER_DEFAULT_EXTENT_M = 510
export const COLLIDER_DEFAULT_RESOLUTION_M = 4

const FIELD_WASM_BYTES_PER_SAMPLE = 4
const FINE_FIELD_WASM_BUDGET_BYTES = 1024 * 1024
const FINE_FIELD_MAX_N = Math.floor(Math.sqrt(FINE_FIELD_WASM_BUDGET_BYTES / FIELD_WASM_BYTES_PER_SAMPLE))

function positiveFinite(name, v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

function evenN(n) {
  return n % 2 === 0 ? n : n + 1
}

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

export function sourceSpacingOfBake(baked) {
  if (!baked || !Number.isInteger(baked.N) || baked.N < 2) return 0
  const extent = positiveFinite('baked.extent', baked.extent)
  if (extent === null) return 0
  return extent / (baked.N - 1)
}

const COLLIDER_BAKE_READ_TIMEOUT_MS = 4000
const _isNode = typeof process !== 'undefined' && !!process.versions && !!process.versions.node
const _codecSpec = _isNode ? 'mapspinner/heightfield-codec' : '/node_modules/mapspinner/src/heightfield-codec.js'

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
