// ASCII bytes of `"textures"` -- the only glTF key this patch can ever act on. A raw byte scan of the
// JSON chunk for it is orders of magnitude cheaper than TextDecoder+JSON.parse of a multi-hundred-KB
// chunk (aim_sillos.glb's JSON chunk alone is ~300KB) and rules out every texture-less asset up front.
const _TEXTURES_KEY = [0x22, 0x74, 0x65, 0x78, 0x74, 0x75, 0x72, 0x65, 0x73, 0x22]
function _hasTexturesKey(bytes, start, len) {
  const end = start + len - _TEXTURES_KEY.length
  outer: for (let i = start; i <= end; i++) {
    if (bytes[i] !== 0x22 || bytes[i + 1] !== 0x74) continue
    for (let k = 2; k < _TEXTURES_KEY.length; k++) if (bytes[i + k] !== _TEXTURES_KEY[k]) continue outer
    return true
  }
  return false
}

export function patchGLB(uint8, url) {
  let result
  try {
    const ab = uint8.buffer, v = new DataView(ab)
    if (v.getUint32(0, true) !== 0x46546C67) return ab
    const jsonLen = v.getUint32(12, true)
    if (!_hasTexturesKey(new Uint8Array(ab, 20, jsonLen), 0, jsonLen)) return ab
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 20, jsonLen)))
    if (!json.textures) return ab
    const needsPatch = json.textures.some(t => t.source === undefined && (!t.extensions || !Object.keys(t.extensions).some(k => t.extensions[k]?.source !== undefined)))
    if (!needsPatch) return ab
    json.textures = json.textures.map(t => {
      if (t.source === undefined && (!t.extensions || !Object.keys(t.extensions).some(k => t.extensions[k]?.source !== undefined))) return { ...t, source: 0 }
      return t
    })
    const patched = new TextEncoder().encode(JSON.stringify(json))
    const pad = (4 - (patched.length % 4)) % 4
    const out = new ArrayBuffer(12 + 8 + patched.length + pad + (ab.byteLength - 20 - jsonLen))
    const ov = new DataView(out), ou = new Uint8Array(out)
    ov.setUint32(0, 0x46546C67, true); ov.setUint32(4, v.getUint32(4, true), true); ov.setUint32(8, out.byteLength, true)
    ov.setUint32(12, patched.length + pad, true); ov.setUint32(16, 0x4E4F534A, true)
    ou.set(patched, 20)
    for (let i = 0; i < pad; i++) ou[20 + patched.length + i] = 0x20
    ou.set(new Uint8Array(ab, 20 + jsonLen), 20 + patched.length + pad)
    return out
  } catch (_) { return uint8.buffer }
}
