// HeightfieldCodec.js -- compact binary codec for the sector-bounded quantized heightfield, so the
// baked field is ~1 byte/node (vs JSON int-arrays) -- small enough to keep large regions (up to a
// whole-planet coarse base) resident in RAM and stream by pure array lookup. Runtime-safe (Node + Web
// Worker; no DOM/three). Used by scripts/bake-heightfield.mjs (encode) + TerrainPhysics (decode).
//
// Binary layout (little-endian ArrayBuffer):
//   [0]  u32 magic 0x48464d31 ('HFM1')
//   [4]  u32 headerLen
//   [8]  utf8 header JSON (headerLen bytes): { N, extent, center:[x,z], anchorDir, radius, reliefScale,
//        anchorHeight, sectors:{ gridS, nodesPerSector, bits } }   bits in {8,16}
//   then f32[gridS*gridS] sectorMin, f32[gridS*gridS] sectorMax, then nodes: u8[N*N] (bits=8) | u16[N*N] (bits=16)
//
// Node value q maps to sectorMin + (q/qmax)*(sectorMax-sectorMin) for the sector it falls in (qmax=2^bits-1).

const MAGIC = 0x48464d31

function _utf8Encode(s) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s)
  return Uint8Array.from(Buffer.from(s, 'utf8'))   // Node fallback
}
function _utf8Decode(u8) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(u8)
  return Buffer.from(u8).toString('utf8')
}

// Encode { N, extent, center, anchorDir, radius, reliefScale, anchorHeight, sectors:{gridS,nodesPerSector,bits},
// sectorMin[], sectorMax[], q[] } -> ArrayBuffer.
export function encodeHeightfield(a) {
  const { N, sectors } = a
  const gridS = sectors.gridS, bits = sectors.bits || 8, nSec = gridS * gridS
  const header = JSON.stringify({ N, extent: a.extent, center: a.center, anchorDir: a.anchorDir, radius: a.radius, reliefScale: a.reliefScale, anchorHeight: a.anchorHeight, sectors: { gridS, nodesPerSector: sectors.nodesPerSector, bits } })
  const hbytes = _utf8Encode(header)
  // pad the header so the following Float32Array sectorMin starts 4-byte aligned (typed-array views
  // require offset % BYTES_PER_ELEMENT == 0). headerLen records the PADDED length.
  const hpad = (4 - ((8 + hbytes.length) & 3)) & 3
  const hlen = hbytes.length + hpad
  const nodeBytes = (bits === 16 ? 2 : 1) * N * N
  const total = 8 + hlen + 4 * nSec * 2 + nodeBytes
  const buf = new ArrayBuffer(total)
  const dv = new DataView(buf)
  dv.setUint32(0, MAGIC, true)
  dv.setUint32(4, hlen, true)
  new Uint8Array(buf, 8, hbytes.length).set(hbytes)
  for (let i = hbytes.length; i < hlen; i++) new Uint8Array(buf, 8 + i, 1)[0] = 0x20   // pad with spaces (valid JSON trailing ws)
  let off = 8 + hlen
  const fmin = new Float32Array(buf, off, nSec); for (let i = 0; i < nSec; i++) fmin[i] = a.sectorMin[i]; off += 4 * nSec
  const fmax = new Float32Array(buf, off, nSec); for (let i = 0; i < nSec; i++) fmax[i] = a.sectorMax[i]; off += 4 * nSec
  if (bits === 16) { const u = new Uint16Array(buf, off, N * N); for (let i = 0; i < N * N; i++) u[i] = a.q[i] }
  else { const u = new Uint8Array(buf, off, N * N); for (let i = 0; i < N * N; i++) u[i] = a.q[i] }
  return buf
}

// Decode ArrayBuffer -> { ...header, sectorMin:Float32Array, sectorMax:Float32Array, q:(Uint8|Uint16)Array }.
// Returns null if the magic is wrong (caller falls back to JSON / live CPU).
export function decodeHeightfield(buf) {
  if (!buf || buf.byteLength < 8) return null
  const dv = new DataView(buf)
  if (dv.getUint32(0, true) !== MAGIC) return null
  const hlen = dv.getUint32(4, true)
  const header = JSON.parse(_utf8Decode(new Uint8Array(buf, 8, hlen)))
  const { N, sectors } = header
  const gridS = sectors.gridS, bits = sectors.bits || 8, nSec = gridS * gridS
  let off = 8 + hlen
  const sectorMin = new Float32Array(buf, off, nSec); off += 4 * nSec
  const sectorMax = new Float32Array(buf, off, nSec); off += 4 * nSec
  const q = bits === 16 ? new Uint16Array(buf, off, N * N) : new Uint8Array(buf, off, N * N)
  return { ...header, sectors: { gridS, nodesPerSector: sectors.nodesPerSector, qmax: (1 << bits) - 1, bits }, sectorMin, sectorMax, q }
}
