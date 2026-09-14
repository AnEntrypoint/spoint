const HEADER_LEN = 12 + 17 * 4
const LEVEL_ENTRY_LEN = 24
const SGD_HEADER_LEN = 20
const SGD_IMAGE_DESC_LEN = 20
const KTX2_IDENTIFIER = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A]

function _readU64LE(view, offset) {
  const lo = view.getUint32(offset, true)
  const hi = view.getUint32(offset + 4, true)
  return hi * 4294967296 + lo
}

export function parseKtx2Header(buf) {
  const bytes = new Uint8Array(buf)
  if (bytes.length < HEADER_LEN) return null
  for (let i = 0; i < 12; i++) if (bytes[i] !== KTX2_IDENTIFIER[i]) return null
  const view = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength ?? buf.length)
  const vkFormat = view.getUint32(12, true)
  const typeSize = view.getUint32(16, true)
  const pixelWidth = view.getUint32(20, true)
  const pixelHeight = view.getUint32(24, true)
  const pixelDepth = view.getUint32(28, true)
  const layerCount = view.getUint32(32, true)
  const faceCount = view.getUint32(36, true)
  const levelCount = view.getUint32(40, true)
  const supercompressionScheme = view.getUint32(44, true)
  const dfdByteOffset = view.getUint32(48, true)
  const dfdByteLength = view.getUint32(52, true)
  const kvdByteOffset = view.getUint32(56, true)
  const kvdByteLength = view.getUint32(60, true)
  const sgdByteOffset = _readU64LE(view, 64)
  const sgdByteLength = _readU64LE(view, 72)
  const realLevelCount = Math.max(levelCount, 1)
  const levelIndexEnd = HEADER_LEN + realLevelCount * LEVEL_ENTRY_LEN
  if (bytes.length < levelIndexEnd) return null
  const levels = []
  for (let i = 0; i < realLevelCount; i++) {
    const off = HEADER_LEN + i * LEVEL_ENTRY_LEN
    levels.push({
      byteOffset: _readU64LE(view, off),
      byteLength: _readU64LE(view, off + 8),
      uncompressedByteLength: _readU64LE(view, off + 16),
    })
  }
  let metadataEnd = Math.max(dfdByteOffset + dfdByteLength, kvdByteOffset + kvdByteLength)
  let sgdImageDescs = null, sgdHeader = null
  const sgdEnd = sgdByteLength > 0 ? sgdByteOffset + sgdByteLength : 0
  if (sgdByteLength > 0) {
    metadataEnd = Math.max(metadataEnd, sgdByteOffset + SGD_HEADER_LEN + realLevelCount * SGD_IMAGE_DESC_LEN)
    if (bytes.length < metadataEnd) return null
    const sv = new DataView(bytes.buffer, bytes.byteOffset + sgdByteOffset, SGD_HEADER_LEN)
    sgdHeader = {
      endpointCount: sv.getUint16(0, true), selectorCount: sv.getUint16(2, true),
      endpointsByteLength: sv.getUint32(4, true), selectorsByteLength: sv.getUint32(8, true),
      tablesByteLength: sv.getUint32(12, true), extendedByteLength: sv.getUint32(16, true),
    }
    sgdImageDescs = []
    for (let i = 0; i < realLevelCount; i++) {
      const off = sgdByteOffset + SGD_HEADER_LEN + i * SGD_IMAGE_DESC_LEN
      const iv = new DataView(bytes.buffer, bytes.byteOffset + off, SGD_IMAGE_DESC_LEN)
      sgdImageDescs.push({
        imageFlags: iv.getUint32(0, true),
        rgbSliceByteOffset: iv.getUint32(4, true), rgbSliceByteLength: iv.getUint32(8, true),
        alphaSliceByteOffset: iv.getUint32(12, true), alphaSliceByteLength: iv.getUint32(16, true),
      })
    }
  } else {
    if (bytes.length < metadataEnd) return null
  }
  return {
    vkFormat, typeSize, pixelWidth, pixelHeight, pixelDepth, layerCount, faceCount,
    levelCount, supercompressionScheme, dfdByteOffset, dfdByteLength, kvdByteOffset, kvdByteLength,
    sgdByteOffset, sgdByteLength, sgdHeader, sgdImageDescs, levels,
    headerAndIndexBytes: bytes.slice(0, metadataEnd),
    totalKnownExtent: Math.max(metadataEnd, sgdEnd, ...levels.map(l => l.byteOffset + l.byteLength)),
  }
}

const PREFIX_FETCH_BYTES = 4096

async function _rangeFetch(url, start, end) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
  if (!res.ok && res.status !== 206) throw new Error(`ProgressiveKTX2: range fetch ${url} [${start}-${end}] -> HTTP ${res.status}`)
  return res.arrayBuffer()
}

