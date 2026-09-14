const GRID_RESOLUTIONS_FINEST_FIRST = [48, 24, 12, 8, 6, 4, 2];
const COMPONENT_GETTERS = ['getX', 'getY', 'getZ', 'getW'];

function sequentialIndex(count) {
  const seq = new Uint32Array(count);
  for (let i = 0; i < count; i++) seq[i] = i;
  return seq;
}

function boundsOf(pos) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (x < b[0]) b[0] = x; if (x > b[3]) b[3] = x;
    if (y < b[1]) b[1] = y; if (y > b[4]) b[4] = y;
    if (z < b[2]) b[2] = z; if (z > b[5]) b[5] = z;
  }
  return b;
}

function clusterVertices(pos, b, res) {
  const sx = (b[3] - b[0]) || 1, sy = (b[4] - b[1]) || 1, sz = (b[5] - b[2]) || 1;
  const cellOfVertex = new Int32Array(pos.count);
  const cellIds = new Map();
  for (let i = 0; i < pos.count; i++) {
    const gx = Math.min(res - 1, ((pos.getX(i) - b[0]) / sx * res) | 0);
    const gy = Math.min(res - 1, ((pos.getY(i) - b[1]) / sy * res) | 0);
    const gz = Math.min(res - 1, ((pos.getZ(i) - b[2]) / sz * res) | 0);
    const key = (gx * res + gy) * res + gz;
    let cell = cellIds.get(key);
    if (cell === undefined) { cell = cellIds.size; cellIds.set(key, cell); }
    cellOfVertex[i] = cell;
  }
  return { cellOfVertex, cellCount: cellIds.size };
}

function uniqueCellTriangles(index, cellOfVertex, cellCount) {
  const out = [];
  const seen = new Set();
  for (let t = 0; t + 2 < index.length; t += 3) {
    let a = cellOfVertex[index[t]], b = cellOfVertex[index[t + 1]], c = cellOfVertex[index[t + 2]];
    if (a === b || b === c || a === c) continue;
    if (b < a && b < c) { const s = a; a = b; b = c; c = s; } else if (c < a && c < b) { const s = c; c = b; b = a; a = s; }
    const key = (a * cellCount + b) * cellCount + c;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a, b, c);
  }
  return out;
}

function representativeAttributes(attributes, cellOfVertex, cellCount) {
  const repOfCell = new Int32Array(cellCount).fill(-1);
  for (let i = 0; i < cellOfVertex.length; i++) if (repOfCell[cellOfVertex[i]] === -1) repOfCell[cellOfVertex[i]] = i;
  const rebuilt = {};
  for (const name of Object.keys(attributes)) {
    const attr = attributes[name];
    const itemSize = attr.itemSize;
    const array = new Float32Array(cellCount * itemSize);
    for (let cell = 0; cell < cellCount; cell++) {
      const src = repOfCell[cell];
      for (let k = 0; k < itemSize; k++) array[cell * itemSize + k] = attr[COMPONENT_GETTERS[k]](src);
    }
    rebuilt[name] = { array, itemSize };
  }
  return rebuilt;
}

export function gridDecimate(attributes, index, triCap) {
  const pos = attributes.position;
  if (!pos || pos.count === 0) return null;
  const idx = index || sequentialIndex(pos.count);
  if (idx.length / 3 <= triCap) return null;
  const b = boundsOf(pos);
  const last = GRID_RESOLUTIONS_FINEST_FIRST.length - 1;
  for (let r = 0; r <= last; r++) {
    const res = GRID_RESOLUTIONS_FINEST_FIRST[r];
    const { cellOfVertex, cellCount } = clusterVertices(pos, b, res);
    const tris = uniqueCellTriangles(idx, cellOfVertex, cellCount);
    if (tris.length / 3 > triCap && r < last) continue;
    if (tris.length === 0) return null;
    return {
      resolution: res,
      attributes: representativeAttributes(attributes, cellOfVertex, cellCount),
      index: cellCount > 65535 ? new Uint32Array(tris) : new Uint16Array(tris),
    };
  }
  return null;
}

export function applyGridDecimate(geometry, triCap, BufferAttribute) {
  const decimated = gridDecimate(geometry.attributes, geometry.index ? geometry.index.array : null, triCap);
  if (!decimated) return null;
  for (const name of Object.keys(decimated.attributes)) {
    const { array, itemSize } = decimated.attributes[name];
    geometry.setAttribute(name, new BufferAttribute(array, itemSize, false));
  }
  geometry.setIndex(new BufferAttribute(decimated.index, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return decimated.resolution;
}
