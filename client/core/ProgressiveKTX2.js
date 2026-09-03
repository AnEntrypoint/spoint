// ProgressiveKTX2 -- streams a KTX2 texture's mip levels lowest-resolution-first via real HTTP Range
// requests, matching mesh LOD tiers, feeding client/core/StreamingScheduler.js for higher-mip fetch
// ordering (distance/screen-size/frustum/gameplay-boost scoring, the SAME priority model mesh LOD
// warm-loads use -- see StreamingScheduler.js's own top comment). Consumes the server-side
// src/static/KTX2Extract.js + src/sdk/StaticHandler.js `<glb>.glb.ktx2/<imageIndex>.ktx2` virtual
// route, which is Range-enabled (StaticHandler's RANGE_EXTENSIONS now includes .ktx2).
//
// Real KTX2 container layout (khronos KTX File Format 2.0, same structure ktx-parse's `read()` --
// vendored at node_modules/three/examples/jsm/libs/ktx-parse.module.js -- decodes):
//   [0..12)   12-byte identifier: AB 4B 54 58 20 32 30 BB 0D 0A 1A 0A ("«KTX 20»\r\n\x1A\n")
//   [12..80)  17 x uint32 LE header fields (vkFormat, typeSize, pixelWidth, pixelHeight, pixelDepth,
//             layerCount, faceCount, levelCount, supercompressionScheme, dfdByteOffset, dfdByteLength,
//             kvdByteOffset, kvdByteLength, then 2x uint64 sgdByteOffset/sgdByteLength)
//   [80..)    level index: max(levelCount,1) entries x 24 bytes each, LE:
//               uint64 byteOffset, uint64 byteLength, uint64 uncompressedByteLength
// Level 0 is the FULL-resolution mip; levelCount-1 is the smallest/lowest-res mip (standard KTX2
// level ordering, confirmed against ktx-parse's own read() which pushes levels in file order and
// three's KTX2Loader which derives levelWidth/Height as pixelWidth/Height >> levelIndex). So "low-mip
// first" here means fetching the HIGHEST level index first (smallest dimensions, smallest byte range),
// then progressively fetching lower level indices (bigger, sharper) as scheduler priority allows.
//
// A minimal-but-valid KTX2 buffer containing only a SUBSET of levels (always including the coarsest
// levels, extended toward level 0 as more arrive) is reconstructed and handed to the SAME
// THREE.KTX2Loader.parse() the whole-file path already uses -- so transcoding/format-selection/
// worker-pool logic is reused byte-for-byte, not reimplemented; only the container's level index +
// level-count header field are rewritten to describe the subset actually present.

const HEADER_LEN = 12 + 17 * 4 // identifier + 17 uint32 fields = 80
const LEVEL_ENTRY_LEN = 24     // 3x uint64
const KTX2_IDENTIFIER = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A]

function _readU64LE(view, offset) {
  // JS numbers are exact integers up to 2^53; texture files are always far below that, so plain
  // Number math (not BigInt) is correct and keeps every call site downstream (Math.min/max, slicing)
  // free of BigInt/Number interop friction.
  const lo = view.getUint32(offset, true)
  const hi = view.getUint32(offset + 4, true)
  return hi * 4294967296 + lo
}

