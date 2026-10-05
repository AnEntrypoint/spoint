import zlib from 'node:zlib'

export function decodePng(base64) {
  const b = Buffer.from(base64, 'base64')
  let o = 8, w = 0, h = 0, colorType = 2
  const idat = []
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8), chunk = b.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') { w = chunk.readUInt32BE(0); h = chunk.readUInt32BE(4); colorType = chunk[9] }
    if (type === 'IDAT') idat.push(chunk)
    o += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = colorType === 6 ? 4 : 3, stride = w * bpp, px = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const r = raw[y * (stride + 1) + 1 + x]
      const a = x >= bpp ? px[y * stride + x - bpp] : 0
      const up = y > 0 ? px[(y - 1) * stride + x] : 0
      const ul = y > 0 && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0
      let v = r
      if (filter === 1) v = r + a
      else if (filter === 2) v = r + up
      else if (filter === 3) v = r + ((a + up) >> 1)
      else if (filter === 4) {
        const p = a + up - ul, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul)
        v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? up : ul)
      }
      px[y * stride + x] = v & 255
    }
  }
  const rgb = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = px[i * bpp + c]
  return { w, h, rgb }
}

export function regionMasks(ref) {
  const { w, h, rgb } = ref, n = w * h
  let horizon = 0
  for (let y = 0; y < h; y++) {
    let skyish = 0
    for (let x = 0; x < w; x++) { const i = y * w + x; if (rgb[i * 3 + 2] > rgb[i * 3] + 40 && rgb[i * 3 + 2] > 150) skyish++ }
    if (skyish < 0.5 * w) { horizon = y; break }
  }
  const names = ['sky', 'terrain', 'grass', 'water', 'leftLower', 'leftEdge', 'vegColumn']
  const masks = Object.fromEntries(names.map(k => [k, []]))
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (y > 0.86 * h || y < 0.06 * h) continue
    const i = y * w + x, r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2]
    if (y < horizon) { masks.sky.push(i); continue }
    if (g > r + 10 && g >= b) masks.grass.push(i)
    else if (b > g && b > r + 20) masks.water.push(i)
    else masks.terrain.push(i)
    if (y >= 0.6 * h && x < 0.4 * w) masks.leftLower.push(i)
    if (x < 0.1 * w) masks.leftEdge.push(i)
    if (x >= 0.5 * w && x < 0.77 * w) masks.vegColumn.push(i)
  }
  return { horizon, masks, pixels: n }
}

export function regionMean(img, idx) {
  const s = [0, 0, 0]
  for (const i of idx) for (let c = 0; c < 3; c++) s[c] += img.rgb[i * 3 + c]
  return s.map(v => idx.length ? +(v / idx.length).toFixed(2) : null)
}

export function regionMeanAbs(a, b, idx) {
  let s = 0
  for (const i of idx) for (let c = 0; c < 3; c++) s += Math.abs(a.rgb[i * 3 + c] - b.rgb[i * 3 + c])
  return idx.length ? +(s / (idx.length * 3)).toFixed(3) : null
}
