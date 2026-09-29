export function buildGridGeometry(gridSize) {
  const g2 = gridSize + 2
  const n2 = g2 + 1
  const du = 1.0 / gridSize
  const vlist = []
  for (let y = 0; y < n2; y++) for (let x = 0; x < n2; x++) {
    const isRing = (x === 0 || x === n2 - 1 || y === 0 || y === n2 - 1)
    const px = Math.min(Math.max((x - 1) * du, 0.0), 1.0)
    const py = Math.min(Math.max((y - 1) * du, 0.0), 1.0)
    vlist.push(px, py, isRing ? 1.0 : 0.0)
  }
  const idx = []
  for (let y = 0; y < g2; y++) for (let x = 0; x < g2; x++) {
    const a = y * n2 + x, b = a + 1, c = a + n2, d = c + 1
    let h = (x | (y << 16)) | 0
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b | 0)
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b | 0)
    h = h ^ (h >>> 16)
    if ((h >>> 17) & 1) idx.push(a, c, d, a, d, b)
    else idx.push(a, c, b, b, c, d)
  }
  return { vertices: new Float32Array(vlist), indices: new Uint32Array(idx) }
}

export function perspectiveZeroToOne(fovy, aspect, near, far, out) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far)
  const o = out || new Float32Array(16)
  o[0] = f / aspect; o[1] = 0; o[2] = 0; o[3] = 0
  o[4] = 0; o[5] = f; o[6] = 0; o[7] = 0
  o[8] = 0; o[9] = 0; o[10] = far * nf; o[11] = -1
  o[12] = 0; o[13] = 0; o[14] = far * near * nf; o[15] = 0
  return o
}