// Parses just the identifier + header + level index from a buffer covering AT LEAST the first
// `HEADER_LEN + max(levelCount,1)*LEVEL_ENTRY_LEN` bytes (the caller fetches a generously-sized
// prefix via Range so this never has to guess levelCount before it can read it -- see
// PREFIX_FETCH_BYTES below). Returns null if the buffer doesn't start with a real KTX2 identifier.
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
  if (bytes.length < levelIndexEnd) return null // caller's prefix fetch was too small for this file's real levelCount
  const levels = []
  for (let i = 0; i < realLevelCount; i++) {
    const off = HEADER_LEN + i * LEVEL_ENTRY_LEN
    levels.push({
      byteOffset: _readU64LE(view, off),
      byteLength: _readU64LE(view, off + 8),
      uncompressedByteLength: _readU64LE(view, off + 16),
    })
  }
  // DFD + KVD (both metadata, never touched by mip-level fetches) must ALSO be inside the fetched
  // prefix -- they sit right after the level index and are needed verbatim to reconstruct any valid
  // partial file (see buildPartialKtx2). If the prefix was too small to cover them, treat this like
  // any other too-small-prefix case (null) rather than silently truncating dfd/kvd to empty, which
  // produced a real corrupt-partial-file bug caught by this module's own round-trip verification
  // (ktx-parse's reader threw "Offset is outside the bounds of the DataView" on the truncated DFD).
  let metadataEnd = Math.max(dfdByteOffset + dfdByteLength, kvdByteOffset + kvdByteLength)
  // Supercompression Global Data (BasisLZ only, supercompressionScheme===1): a fixed 20-byte header
  // (endpointCount u16, selectorCount u16, endpointsByteLength/selectorsByteLength/tablesByteLength/
  // extendedByteLength u32 each) followed by levelCount x 20-byte imageDesc entries (imageFlags,
  // rgbSliceByteOffset, rgbSliceByteLength, alphaSliceByteOffset, alphaSliceByteLength, all u32) --
  // MUST be parsed here (not just size-checked) because a partial/subset reconstruction needs to filter
  // imageDescs down to only the levels actually included (see buildPartialKtx2's SGD rewrite below); the
  // basis transcoder looks up imageDescs BY NEW LEVEL INDEX, so carrying the full original array through
  // unfiltered points every included level at the WRONG slice's endpoint/selector data.
  let sgdImageDescs = null, sgdHeader = null
  const sgdEnd = sgdByteLength > 0 ? sgdByteOffset + sgdByteLength : 0
  if (sgdByteLength > 0) {
    metadataEnd = Math.max(metadataEnd, sgdByteOffset + 20 + realLevelCount * 20) // need at least the imageDescs to be in-prefix
    if (bytes.length < metadataEnd) return null
    const sv = new DataView(bytes.buffer, bytes.byteOffset + sgdByteOffset, 20)
    sgdHeader = {
      endpointCount: sv.getUint16(0, true), selectorCount: sv.getUint16(2, true),
      endpointsByteLength: sv.getUint32(4, true), selectorsByteLength: sv.getUint32(8, true),
      tablesByteLength: sv.getUint32(12, true), extendedByteLength: sv.getUint32(16, true),
    }
    sgdImageDescs = []
    for (let i = 0; i < realLevelCount; i++) {
      const off = sgdByteOffset + 20 + i * 20
      const iv = new DataView(bytes.buffer, bytes.byteOffset + off, 20)
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
    // real span this container occupies, needed to size the eventual full fetch / clamp ranges
    totalKnownExtent: Math.max(metadataEnd, sgdEnd, ...levels.map(l => l.byteOffset + l.byteLength)),
  }
}

// Generous enough to cover identifier+header+level-index for any realistic levelCount (mip chains
// rarely exceed ~14 levels for a 8K texture -> 80 + 14*24 = 416 bytes) plus DFD+a modest KVD, without
// being large enough to defeat the point of a "fetch the small part first" range request.
const PREFIX_FETCH_BYTES = 4096

async function _rangeFetch(url, start, end) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
  if (!res.ok && res.status !== 206) throw new Error(`ProgressiveKTX2: range fetch ${url} [${start}-${end}] -> HTTP ${res.status}`)
  return res.arrayBuffer()
}

