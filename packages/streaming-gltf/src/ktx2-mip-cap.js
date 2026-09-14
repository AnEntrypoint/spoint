const KTX2_IDENTIFIER_BYTES = 12;
const HEADER_UINT32_FIELD_COUNT = 17;
const HEADER_LEN = KTX2_IDENTIFIER_BYTES + HEADER_UINT32_FIELD_COUNT * 4;
const LEVEL_ENTRY_UINT64_FIELD_COUNT = 3;
const LEVEL_ENTRY_LEN = LEVEL_ENTRY_UINT64_FIELD_COUNT * 8;
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

function _parseKtx2(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < HEADER_LEN) return null;
  for (let i = 0; i < KTX2_IDENTIFIER_BYTES; i++) if (bytes[i] !== KTX2_IDENTIFIER[i]) return null;
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

export function maxTexDimForDeviceTier(deviceInfoHint) {
  if (!deviceInfoHint || typeof deviceInfoHint !== 'object') return undefined;
  const { gpuTier, isMobile } = deviceInfoHint;
  if (gpuTier === 'low') return isMobile ? 64 : 128;
  if (isMobile && gpuTier !== 'medium') return 128;
  return undefined;
}

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
    return buffer;
  }
}

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
