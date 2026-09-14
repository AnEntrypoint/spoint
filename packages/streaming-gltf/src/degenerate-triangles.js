export const EPS_AREA = 1e-4;
export const FAN_EDGE_MAX_CLUSTER_DIAGONALS = 3;

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const _w = new Float64Array(9);

function transformInto(o, pos, v, m) {
  const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
  _w[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
  _w[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  _w[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

export function triangleArea(pos, a, b, c, m = IDENTITY) {
  transformInto(0, pos, a, m); transformInto(3, pos, b, m); transformInto(6, pos, c, m);
  const ux = _w[3] - _w[0], uy = _w[4] - _w[1], uz = _w[5] - _w[2];
  const vx = _w[6] - _w[0], vy = _w[7] - _w[1], vz = _w[8] - _w[2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

function isDegenerateUnderAll(pos, a, b, c, worldMatrices) {
  if (!worldMatrices.length) return triangleArea(pos, a, b, c) < EPS_AREA;
  for (const m of worldMatrices) if (triangleArea(pos, a, b, c, m) >= EPS_AREA) return false;
  return true;
}

function isCollapsed(index, i) {
  return index[i + 1] === index[i] && index[i + 2] === index[i];
}

function collapse(index, i) {
  index[i + 1] = index[i];
  index[i + 2] = index[i];
}

export function collapseDegenerateTriangles(index, pos, worldMatrices = []) {
  let collapsed = 0;
  for (let i = 0; i + 2 < index.length; i += 3) {
    if (isCollapsed(index, i)) continue;
    if (isDegenerateUnderAll(pos, index[i], index[i + 1], index[i + 2], worldMatrices)) { collapse(index, i); collapsed++; }
  }
  return collapsed;
}

export function dropDegenerateTriangles(index, pos, worldMatrices = []) {
  const kept = [];
  let dropped = 0;
  for (let i = 0; i + 2 < index.length; i += 3) {
    const a = index[i], b = index[i + 1], c = index[i + 2];
    if (isDegenerateUnderAll(pos, a, b, c, worldMatrices)) { dropped++; continue; }
    kept.push(a, b, c);
  }
  return { index: dropped ? new index.constructor(kept) : index, dropped };
}

function edgeExceeds(pos, a, b, limitSq) {
  const dx = pos[a * 3] - pos[b * 3], dy = pos[a * 3 + 1] - pos[b * 3 + 1], dz = pos[a * 3 + 2] - pos[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz > limitSq;
}

export function collapseFanTriangles(clusters, pos, streamIndex, streamBase) {
  let collapsed = 0;
  for (let ci = 0; ci < clusters.length; ci++) {
    const [mnx, mny, mnz, mxx, mxy, mxz] = clusters[ci].aabb;
    const reach = Math.hypot(mxx - mnx, mxy - mny, mxz - mnz) * FAN_EDGE_MAX_CLUSTER_DIAGONALS;
    const reachSq = reach * reach;
    for (const lod of clusters[ci].lods) {
      const index = streamIndex[lod.stream];
      const start = streamBase[lod.stream] + lod.offset;
      const end = start + lod.count;
      if (!index || end > index.length) {
        throw new RangeError(`collapseFanTriangles: cluster ${ci} lod stream=${lod.stream} range [${start},${end}) outside index stream of length ${index ? index.length : 'none'}`);
      }
      for (let i = start; i + 2 < end; i += 3) {
        if (isCollapsed(index, i)) continue;
        const a = index[i], b = index[i + 1], c = index[i + 2];
        if (edgeExceeds(pos, a, b, reachSq) || edgeExceeds(pos, b, c, reachSq) || edgeExceeds(pos, a, c, reachSq)) { collapse(index, i); collapsed++; }
      }
    }
  }
  return collapsed;
}