export function buildPartialKtx2(header, levelBytes, includeLevelIndices) {
  const orderedIdx = includeLevelIndices.slice().sort((a, b) => a - b)
  const dfd = header.headerAndIndexBytes.slice(header.dfdByteOffset, header.dfdByteOffset + header.dfdByteLength)
  const kvd = header.headerAndIndexBytes.slice(header.kvdByteOffset, header.kvdByteOffset + header.kvdByteLength)
  const hasSgd = header.sgdByteLength > 0

  let sgd = new Uint8Array(0)
  if (hasSgd) {
    const sgdData = levelBytes.get('sgdData')
    if (!sgdData) throw new Error('buildPartialKtx2: BasisLZ container but no sgdData fetched (see _fetchSgdIfNeeded)')
    const filteredDescs = orderedIdx.map(idx => header.sgdImageDescs[idx])
    const sgdHeaderBytes = new Uint8Array(SGD_HEADER_LEN)
    const shv = new DataView(sgdHeaderBytes.buffer)
    shv.setUint16(0, header.sgdHeader.endpointCount, true)
    shv.setUint16(2, header.sgdHeader.selectorCount, true)
    shv.setUint32(4, sgdData.endpointsData.byteLength, true)
    shv.setUint32(8, sgdData.selectorsData.byteLength, true)
    shv.setUint32(12, sgdData.tablesData.byteLength, true)
    shv.setUint32(16, sgdData.extendedData.byteLength, true)
    const descBytes = new Uint8Array(filteredDescs.length * SGD_IMAGE_DESC_LEN)
    const dv2 = new DataView(descBytes.buffer)
    for (let i = 0; i < filteredDescs.length; i++) {
      const d = filteredDescs[i], off = i * SGD_IMAGE_DESC_LEN
      dv2.setUint32(off, d.imageFlags, true)
      dv2.setUint32(off + 4, d.rgbSliceByteOffset, true)
      dv2.setUint32(off + 8, d.rgbSliceByteLength, true)
      dv2.setUint32(off + 12, d.alphaSliceByteOffset, true)
      dv2.setUint32(off + 16, d.alphaSliceByteLength, true)
    }
    sgd = new Uint8Array(sgdHeaderBytes.byteLength + descBytes.byteLength + sgdData.endpointsData.byteLength + sgdData.selectorsData.byteLength + sgdData.tablesData.byteLength + sgdData.extendedData.byteLength)
    let o = 0
    sgd.set(sgdHeaderBytes, o); o += sgdHeaderBytes.byteLength
    sgd.set(descBytes, o); o += descBytes.byteLength
    sgd.set(sgdData.endpointsData, o); o += sgdData.endpointsData.byteLength
    sgd.set(sgdData.selectorsData, o); o += sgdData.selectorsData.byteLength
    sgd.set(sgdData.tablesData, o); o += sgdData.tablesData.byteLength
    sgd.set(sgdData.extendedData, o)
  }

  let cursor = HEADER_LEN + orderedIdx.length * LEVEL_ENTRY_LEN
  cursor += dfd.byteLength
  const kvdOffset = cursor
  cursor += kvd.byteLength
  const pad8 = (n) => (8 - (n % 8)) % 8
  cursor += pad8(cursor)
  const sgdOffset = cursor
  cursor += sgd.byteLength
  cursor += pad8(cursor)

  const levelOffsets = []
  const chunks = []
  for (const idx of orderedIdx) {
    const bytes = levelBytes.get(idx)
    if (!bytes) throw new Error(`buildPartialKtx2: missing fetched bytes for level ${idx}`)
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    levelOffsets.push({ offset: cursor, length: u8.byteLength })
    chunks.push(u8)
    cursor += u8.byteLength
  }
  const total = cursor
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  out.set(KTX2_IDENTIFIER, 0)
  view.setUint32(12, header.vkFormat, true)
  view.setUint32(16, header.typeSize, true)
  const sharpestIncludedLevel = orderedIdx[0]
  view.setUint32(20, Math.max(1, header.pixelWidth >> sharpestIncludedLevel), true)
  view.setUint32(24, Math.max(1, header.pixelHeight >> sharpestIncludedLevel), true)
  view.setUint32(28, header.pixelDepth ? Math.max(1, header.pixelDepth >> sharpestIncludedLevel) : 0, true)
  view.setUint32(32, header.layerCount, true)
  view.setUint32(36, header.faceCount, true)
  view.setUint32(40, orderedIdx.length, true)
  view.setUint32(44, header.supercompressionScheme, true)
  const dfdOffset = HEADER_LEN + orderedIdx.length * LEVEL_ENTRY_LEN
  view.setUint32(48, dfdOffset, true)
  view.setUint32(52, dfd.byteLength, true)
  view.setUint32(56, kvdOffset, true)
  view.setUint32(60, kvd.byteLength, true)
  const setU64 = (offset, num) => { view.setUint32(offset, num >>> 0, true); view.setUint32(offset + 4, Math.floor(num / 4294967296), true) }
  setU64(64, hasSgd ? sgdOffset : 0)
  setU64(72, hasSgd ? sgd.byteLength : 0)
  for (let i = 0; i < orderedIdx.length; i++) {
    const off = HEADER_LEN + i * LEVEL_ENTRY_LEN
    const orig = header.levels[orderedIdx[i]]
    setU64(off, levelOffsets[i].offset)
    setU64(off + 8, levelOffsets[i].length)
    setU64(off + 16, orig.uncompressedByteLength)
  }
  out.set(dfd, dfdOffset)
  out.set(kvd, kvdOffset)
  if (hasSgd) out.set(sgd, sgdOffset)
  for (let i = 0; i < chunks.length; i++) { out.set(chunks[i], levelOffsets[i].offset) }
  return out.buffer
}

