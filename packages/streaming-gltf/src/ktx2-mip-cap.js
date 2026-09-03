// Device-tier max-texture-resolution policy for baked KTX2/BASIS textures.
//
// ktx2-device-tier-texture-resolution-policy: scripts/glb-processor.js's MAX_TEX=256 and
// src/static/GLBKtx2.js's imageToKtx2 both downscale every source texture to ONE static 256px
// ceiling before the KTX2 bake -- with `--generate-mipmap` (see GLBKtx2.js) that still produces a
// REAL multi-level mip chain (256 -> 128 -> 64 -> ... -> 1px, levelCount=9), the same single baked
// GLB is served to every client regardless of device tier. A high-tier desktop and a low-tier
// mobile phone both currently receive (and three's stock KTX2Loader.parse() both TRANSCODE +
// UPLOAD) the full level-0 256x256 mip, wasting low-tier GPU fill-rate/VRAM/transcode-CPU on
// resolution that tier can't usefully spend (mirrors the already-shipped anisotropy device-tier
// cap right below this module's sibling, _capAnisotropyByDeviceTier).
//
// Fix = client-side mip-selection policy (per the PRD row's option (a)): before handing a KTX2
// buffer to KTX2Loader.parse(), strip the N highest-resolution leading levels the device tier is
// not entitled to, so the transcoder only ever touches the levels a low-tier device should
// actually receive. Zero server/bake changes, zero new HTTP requests (this operates on the KTX2
// buffer already embedded in / already fetched with the GLB -- unlike client/core/ProgressiveKTX2.js's
// range-fetch streaming, which is a different, currently-unwired mechanism for a genuinely separate
// texture-LOD tier system). Byte-level container surgery mirrors ProgressiveKTX2.js's
// parseKtx2Header/buildPartialKtx2 (same KTX2 2.0 format, same two non-obvious rewrites needed for
// the transcoder to accept a level subset: pixelWidth/Height shifted to the sharpest kept level,
// and BasisLZ Supercompression Global Data imageDescs filtered to the kept level indices) --
// reimplemented here rather than imported cross-package since streaming-gltf is a standalone
// published package that must not depend on client/core/*.

const HEADER_LEN = 12 + 17 * 4; // identifier + 17 uint32 fields = 80
const LEVEL_ENTRY_LEN = 24;     // 3x uint64
const KTX2_IDENTIFIER = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];

function _readU64LE(view, offset) {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  return hi * 4294967296 + lo;
}

function _setU64LE(view, offset, num) {
  view.setUint32(offset, num >>> 0, true);
  view.setUint32(offset + 4, Math.floor(num / 4294967296), true);
}

// Minimal KTX2 header+level-index+DFD/KVD/SGD-imageDesc parse -- same shape as
// client/core/ProgressiveKTX2.js's parseKtx2Header but operating on an already-complete in-memory
// buffer (no prefix-fetch grow-and-retry needed; the whole file is already present).
function _parseKtx2(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < HEADER_LEN) return null;
  for (let i = 0; i < 12; i++) if (bytes[i] !== KTX2_IDENTIFIER[i]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vkFormat = view.getUint32(12, true);
  const typeSize = view.getUint32(16, true);
  const pixelWidth = view.getUint32(20, true);
  const pixelHeight = view.getUint32(24, true);
  const pixelDepth = view.getUint32(28, true);
  const layerCount = view.getUint32(32, true);
  const faceCount = view.getUint32(36, true);
  const levelCount = view.getUint32(40, true);
  const supercompressionScheme = view.getUint32(44, true);
  const dfdByteOffset = view.getUint32(48, true);
  const dfdByteLength = view.getUint32(52, true);
  const kvdByteOffset = view.getUint32(56, true);
  const kvdByteLength = view.getUint32(60, true);
  const sgdByteOffset = _readU64LE(view, 64);
  const sgdByteLength = _readU64LE(view, 72);
  const realLevelCount = Math.max(levelCount, 1);
  const levelIndexEnd = HEADER_LEN + realLevelCount * LEVEL_ENTRY_LEN;
  if (bytes.length < levelIndexEnd) return null;
  const levels = [];
  for (let i = 0; i < realLevelCount; i++) {
    const off = HEADER_LEN + i * LEVEL_ENTRY_LEN;
    levels.push({
      byteOffset: _readU64LE(view, off),
      byteLength: _readU64LE(view, off + 8),
      uncompressedByteLength: _readU64LE(view, off + 16),
    });
  }
  let sgdImageDescs = null, sgdHeader = null;
  if (sgdByteLength > 0) {
    const sv = new DataView(bytes.buffer, bytes.byteOffset + sgdByteOffset, 20);
    sgdHeader = {
      endpointCount: sv.getUint16(0, true), selectorCount: sv.getUint16(2, true),
      endpointsByteLength: sv.getUint32(4, true), selectorsByteLength: sv.getUint32(8, true),
      tablesByteLength: sv.getUint32(12, true), extendedByteLength: sv.getUint32(16, true),
    };
    sgdImageDescs = [];
    for (let i = 0; i < realLevelCount; i++) {
      const off = sgdByteOffset + 20 + i * 20;
      const iv = new DataView(bytes.buffer, bytes.byteOffset + off, 20);
      sgdImageDescs.push({
        imageFlags: iv.getUint32(0, true),
        rgbSliceByteOffset: iv.getUint32(4, true), rgbSliceByteLength: iv.getUint32(8, true),
        alphaSliceByteOffset: iv.getUint32(12, true), alphaSliceByteLength: iv.getUint32(16, true),
      });
    }
  }
  return {
    bytes, vkFormat, typeSize, pixelWidth, pixelHeight, pixelDepth, layerCount, faceCount,
    levelCount: realLevelCount, supercompressionScheme, dfdByteOffset, dfdByteLength,
    kvdByteOffset, kvdByteLength, sgdByteOffset, sgdByteLength, sgdHeader, sgdImageDescs, levels,
  };
}

