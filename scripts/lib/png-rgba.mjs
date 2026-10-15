// Dependency-free PNG (8-bit RGB/RGBA, non-interlaced) decode/encode plus the per-band mean
// absolute difference used by the grass frame capture witness. Node built-ins only.
import { inflateSync, deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()

export function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let p = 8
  let w = 0, h = 0, depth = 0, color = 0
  const idat = []
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported here')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  if (depth !== 8 || (color !== 2 && color !== 6)) throw new Error(`unsupported PNG: depth=${depth} colorType=${color}`)
  const ch = color === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(stride * h)
  let q = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[q++]
    const line = raw.subarray(q, q + stride)
    q += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0
      const b = prev ? prev[i] : 0
      const c = (prev && i >= ch) ? prev[i - ch] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[i] = v & 0xff
    }
  }
  return { w, h, ch, pixels: out }
}

// rgba: Buffer of w*h*4 bytes.
export function encodePNG(w, h, rgba) {
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const chunk = (type, data) => {
    const b = Buffer.alloc(8 + data.length + 4)
    b.writeUInt32BE(data.length, 0)
    b.write(type, 4, 'ascii')
    data.copy(b, 8)
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length)
    return b
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

// Rows y0..y0+ch-1 of a decoded image, full width, as RGBA.
export function cropRows(img, y0, rows) {
  const w = img.w
  const out = Buffer.alloc(w * rows * 4, 0)
  for (let y = 0; y < rows; y++) {
    const sy = y0 + y
    if (sy < 0 || sy >= img.h) continue
    for (let x = 0; x < w; x++) {
      const s = (sy * w + x) * img.ch
      const d = (y * w + x) * 4
      out[d] = img.pixels[s]; out[d + 1] = img.pixels[s + 1]; out[d + 2] = img.pixels[s + 2]
      out[d + 3] = img.ch === 4 ? img.pixels[s + 3] : 255
    }
  }
  return { w, h: rows, pixels: out }
}

// Mean absolute difference per RGB channel between two same-size RGBA crops, and the
// per-pixel absolute difference image (RGBA, alpha 255, channels clamped to 255).
export function meanAbsDiff(a, b) {
  if (a.w !== b.w || a.h !== b.h) throw new Error('diff of two different-sized crops')
  const n = a.w * a.h
  const sum = [0, 0, 0]
  const diffImg = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.pixels[o + c] - b.pixels[o + c])
      sum[c] += d
      diffImg[o + c] = Math.min(255, d * 4)
    }
    diffImg[o + 3] = 255
  }
  return { mad: sum.map((s) => (n ? s / n : 0)), diffImg, pixels: n }
}
