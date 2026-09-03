// No-dependency 8-bit grayscale PNG encoder (node zlib only) + heightfield->grayscale mapping, used
// by scripts/lab.mjs's heightmap subcommand. Pure, stateless -- no reference to lab.mjs's CLI/CDP state.

import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const tb = Buffer.from(type, 'ascii')
  const body = Buffer.concat([tb, data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
// grayscale 8-bit PNG from a width*height Uint8Array
export function encodePNGGray(width, height, gray) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0   // 8-bit, grayscale
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0                                            // filter: none
    gray.subarray(y * width, (y + 1) * width).forEach((v, x) => { raw[y * (width + 1) + 1 + x] = v })
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// map elevation field -> grayscale, optional hillshade relief
export function toGray(field, hillshade) {
  const { w, h, elev, min, max } = field
  const g = new Uint8Array(w * h)
  const span = (max - min) || 1
  if (!hillshade) {
    for (let i = 0; i < w * h; i++) g[i] = Math.max(0, Math.min(255, Math.round((elev[i] - min) / span * 255)))
    return g
  }
  // simple lambert hillshade from finite-difference slope (light from NW, high)
  const lx = -0.5, ly = -0.5, lz = 0.7, ll = Math.hypot(lx, ly, lz)
  const scale = 255 / span
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1)
    const yu = Math.max(0, y - 1), yd = Math.min(h - 1, y + 1)
    const dzdx = (elev[y * w + xr] - elev[y * w + xl]) * scale
    const dzdy = (elev[yd * w + x] - elev[yu * w + x]) * scale
    let nx = -dzdx, ny = -dzdy, nz = 2.0
    const nl = Math.hypot(nx, ny, nz) || 1
    let lum = (nx * lx + ny * ly + nz * lz) / (nl * ll)
    const base = (elev[y * w + x] - min) / span
    const v = Math.max(0, Math.min(1, 0.35 * base + 0.65 * Math.max(0, lum)))
    g[y * w + x] = Math.round(v * 255)
  }
  return g
}

export { crc32 }