// Rebuilds a minimal valid KTX2 buffer containing only levels [startLevel..levelCount-1] (dropping
// the `startLevel` sharpest/largest leading levels), matching client/core/ProgressiveKTX2.js's
// buildPartialKtx2 byte layout + the same two required rewrites (pixelWidth/Height shifted by
// startLevel so the transcoder's `pixelWidth >> levelIndex` math lines up; BasisLZ SGD imageDescs
// filtered to the kept indices).
function _stripLeadingLevels(header, startLevel) {
  const orderedIdx = [];
  for (let i = startLevel; i < header.levels.length; i++) orderedIdx.push(i);

  const dfd = header.bytes.slice(header.dfdByteOffset, header.dfdByteOffset + header.dfdByteLength);
  const kvd = header.bytes.slice(header.kvdByteOffset, header.kvdByteOffset + header.kvdByteLength);
  const hasSgd = header.sgdByteLength > 0;

  let sgd = new Uint8Array(0);
  if (hasSgd) {
    const blobStart = header.sgdByteOffset + 20 + header.levels.length * 20;
    const h = header.sgdHeader;
    const endpointsData = header.bytes.slice(blobStart, blobStart + h.endpointsByteLength);
    const selectorsStart = blobStart + h.endpointsByteLength;
    const selectorsData = header.bytes.slice(selectorsStart, selectorsStart + h.selectorsByteLength);
    const tablesStart = selectorsStart + h.selectorsByteLength;
    const tablesData = header.bytes.slice(tablesStart, tablesStart + h.tablesByteLength);
    const extendedStart = tablesStart + h.tablesByteLength;
    const extendedData = header.bytes.slice(extendedStart, extendedStart + h.extendedByteLength);

    const filteredDescs = orderedIdx.map((idx) => header.sgdImageDescs[idx]);
    const sgdHeaderBytes = new Uint8Array(20);
    const shv = new DataView(sgdHeaderBytes.buffer);
    shv.setUint16(0, h.endpointCount, true);
    shv.setUint16(2, h.selectorCount, true);
    shv.setUint32(4, endpointsData.byteLength, true);
    shv.setUint32(8, selectorsData.byteLength, true);
    shv.setUint32(12, tablesData.byteLength, true);
    shv.setUint32(16, extendedData.byteLength, true);
    const descBytes = new Uint8Array(filteredDescs.length * 20);
    const dv2 = new DataView(descBytes.buffer);
    for (let i = 0; i < filteredDescs.length; i++) {
      const d = filteredDescs[i], off = i * 20;
      dv2.setUint32(off, d.imageFlags, true);
      dv2.setUint32(off + 4, d.rgbSliceByteOffset, true);
      dv2.setUint32(off + 8, d.rgbSliceByteLength, true);
      dv2.setUint32(off + 12, d.alphaSliceByteOffset, true);
      dv2.setUint32(off + 16, d.alphaSliceByteLength, true);
    }
    sgd = new Uint8Array(sgdHeaderBytes.byteLength + descBytes.byteLength + endpointsData.byteLength + selectorsData.byteLength + tablesData.byteLength + extendedData.byteLength);
    let o = 0;
    sgd.set(sgdHeaderBytes, o); o += sgdHeaderBytes.byteLength;
    sgd.set(descBytes, o); o += descBytes.byteLength;
    sgd.set(endpointsData, o); o += endpointsData.byteLength;
    sgd.set(selectorsData, o); o += selectorsData.byteLength;
    sgd.set(tablesData, o); o += tablesData.byteLength;
    sgd.set(extendedData, o);
  }

  let cursor = HEADER_LEN + orderedIdx.length * LEVEL_ENTRY_LEN;
  cursor += dfd.byteLength;
  const kvdOffset = cursor;
  cursor += kvd.byteLength;
  const pad8 = (n) => (8 - (n % 8)) % 8;
  cursor += pad8(cursor);
  const sgdOffset = cursor;
  cursor += sgd.byteLength;
  cursor += pad8(cursor);

  const levelOffsets = [];
  const chunks = [];
  for (const idx of orderedIdx) {
    const lvl = header.levels[idx];
    const u8 = header.bytes.slice(lvl.byteOffset, lvl.byteOffset + lvl.byteLength);
    levelOffsets.push({ offset: cursor, length: u8.byteLength });
    chunks.push(u8);
    cursor += u8.byteLength;
  }
  const total = cursor;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(KTX2_IDENTIFIER, 0);
  view.setUint32(12, header.vkFormat, true);
  view.setUint32(16, header.typeSize, true);
  view.setUint32(20, Math.max(1, header.pixelWidth >> startLevel), true);
  view.setUint32(24, Math.max(1, header.pixelHeight >> startLevel), true);
  view.setUint32(28, header.pixelDepth ? Math.max(1, header.pixelDepth >> startLevel) : 0, true);
  view.setUint32(32, header.layerCount, true);
  view.setUint32(36, header.faceCount, true);
  view.setUint32(40, orderedIdx.length, true);
  view.setUint32(44, header.supercompressionScheme, true);
  const dfdOffset = HEADER_LEN + orderedIdx.length * LEVEL_ENTRY_LEN;
  view.setUint32(48, dfdOffset, true);
  view.setUint32(52, dfd.byteLength, true);
  view.setUint32(56, kvdOffset, true);
  view.setUint32(60, kvd.byteLength, true);
  _setU64LE(view, 64, hasSgd ? sgdOffset : 0);
  _setU64LE(view, 72, hasSgd ? sgd.byteLength : 0);
  for (let i = 0; i < orderedIdx.length; i++) {
    const off = HEADER_LEN + i * LEVEL_ENTRY_LEN;
    const orig = header.levels[orderedIdx[i]];
    _setU64LE(view, off, levelOffsets[i].offset);
    _setU64LE(view, off + 8, levelOffsets[i].length);
    _setU64LE(view, off + 16, orig.uncompressedByteLength);
  }
  out.set(dfd, dfdOffset);
  out.set(kvd, kvdOffset);
  if (hasSgd) out.set(sgd, sgdOffset);
  for (let i = 0; i < chunks.length; i++) out.set(chunks[i], levelOffsets[i].offset);
  return out.buffer;
}