// Reconstructs a minimal, valid, standalone KTX2 buffer containing exactly the given subset of levels
// (by level index), suitable for THREE.KTX2Loader.parse(). `levelBytes` is a Map<levelIndex,
// ArrayBuffer|Uint8Array> of already-fetched level payloads (plus 'sgdData' -> the fetched
// endpoints+selectors+tables+extended blob, see _fetchSgdIfNeeded). `header` is the parseKtx2Header()
// result. `includeLevelIndices` MUST be a contiguous run (e.g. [minLevel..coarsest]) -- see the
// pixelWidth/Height rewrite below for why a non-contiguous subset would be wrong.
//
// Layout mirrors a real KTX2 writer (matches ktx-parse's own `write()` byte order): identifier, header,
// level index, DFD, KVD, [supercompression global data, if BasisLZ], then level data payloads in file
// order (ascending offset, matching three's KTX2Loader/ktx-parse expectations).
//
// TWO non-obvious rewrites are required for the transcoder to accept a level SUBSET as valid, both
// found via a real live browser failure ("Cannot read properties of undefined (reading 'faces')" /
// "THREE.KTX2Loader: .startTranscoding failed") that a byte-level round-trip test alone did not catch
// (ktx-parse's reader only checks the container SHAPE parses, not that the transcoder can decode the
// slice data it points to):
//   1. pixelWidth/pixelHeight: three's KTX2Loader worker derives each level's dimensions purely as
//      `pixelWidth >> levelIndex` / `pixelHeight >> levelIndex` (node_modules/three/examples/jsm/
//      loaders/KTX2Loader.js's BasisWorker, NOT from any per-level dimension field in the file) -- so a
//      subset starting at, say, original level 6 of a 256x256 texture, if it keeps pixelWidth=256, would
//      have the transcoder compute levelWidth=256>>0=256 for level-index-0 of the NEW file, when the
//      actual bytes at that level are the 4x4 (256>>6) coarsest mip. The rewritten pixelWidth/Height
//      must be the ORIGINAL dimensions shifted by the subset's sharpest included level (orderedIdx[0]),
//      i.e. what a real standalone single-level KTX2 of that mip's actual size would declare -- this
//      only produces correct per-level math for i>0 when includeLevelIndices is a contiguous run
//      starting at orderedIdx[0], which _buildAndParse always constructs.
//   2. BasisLZ Supercompression Global Data (supercompressionScheme===1) carries one imageDesc entry
//      PER LEVEL (by array index) that the transcoder looks up via the NEW (post-subset) level index --
//      carrying the ORIGINAL full imageDescs array through unfiltered points every included level at the
//      wrong slice (e.g. new level 0 would read old level 0's imageDesc, which describes an entirely
//      different, unfetched level's endpoint/selector slice). Fixed by filtering imageDescs down to
//      exactly the included original indices, in order, while keeping the shared endpoints/selectors/
//      tables/extended DATA BLOBS byte-identical (those are shared across all levels and addressed by
//      byte offset within the blob, not by level index, so they never need subsetting).
export function buildPartialKtx2(header, levelBytes, includeLevelIndices) {
  const orderedIdx = includeLevelIndices.slice().sort((a, b) => a - b)
  const dfd = header.headerAndIndexBytes.slice(header.dfdByteOffset, header.dfdByteOffset + header.dfdByteLength)
  const kvd = header.headerAndIndexBytes.slice(header.kvdByteOffset, header.kvdByteOffset + header.kvdByteLength)
  const hasSgd = header.sgdByteLength > 0

  let sgd = new Uint8Array(0)
  if (hasSgd) {
    const sgdData = levelBytes.get('sgdData') // { endpointsData, selectorsData, tablesData, extendedData } Uint8Arrays
    if (!sgdData) throw new Error('buildPartialKtx2: BasisLZ container but no sgdData fetched (see _fetchSgdIfNeeded)')
    const filteredDescs = orderedIdx.map(idx => header.sgdImageDescs[idx])
    const sgdHeaderBytes = new Uint8Array(20)
    const shv = new DataView(sgdHeaderBytes.buffer)
    shv.setUint16(0, header.sgdHeader.endpointCount, true)
    shv.setUint16(2, header.sgdHeader.selectorCount, true)
    shv.setUint32(4, sgdData.endpointsData.byteLength, true)
    shv.setUint32(8, sgdData.selectorsData.byteLength, true)
    shv.setUint32(12, sgdData.tablesData.byteLength, true)
    shv.setUint32(16, sgdData.extendedData.byteLength, true)
    const descBytes = new Uint8Array(filteredDescs.length * 20)
    const dv2 = new DataView(descBytes.buffer)
    for (let i = 0; i < filteredDescs.length; i++) {
      const d = filteredDescs[i], off = i * 20
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
  // pad to 8 before sgd/level data, matching the real writer's alignment (Levels are additionally
  // padded per-level in a real writer for supercompressionScheme===0 texel-block alignment; since this
  // reconstruction always carries pre-encoded already-block-aligned level payloads straight from the
  // original file, no extra inter-level padding is needed beyond the base 8-byte alignment KTX2 requires
  // before the level-data region).
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
  // See top-of-function comment (1): rewritten to the SHARPEST included level's real dimensions, not
  // the original full-res dimensions, so the transcoder's pixelWidth>>levelIndex math lines up.
  const shift = orderedIdx[0]
  view.setUint32(20, Math.max(1, header.pixelWidth >> shift), true)
  view.setUint32(24, Math.max(1, header.pixelHeight >> shift), true)
  view.setUint32(28, header.pixelDepth ? Math.max(1, header.pixelDepth >> shift) : 0, true)
  view.setUint32(32, header.layerCount, true)
  view.setUint32(36, header.faceCount, true)
  view.setUint32(40, orderedIdx.length, true) // levelCount rewritten to the actually-present subset
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

// createProgressiveKtx2Stream(url, ktx2Loader, scheduler, opts) -> {
//   ready: Promise<CompressedTexture>  resolves as soon as the LOWEST mip is transcoded+displayable
//   onUpgrade(cb)                      cb(texture, levelIndex) fires each time a sharper mip swaps in
//   cancel()                           aborts any not-yet-dispatched higher-mip fetches
// }
// features: the SAME {distance, screenSize, inFrustum, gameplayBoost} shape StreamingScheduler.
// scoreRequest already accepts, passed straight through to scheduler.enqueue per higher-mip request --
// so a caller re-scores by calling this again with the same `id` semantics scheduler.enqueue already
// defines (idempotent re-want), no bespoke priority logic here.
export function createProgressiveKtx2Stream(url, ktx2Loader, scheduler, opts = {}) {
  const upgradeCbs = []
  let cancelled = false
  let header = null
  const levelBytes = new Map()
  const _inFlightLevelFetch = new Map() // levelIndex -> Promise, de-dupes concurrent _buildAndParse calls
  let _inFlightSgdFetch = null          // same de-dupe for the single shared SGD blob fetch

  function onUpgrade(cb) { upgradeCbs.push(cb) }
  function cancel() { cancelled = true }

  function _levelUrl() { return url }

  // De-duped: consecutive scheduler drains can dispatch _buildAndParse for adjacent levels before the
  // FIRST call's range fetches have resolved (drain() only bounds by time/count, not by "wait for the
  // previous dispatch's async work") -- without de-duping, every already-requested-but-not-yet-resolved
  // level got a SECOND real network request for the identical byte range, live-witnessed as duplicate
  // Range headers in a real browser network log (e.g. "bytes=4755-4758" appearing 5 times for one
  // texture). Caching the in-flight PROMISE (not just the resolved bytes) closes that window.
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

  // Fetches the SGD's shared endpoints+selectors+tables+extended data blobs (the imageDescs themselves
  // are already parsed from the header prefix -- see parseKtx2Header -- since they're small and fixed
  // per-level; only the potentially-large shared data blobs need a real range fetch). These 4 blobs
  // are addressed by BYTE OFFSET from the start of the endpoints blob (per the KTX2/BasisLZ spec each
  // imageDesc's rgbSliceByteOffset/alphaSliceByteOffset is relative to this same region), computed the
  // same way ktx-parse's own reader lays them out: endpoints, then selectors, then tables, then extended,
  // contiguously starting right after the imageDescs array.
  async function _fetchSgdIfNeeded() {
    if (header.sgdByteLength <= 0) return
    if (levelBytes.has('sgdData')) return
    if (_inFlightSgdFetch) return _inFlightSgdFetch
    const h = header.sgdHeader
    const blobStart = header.sgdByteOffset + 20 + header.levels.length * 20
    const endpointsStart = blobStart
    const selectorsStart = endpointsStart + h.endpointsByteLength
    const tablesStart = selectorsStart + h.selectorsByteLength
    const extendedStart = tablesStart + h.tablesByteLength
    const blobEnd = extendedStart + h.extendedByteLength
    // one range request for the whole contiguous blob region (cheaper than 4 separate small fetches;
    // these blobs are shared across every level so this is paid once per texture, not once per mip --
    // in-flight-promise-cached the same way _fetchLevel is, for the same concurrent-drain reason).
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

  // Builds+parses a real CompressedTexture from every level index in [minLevelIndex..coarsestIndex]
  // (i.e. "this sharpness and everything coarser") -- KTX2/basis transcode expects a contiguous mip
  // chain from generateMipmaps' perspective, so a subset must always include the full coarse tail, not
  // an arbitrary single level.
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
    // Grow-and-retry: PREFIX_FETCH_BYTES covers the overwhelming common case (small level index + a
    // modest DFD/KVD), but a texture with an unusually large KVD (custom metadata) or many mip levels
    // could need more -- rather than hand-tune a bigger constant defensively, double the prefix and
    // re-fetch (still a small request relative to a full mip) until parseKtx2Header's own real
    // bounds-check (see its metadataEnd guard) is satisfied, capped so a malformed/non-KTX2 file fails
    // fast instead of spiraling toward a whole-file fetch.
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
    const texture = await _buildAndParse(coarsestIndex) // lowest-res mip only, displayable immediately
    if (cancelled) return texture
    // Enqueue every remaining sharper level (coarsestIndex-1 .. 0) onto the shared scheduler, one
    // request per level, scored by the SAME real distance/screenSize/frustum/gameplayBoost features a
    // mesh LOD warm-load would use -- lower level index (sharper/bigger) naturally costs a slightly
    // higher score via a tiny per-level tiebreak added to gameplayBoost's inverse so among otherwise-
    // identical requests the coarser upgrade (smaller fetch, faster visible improvement) still tends to
    // dispatch first, without needing a second priority axis.
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
          }).catch(() => {}) // a failed higher-mip fetch just leaves the current (coarser) texture displayed
        },
      })
    }
    return texture
  })()

  return { ready, onUpgrade, cancel, get header() { return header } }
}
