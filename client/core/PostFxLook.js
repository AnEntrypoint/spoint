export class PostFxLookError extends Error {
  constructor(reasonCode, detail) {
    super(`[postfx-look] ${reasonCode}: ${detail}`)
    this.name = 'PostFxLookError'
    this.reasonCode = reasonCode
  }
}

const RANGES = Object.freeze({
  exposure: [0, 4],
  contrast: [0, 2],
  saturation: [0, 2],
  vignette: [0, 1],
  chromaticAberration: [0, 0.05],
  scanlines: [0, 1],
  bloom: [0, 1],
})

const OPERATORS = Object.freeze(['exposure', 'contrast', 'saturation', 'vignette', 'chromaticAberration', 'scanlines', 'bloom'])

export function parsePostFxLook(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new PostFxLookError('look-invalid', 'look must be an object')
  const out = {}
  for (const key of Object.keys(spec)) {
    if (!OPERATORS.includes(key)) throw new PostFxLookError('operator-unknown', `${key} is not one of ${OPERATORS.join(', ')}`)
  }
  for (const key of OPERATORS) {
    if (spec[key] === undefined) continue
    const v = spec[key]
    const [lo, hi] = RANGES[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new PostFxLookError('operator-range', `${key} must be in [${lo}, ${hi}]`)
    out[key] = v
  }
  return Object.freeze(out)
}

export function applyLook(look, rgb, uv = [0.5, 0.5]) {
  const exposure = look.exposure ?? 1
  const contrast = look.contrast ?? 1
  const saturation = look.saturation ?? 1
  const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
  let out = rgb.map(c => {
    const e = c * exposure
    return (e - 0.5) * contrast + 0.5
  }).map(c => luma + (c - luma) * saturation)
  if (look.vignette) {
    const d = Math.hypot(uv[0] - 0.5, uv[1] - 0.5) * 2
    const v = 1 - look.vignette * Math.min(1, d * d)
    out = out.map(c => c * v)
  }
  return out.map(c => Math.min(1, Math.max(0, c)))
}

export function lookPasses(look) {
  if (look === null || typeof look !== 'object') throw new PostFxLookError('look-invalid', 'look must be a parsed look object')
  return OPERATORS.filter(op => look[op] !== undefined).map(op => Object.freeze({ op, value: look[op] }))
}

export function postfxLookNode() {
  return {
    id: 'postfx-look',
    reads: [],
    writes: ['postfxPasses'],
    terminal: true,
    shouldRun: ctx => ctx.postfxLook != null,
    run(ctx) {
      ctx.res.postfxPasses = lookPasses(ctx.postfxLook)
    },
  }
}
