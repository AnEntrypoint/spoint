const MAGIC = 0x48464d31
const JSON_WHITESPACE_PAD_BYTE = 0x20
const SUPPORTED_BITS = [8, 16]

function _assertBits(bits) {
  if (!SUPPORTED_BITS.includes(bits)) throw new RangeError(`heightfield quantization must be one of ${SUPPORTED_BITS.join(' or ')} bits, got ${bits}: any other width quantizes to a wider range than the stored array can hold and decodes as wrapped garbage`)
  return bits
}

function _utf8Encode(s) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s)
  return Uint8Array.from(Buffer.from(s, 'utf8'))
}
function _utf8Decode(u8) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(u8)
  return Buffer.from(u8).toString('utf8')
}

export function encodeHeightfield(a) {
  const { N, sectors } = a
  const gridS = sectors.gridS, bits = _assertBits(sectors.bits || 8), nSec = gridS * gridS
  const header = JSON.stringify({ N, extent: a.extent, center: a.center, anchorDir: a.anchorDir, radius: a.radius, reliefScale: a.reliefScale, anchorHeight: a.anchorHeight, seed: a.seed, hashVersion: a.hashVersion, terrainKey: a.terrainKey, codeVersion: a.codeVersion, sectors: { gridS, nodesPerSector: sectors.nodesPerSector, bits } })
  const hbytes = _utf8Encode(header)
  const headerPadToF32Align = (4 - ((8 + hbytes.length) & 3)) & 3
  const hlen = hbytes.length + headerPadToF32Align
  const nodeBytes = (bits === 16 ? 2 : 1) * N * N
  const total = 8 + hlen + 4 * nSec * 2 + nodeBytes
  const buf = new ArrayBuffer(total)
  const dv = new DataView(buf)
  dv.setUint32(0, MAGIC, true)
  dv.setUint32(4, hlen, true)
  new Uint8Array(buf, 8, hbytes.length).set(hbytes)
  for (let i = hbytes.length; i < hlen; i++) new Uint8Array(buf, 8 + i, 1)[0] = JSON_WHITESPACE_PAD_BYTE
  let off = 8 + hlen
  const fmin = new Float32Array(buf, off, nSec); for (let i = 0; i < nSec; i++) fmin[i] = a.sectorMin[i]; off += 4 * nSec
  const fmax = new Float32Array(buf, off, nSec); for (let i = 0; i < nSec; i++) fmax[i] = a.sectorMax[i]; off += 4 * nSec
  if (bits === 16) { const u = new Uint16Array(buf, off, N * N); for (let i = 0; i < N * N; i++) u[i] = a.q[i] }
  else { const u = new Uint8Array(buf, off, N * N); for (let i = 0; i < N * N; i++) u[i] = a.q[i] }
  return buf
}

export class HeightfieldCodecError extends Error {
  constructor(code, message) { super(message); this.name = 'HeightfieldCodecError'; this.code = code; }
}

export function decodeHeightfield(buf) {
  if (buf == null) throw new HeightfieldCodecError('heightfield-missing', 'decodeHeightfield: no buffer was given')
  if (buf.byteLength < 8) throw new HeightfieldCodecError('heightfield-short', `decodeHeightfield: ${buf.byteLength} byte(s) is shorter than the 8-byte prefix`)
  const dv = new DataView(buf)
  if (dv.getUint32(0, true) !== MAGIC) throw new HeightfieldCodecError('heightfield-bad-magic', 'decodeHeightfield: buffer does not start with the heightfield magic')
  const hlen = dv.getUint32(4, true)
  if (8 + hlen > buf.byteLength) throw new HeightfieldCodecError('heightfield-truncated', `decodeHeightfield: header of ${hlen} byte(s) runs past the ${buf.byteLength}-byte buffer`)
  const header = JSON.parse(_utf8Decode(new Uint8Array(buf, 8, hlen)))
  const { N, sectors } = header
  const gridS = sectors.gridS, bits = _assertBits(sectors.bits || 8), nSec = gridS * gridS
  const requiredBytes = 8 + hlen + 8 * nSec + (bits === 16 ? 2 : 1) * N * N
  if (buf.byteLength < requiredBytes) throw new HeightfieldCodecError('heightfield-truncated', `decodeHeightfield: ${buf.byteLength} byte(s) is short of the ${requiredBytes} the header describes`)
  let off = 8 + hlen
  const sectorMin = new Float32Array(buf, off, nSec); off += 4 * nSec
  const sectorMax = new Float32Array(buf, off, nSec); off += 4 * nSec
  const q = bits === 16 ? new Uint16Array(buf, off, N * N) : new Uint8Array(buf, off, N * N)
  return { ...header, sectors: { gridS, nodesPerSector: sectors.nodesPerSector, qmax: (1 << bits) - 1, bits }, sectorMin, sectorMax, q }
}
