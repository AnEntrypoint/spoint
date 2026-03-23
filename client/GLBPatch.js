export function patchGLB(uint8, url) {
  let result
  try {
    const ab = uint8.buffer, v = new DataView(ab)
    if (v.getUint32(0, true) !== 0x46546C67) return ab
    const jsonLen = v.getUint32(12, true)
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