// Device-tier -> max texture DIMENSION policy (mirrors _capAnisotropyByDeviceTier's tier bands).
// Same deviceInfo shape as client/core/MobileControls.js's detectDevice(): { gpuTier: 'low'|
// 'medium'|'unknown', isMobile, memoryMB }. No hint -> no cap (undefined = unlimited, identity
// behavior for every existing no-deviceInfo caller).
export function maxTexDimForDeviceTier(deviceInfoHint) {
  if (!deviceInfoHint || typeof deviceInfoHint !== 'object') return undefined;
  const { gpuTier, isMobile } = deviceInfoHint;
  if (gpuTier === 'low') return isMobile ? 64 : 128;
  if (isMobile && gpuTier !== 'medium') return 128;
  return undefined;
}

// Strips the N highest-resolution leading mip levels from a KTX2 buffer so its largest remaining
// level's width/height is <= maxDim (always keeps at least the single coarsest level). Returns the
// ORIGINAL buffer unchanged (identity) when maxDim is falsy, the buffer isn't a valid/parseable
// KTX2 container, there's only one level, or the top level already fits -- so this is always a
// safe no-op wrapper, never a hard requirement the buffer be KTX2.
export function capKtx2Levels(buffer, maxDim) {
  if (!maxDim) return buffer;
  const header = _parseKtx2(buffer);
  if (!header || header.levels.length <= 1) return buffer;
  if (header.pixelWidth <= maxDim && header.pixelHeight <= maxDim) return buffer;
  let startLevel = 0;
  while (
    startLevel < header.levels.length - 1 &&
    (Math.max(1, header.pixelWidth >> startLevel) > maxDim || Math.max(1, header.pixelHeight >> startLevel) > maxDim)
  ) startLevel++;
  if (startLevel === 0) return buffer;
  try {
    return _stripLeadingLevels(header, startLevel);
  } catch {
    // Any surgery failure (malformed SGD, truncated level data, etc.) falls back to the untouched
    // original buffer -- correctness (full-res upload) over the resolution-budget optimization.
    return buffer;
  }
}

// Wraps a THREE.KTX2Loader instance's .parse so every transcode is preceded by the device-tier mip
// cap above. Idempotent (checks a marker before re-wrapping) so it's safe to call once per pool
// construction even though the loader itself is a module-level singleton shared across pools.
export function applyKtx2DeviceTierCap(ktx2Loader, deviceInfoHint) {
  if (!ktx2Loader || ktx2Loader._deviceTierCapApplied) return ktx2Loader;
  const maxDim = maxTexDimForDeviceTier(deviceInfoHint);
  const originalParse = ktx2Loader.parse.bind(ktx2Loader);
  ktx2Loader.parse = function (buffer, onLoad, onError) {
    const capped = maxDim ? capKtx2Levels(buffer, maxDim) : buffer;
    return originalParse(capped, onLoad, onError);
  };
  ktx2Loader._deviceTierCapApplied = true;
  ktx2Loader._deviceTierMaxDim = maxDim;
  return ktx2Loader;
}
