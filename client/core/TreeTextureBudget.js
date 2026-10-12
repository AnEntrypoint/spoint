// ez-tree loads its bark and leaf maps at 1024x1024 inside its own module scope,
// before any client code can reach them, so the only place a budget can be applied
// is the decoded image at species build time. The budget is a maximum edge in
// pixels, and every value that reaches the halver has come through
// resolveTreeTextureBudget: a value that is supplied but cannot be honoured is
// refused there, never coerced into the default.

export const TREE_TEXTURE_SOURCE_PX = 1024
export const TREE_TEXTURE_MIN_PX = 64
export const TREE_TEXTURE_MAX_PX = 1024
export const LEAF_TEXTURE_MAX_PX_DEFAULT = 256
export const BARK_TEXTURE_MAX_PX_DEFAULT = 64
export const TREE_TEXTURE_HALVING_LIMIT = 16

export class TreeTextureBudgetError extends Error {
  constructor(reasonCode, detail) {
    super(reasonCode + ': ' + detail)
    this.name = 'TreeTextureBudgetError'
    this.reasonCode = reasonCode
  }
}

export function treeTextureQueryValue(search, key) {
  if (typeof search !== 'string') throw new TreeTextureBudgetError('search-not-a-string', `search is ${typeof search}`)
  if (!search) return null
  const m = search.match(new RegExp('[?&]' + key + '=([^&]*)'))
  return m ? m[1] : null
}

export function parseTreeTextureMaxPx(raw, source) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string' && raw.trim() === '') {
    throw new TreeTextureBudgetError('empty-value', `${source} supplied no value`)
  }
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new TreeTextureBudgetError('not-a-number', `${source} = ${String(raw)} (${typeof raw})`)
  }
  if (!Number.isFinite(n)) throw new TreeTextureBudgetError('not-a-number', `${source} = ${JSON.stringify(raw)}`)
  if (!Number.isInteger(n)) throw new TreeTextureBudgetError('not-an-integer', `${source} = ${String(raw)}`)
  if (n <= 0 || (n & (n - 1)) !== 0) throw new TreeTextureBudgetError('not-a-power-of-two', `${source} = ${n}`)
  if (n < TREE_TEXTURE_MIN_PX) throw new TreeTextureBudgetError('below-minimum', `${source} = ${n} < ${TREE_TEXTURE_MIN_PX}`)
  if (n > TREE_TEXTURE_MAX_PX) throw new TreeTextureBudgetError('above-maximum', `${source} = ${n} > ${TREE_TEXTURE_MAX_PX}`)
  return n
}

function pickMaxPx(fromUrl, fromCfg, fallback, key) {
  const url = parseTreeTextureMaxPx(fromUrl, '?' + key + '=')
  if (url !== null) return url
  const cfg = parseTreeTextureMaxPx(fromCfg, 'cfg.' + key)
  if (cfg !== null) return cfg
  return fallback
}

export function resolveTreeTextureBudget(spec = {}) {
  if (spec === null || typeof spec !== 'object') throw new TreeTextureBudgetError('spec-not-an-object', `spec is ${typeof spec}`)
  const search = spec.search === undefined ? '' : spec.search
  const cfg = spec.cfg === undefined || spec.cfg === null ? {} : spec.cfg
  if (typeof cfg !== 'object') throw new TreeTextureBudgetError('cfg-not-an-object', `cfg is ${typeof cfg}`)
  return {
    leafMaxPx: pickMaxPx(treeTextureQueryValue(search, 'leaftex'), cfg.leafTextureMaxPx, LEAF_TEXTURE_MAX_PX_DEFAULT, 'leaftex'),
    barkMaxPx: pickMaxPx(treeTextureQueryValue(search, 'barktex'), cfg.barkTextureMaxPx, BARK_TEXTURE_MAX_PX_DEFAULT, 'barktex'),
    sourcePx: TREE_TEXTURE_SOURCE_PX,
  }
}

export function assertTreeTextureMaxPx(maxPx, source) {
  if (maxPx === null || parseTreeTextureMaxPx(maxPx, source) === null) {
    throw new TreeTextureBudgetError('max-px-not-supplied', source)
  }
  return maxPx
}

export function halvingsFor(widthPx, maxPx) {
  if (!Number.isInteger(widthPx) || widthPx <= 0) {
    throw new TreeTextureBudgetError('not-a-texture-width', `widthPx = ${String(widthPx)}`)
  }
  const target = assertTreeTextureMaxPx(maxPx, 'maxPx')
  let n = 0
  let w = widthPx
  while (w > target && n < TREE_TEXTURE_HALVING_LIMIT) { w = w >> 1; n++ }
  return n
}

export function decodedRgbaBytes(widthPx, heightPx) {
  return widthPx * heightPx * 4
}

export function mipChainBytes(widthPx, heightPx) {
  let total = 0
  let w = widthPx
  let h = heightPx
  while (w >= 1 && h >= 1) {
    total += decodedRgbaBytes(Math.max(1, w), Math.max(1, h))
    w = w >> 1
    h = h >> 1
    if (w === 0 && h === 0) break
  }
  return total
}
