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
    return { res, tex: texOpt }
  }
  const declared = resOpt == null ? DEFAULT_RES : Math.max(DEFAULT_RES, resOpt | 0)
  return { res: declared, tex: new Float32Array(stride * declared * declared) }
}

export function parseComposeHeightInputs(opts) {
  const o = opts || {}
  const hpf = parseField('hpfPool', o.hpfRes, o.hpfPool, HPF_STRIDE)
  const sculpt = parseField('sculptTex', o.sculptRes, o.sculptTex, SCULPT_STRIDE)
  return {
    hpfRes: hpf.res,
    sculptRes: sculpt.res,
    hpfPool: hpf.tex,
    sculptTex: sculpt.tex,
  }
}
