export function bakeHpfTexels(anchorField, hpfRes) {
  const bakeMaxLevel = Math.round(Math.log2(hpfRes))
  const out = new Float32Array(6 * hpfRes * hpfRes * 4)
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < hpfRes; y++) {
      const fv = y / (hpfRes - 1)
      for (let x = 0; x < hpfRes; x++) {
        const s = anchorField.sampleUV(face, x / (hpfRes - 1), fv, bakeMaxLevel)
        const o = ((face * hpfRes + y) * hpfRes + x) * 4
        out[o] = s.seaBias; out[o + 1] = s.elevAmp; out[o + 2] = s.temp; out[o + 3] = s.humidity
      }
    }
  }
  return out
}
