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

function _coveredBytes(view) {
  const { buffer, byteOffset, byteLength } = view
  if (byteOffset === 0 && byteLength === buffer.byteLength) return buffer
  return buffer.slice(byteOffset, byteOffset + byteLength)
}

export function patchGLB(uint8, url) {
  let result
  const view = uint8 instanceof ArrayBuffer ? new Uint8Array(uint8) : uint8
  try {
    const { buffer: ab, byteOffset: base, byteLength: size } = view
    const v = new DataView(ab, base, size)
    if (v.getUint32(0, true) !== 0x46546C67) return _coveredBytes(view)
    const jsonLen = v.getUint32(12, true)
    if (20 + jsonLen > size) return _coveredBytes(view)
    if (!_hasTexturesKey(new Uint8Array(ab, base + 20, jsonLen), 0, jsonLen)) return _coveredBytes(view)
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, base + 20, jsonLen)))
    if (!json.textures) return _coveredBytes(view)
    const needsPatch = json.textures.some(t => t.source === undefined && (!t.extensions || !Object.keys(t.extensions).some(k => t.extensions[k]?.source !== undefined)))
    if (!needsPatch) return _coveredBytes(view)
    json.textures = json.textures.map(t => {
      if (t.source === undefined && (!t.extensions || !Object.keys(t.extensions).some(k => t.extensions[k]?.source !== undefined))) return { ...t, source: 0 }
      return t
    })
    const patched = new TextEncoder().encode(JSON.stringify(json))
    const pad = (4 - (patched.length % 4)) % 4
    const tail = size - 20 - jsonLen
    const out = new ArrayBuffer(12 + 8 + patched.length + pad + tail)
    const ov = new DataView(out), ou = new Uint8Array(out)
    ov.setUint32(0, 0x46546C67, true); ov.setUint32(4, v.getUint32(4, true), true); ov.setUint32(8, out.byteLength, true)
    ov.setUint32(12, patched.length + pad, true); ov.setUint32(16, 0x4E4F534A, true)
    ou.set(patched, 20)
    for (let i = 0; i < pad; i++) ou[20 + patched.length + i] = 0x20
    ou.set(new Uint8Array(ab, base + 20 + jsonLen, tail), 20 + patched.length + pad)
    return out
  } catch (_) { return _coveredBytes(view) }
}
