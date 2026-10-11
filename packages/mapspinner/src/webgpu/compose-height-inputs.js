const HPF_FACES = 6
const HPF_CHANNELS = 4
const HPF_STRIDE = HPF_FACES * HPF_CHANNELS
const SCULPT_STRIDE = 1
const DEFAULT_RES = 1

function resFromLength(length, stride) {
  const cells = length / stride
  if (!Number.isInteger(cells)) return 0
  const res = Math.round(Math.sqrt(cells))
  return res * res === cells ? res : 0
}

function parsePoolRes(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`parseComposeHeightPoolInputs: poolRes must be a positive integer, got ${value}`)
  }
  return value
}

function parseField(name, resOpt, texOpt, stride) {
  if (resOpt != null && !Number.isFinite(resOpt)) {
    throw new TypeError(`parseComposeHeightInputs: ${name}Res must be a finite number`)
  }
  if (texOpt instanceof Float32Array && texOpt.length > 0) {
    const res = resFromLength(texOpt.length, stride)
    if (res < 1) {
      throw new TypeError(`parseComposeHeightInputs: ${name} length ${texOpt.length} is not ${stride} * res * res`)
    }
    const declared = resOpt == null ? res : resOpt | 0
    if (declared !== res) {
      throw new TypeError(`parseComposeHeightInputs: ${name}Res ${declared} disagrees with ${name} length ${texOpt.length} (res ${res})`)
    }
    return texOpt
  }
  const declared = resOpt == null ? DEFAULT_RES : Math.max(DEFAULT_RES, resOpt | 0)
  return new Float32Array(stride * declared * declared)
}

function composeHeightShape(hpfPool, sculptTex) {
  return {
    get hpfRes() { return resFromLength(hpfPool.length, HPF_STRIDE) },
    get sculptRes() { return resFromLength(sculptTex.length, SCULPT_STRIDE) },
    hpfPool,
    sculptTex,
  }
}

export function parseComposeHeightInputs(opts) {
  const o = opts || {}
  return Object.freeze(composeHeightShape(
    parseField('hpfPool', o.hpfRes, o.hpfPool, HPF_STRIDE),
    parseField('sculptTex', o.sculptRes, o.sculptTex, SCULPT_STRIDE),
  ))
}

export function parseComposeHeightPoolInputs(opts) {
  const o = opts || {}
  const shape = composeHeightShape(
    parseField('hpfPool', o.hpfRes, o.hpfPool, HPF_STRIDE),
    parseField('sculptTex', o.sculptRes, o.sculptTex, SCULPT_STRIDE),
  )
  shape.poolRes = parsePoolRes(o.poolRes)
  return Object.freeze(shape)
}