export function createProgressiveKtx2Stream(url, ktx2Loader, scheduler, opts = {}) {
  const upgradeCbs = []
  let cancelled = false
  let header = null
  const levelBytes = new Map()
  const _inFlightLevelFetch = new Map()
  let _inFlightSgdFetch = null

  function onUpgrade(cb) { upgradeCbs.push(cb) }
  function cancel() { cancelled = true }

  function _levelUrl() { return url }

  async function _fetchLevel(levelIndex) {
    if (levelBytes.has(levelIndex)) return levelBytes.get(levelIndex)
    if (_inFlightLevelFetch.has(levelIndex)) return _inFlightLevelFetch.get(levelIndex)
    const lvl = header.levels[levelIndex]
    const p = _rangeFetch(_levelUrl(), lvl.byteOffset, lvl.byteOffset + lvl.byteLength - 1)
      .then(buf => { levelBytes.set(levelIndex, buf); _inFlightLevelFetch.delete(levelIndex); return buf })
      .catch(e => { _inFlightLevelFetch.delete(levelIndex); throw e })
    _inFlightLevelFetch.set(levelIndex, p)
    return p
  }

  async function _fetchSgdIfNeeded() {
    if (header.sgdByteLength <= 0) return
    if (levelBytes.has('sgdData')) return
    if (_inFlightSgdFetch) return _inFlightSgdFetch
    const h = header.sgdHeader
    const blobStart = header.sgdByteOffset + SGD_HEADER_LEN + header.levels.length * SGD_IMAGE_DESC_LEN
    const endpointsStart = blobStart
    const selectorsStart = endpointsStart + h.endpointsByteLength
    const tablesStart = selectorsStart + h.selectorsByteLength
    const extendedStart = tablesStart + h.tablesByteLength
    const blobEnd = extendedStart + h.extendedByteLength
    _inFlightSgdFetch = (async () => {
      const buf = blobEnd > blobStart ? await _rangeFetch(_levelUrl(), blobStart, blobEnd - 1) : new ArrayBuffer(0)
      const u8 = new Uint8Array(buf)
      levelBytes.set('sgdData', {
        endpointsData: u8.slice(0, h.endpointsByteLength),
        selectorsData: u8.slice(h.endpointsByteLength, h.endpointsByteLength + h.selectorsByteLength),
        tablesData: u8.slice(h.endpointsByteLength + h.selectorsByteLength, h.endpointsByteLength + h.selectorsByteLength + h.tablesByteLength),
        extendedData: u8.slice(h.endpointsByteLength + h.selectorsByteLength + h.tablesByteLength),
      })
    })()
    return _inFlightSgdFetch
  }

  async function _buildAndParse(minLevelIndex) {
    const coarsest = header.levels.length - 1
    const indices = []
    for (let i = minLevelIndex; i <= coarsest; i++) indices.push(i)
    await Promise.all(indices.map(_fetchLevel))
    await _fetchSgdIfNeeded()
    const partial = buildPartialKtx2(header, levelBytes, indices)
    return new Promise((resolve, reject) => {
      ktx2Loader.parse(partial, resolve, reject)
    })
  }

  const ready = (async () => {
    let prefixBytes = PREFIX_FETCH_BYTES
    let prefix = null
    for (let attempt = 0; attempt < 5; attempt++) {
      prefix = await _rangeFetch(url, 0, prefixBytes - 1)
      header = parseKtx2Header(prefix)
      if (header) break
      prefixBytes *= 4
    }
    if (!header) throw new Error(`ProgressiveKTX2: ${url} did not parse as a valid KTX2 header within ${prefixBytes} bytes`)
    const coarsestIndex = header.levels.length - 1
    const texture = await _buildAndParse(coarsestIndex)
    if (cancelled) return texture
    for (let lvl = coarsestIndex - 1; lvl >= 0; lvl--) {
      if (cancelled) break
      const reqId = `${url}#L${lvl}`
      scheduler.enqueue({
        id: reqId,
        kind: 'textureMip',
        features: opts.features || {},
        run: () => {
          if (cancelled) return
          _buildAndParse(lvl).then(tex => {
            if (cancelled) return
            for (const cb of upgradeCbs) { try { cb(tex, lvl) } catch (_) {} }
          }).catch(() => {})
        },
      })
    }
    return texture
  })()

  return { ready, onUpgrade, cancel, get header() { return header } }
}
