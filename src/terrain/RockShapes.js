import { TRI_TABLE } from './RockTriTableShared.js'

const EDGE_TABLE = new Int32Array([
  0x0,0x109,0x203,0x30a,0x406,0x50f,0x605,0x70c,0x80c,0x905,0xa0f,0xb06,0xc0a,0xd03,0xe09,0xf00,
  0x190,0x99,0x393,0x29a,0x596,0x49f,0x795,0x69c,0x99c,0x895,0xb9f,0xa96,0xd9a,0xc93,0xf99,0xe90,
  0x230,0x339,0x33,0x13a,0x636,0x73f,0x435,0x53c,0xa3c,0xb35,0x83f,0x936,0xe3a,0xf33,0xc39,0xd30,
  0x3a0,0x2a9,0x1a3,0xaa,0x7a6,0x6af,0x5a5,0x4ac,0xbac,0xaa5,0x9af,0x8a6,0xfaa,0xea3,0xda9,0xca0,
  0x460,0x569,0x663,0x76a,0x66,0x16f,0x265,0x36c,0xc6c,0xd65,0xe6f,0xf66,0x86a,0x963,0xa69,0xb60,
  0x5f0,0x4f9,0x7f3,0x6fa,0x1f6,0xff,0x3f5,0x2fc,0xdfc,0xcf5,0xfff,0xef6,0x9fa,0x8f3,0xbf9,0xaf0,
  0x650,0x759,0x453,0x55a,0x256,0x35f,0x55,0x15c,0xe5c,0xf55,0xc5f,0xd56,0xa5a,0xb53,0x859,0x950,
  0x7c0,0x6c9,0x5c3,0x4ca,0x3c6,0x2cf,0x1c5,0xcc,0xfcc,0xec5,0xdcf,0xcc6,0xbca,0xac3,0x9c9,0x8c0,
  0x8c0,0x9c9,0xac3,0xbca,0xcc6,0xdcf,0xec5,0xfcc,0xcc,0x1c5,0x2cf,0x3c6,0x4ca,0x5c3,0x6c9,0x7c0,
  0x950,0x859,0xb53,0xa5a,0xd56,0xc5f,0xf55,0xe5c,0x15c,0x55,0x35f,0x256,0x55a,0x453,0x759,0x650,
  0xaf0,0xbf9,0x8f3,0x9fa,0xef6,0xfff,0xcf5,0xdfc,0x2fc,0x3f5,0xff,0x1f6,0x6fa,0x7f3,0x4f9,0x5f0,
  0xb60,0xa69,0x963,0x86a,0xf66,0xe6f,0xd65,0xc6c,0x36c,0x265,0x16f,0x66,0x76a,0x663,0x569,0x460,
  0xca0,0xda9,0xea3,0xfaa,0x8a6,0x9af,0xaa5,0xbac,0x4ac,0x5a5,0x6af,0x7a6,0xaa,0x1a3,0x2a9,0x3a0,
  0xd30,0xc39,0xf33,0xe3a,0x936,0x83f,0xb35,0xa3c,0x53c,0x435,0x73f,0x636,0x13a,0x33,0x339,0x230,
  0xe90,0xf99,0xc93,0xd9a,0xa96,0xb9f,0x895,0x99c,0x69c,0x795,0x49f,0x596,0x29a,0x393,0x99,0x190,
  0xf00,0xe09,0xd03,0xc0a,0xb06,0xa0f,0x905,0x80c,0x70c,0x605,0x50f,0x406,0x30a,0x203,0x109,0x0
])

function rng(seed) {
  let s = seed | 0
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
}

export function makeRockSDF(seed) {
  const r = rng(seed)
  const numCuts = 14 + Math.floor(r() * 8)
  const cuts = []
  for (let i = 0; i < numCuts; i++) {
    const theta = r() * Math.PI * 2, phi = Math.acos(2 * r() - 1)
    cuts.push({
      dx: Math.sin(phi) * Math.cos(theta), dy: Math.sin(phi) * Math.sin(theta), dz: Math.cos(phi),
      radius: 1.4 + r() * 1.1, ratio: 0.6 + r() * 0.25, k: 0.02 + r() * 0.06
    })
  }
  const sx = 0.75 + r() * 0.5, sy = 0.6 + r() * 0.4, sz = 0.75 + r() * 0.5
  return (x, y, z) => {
    const px = x / sx, py = y / sy, pz = z / sz
    let d = Math.sqrt(px*px + py*py + pz*pz) - 1.05
    for (const c of cuts) {
      const ax = px + c.dx*c.radius, ay = py + c.dy*c.radius, az = pz + c.dz*c.radius
      const sd = Math.sqrt(ax*ax + ay*ay + az*az) - c.radius * c.ratio
      const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (-sd - d)) / c.k))
      d = d * (1 - h) + (-sd) * h + c.k * h * (1 - h)
    }
    if (d > 0.3) d = 0.3
    return d
  }
}

const VMAP = new Map()
export function marchRockSurface(res, sdf) {
  const x0 = -1.5, x1 = 1.5, y0 = -1.5, y1 = 1.5, z0 = -1.5, z1 = 1.5
  const dx = (x1-x0)/(res-1), dy = (y1-y0)/(res-1), dz = (z1-z0)/(res-1)
  const field = new Float32Array(res*res*res)
  for (let k = 0, idx = 0; k < res; k++)
    for (let j = 0; j < res; j++)
      for (let i = 0; i < res; i++, idx++)
        field[idx] = sdf(x0 + i*dx, y0 + j*dy, z0 + k*dz)
  const MAX = res*res*res*5
  const positions = new Float32Array(MAX*3)
  const indices = new Uint32Array(MAX*3)
  let vc = 0, ic = 0
  VMAP.clear()
  const getVert = (x, y, z) => {
    const ix = (x*100)|0, iy = (y*100)|0, iz = (z*100)|0
    const key = ((ix+512)<<20)|((iy+512)<<10)|(iz+512)
    if (VMAP.has(key)) return VMAP.get(key)
    const idx = vc
    positions[vc*3] = x; positions[vc*3+1] = y; positions[vc*3+2] = z
    vc++; VMAP.set(key, idx); return idx
  }
  const lerp = (p1, p2, v1, v2, out) => {
    const t = Math.abs(v1-v2) < 1e-10 ? 0 : -v1/(v2-v1)
    out[0] = p1[0] + t*(p2[0]-p1[0]); out[1] = p1[1] + t*(p2[1]-p1[1]); out[2] = p1[2] + t*(p2[2]-p1[2])
  }
  const corners = Array.from({length:8}, () => [0,0,0])
  const verts = Array.from({length:12}, () => [0,0,0])
  const vals = new Float32Array(8)
  for (let k = 0; k < res-1; k++) {
    for (let j = 0; j < res-1; j++) {
      for (let i = 0; i < res-1; i++) {
        const x = x0 + i*dx, y = y0 + j*dy, z = z0 + k*dz
        corners[0][0]=x;corners[0][1]=y;corners[0][2]=z
        corners[1][0]=x+dx;corners[1][1]=y;corners[1][2]=z
        corners[2][0]=x+dx;corners[2][1]=y+dy;corners[2][2]=z
        corners[3][0]=x;corners[3][1]=y+dy;corners[3][2]=z
        corners[4][0]=x;corners[4][1]=y;corners[4][2]=z+dz
        corners[5][0]=x+dx;corners[5][1]=y;corners[5][2]=z+dz
        corners[6][0]=x+dx;corners[6][1]=y+dy;corners[6][2]=z+dz
        corners[7][0]=x;corners[7][1]=y+dy;corners[7][2]=z+dz
        const base = k*res*res + j*res + i
        vals[0] = field[base]; vals[1] = field[base+1]
        vals[2] = field[base+1+res]; vals[3] = field[base+res]
        vals[4] = field[base+res*res]; vals[5] = field[base+1+res*res]
        vals[6] = field[base+1+res+res*res]; vals[7] = field[base+res+res*res]
        let ci = 0
        for (let n = 0; n < 8; n++) if (vals[n] < 0) ci |= 1 << n
        const e = EDGE_TABLE[ci]
        if (!e) continue
        if (e&1) lerp(corners[0], corners[1], vals[0], vals[1], verts[0])
        if (e&2) lerp(corners[1], corners[2], vals[1], vals[2], verts[1])
        if (e&4) lerp(corners[2], corners[3], vals[2], vals[3], verts[2])
        if (e&8) lerp(corners[3], corners[0], vals[3], vals[0], verts[3])
        if (e&16) lerp(corners[4], corners[5], vals[4], vals[5], verts[4])
        if (e&32) lerp(corners[5], corners[6], vals[5], vals[6], verts[5])
        if (e&64) lerp(corners[6], corners[7], vals[6], vals[7], verts[6])
        if (e&128) lerp(corners[7], corners[4], vals[7], vals[4], verts[7])
        if (e&256) lerp(corners[0], corners[4], vals[0], vals[4], verts[8])
        if (e&512) lerp(corners[1], corners[5], vals[1], vals[5], verts[9])
        if (e&1024) lerp(corners[2], corners[6], vals[2], vals[6], verts[10])
        if (e&2048) lerp(corners[3], corners[7], vals[3], vals[7], verts[11])
        const tri = TRI_TABLE[ci]
        for (let t = 0; tri[t] !== -1; t += 3) {
          const a = verts[tri[t]], b = verts[tri[t+1]], c = verts[tri[t+2]]
          const ia = getVert(a[0],a[1],a[2]), ib = getVert(b[0],b[1],b[2]), ic2 = getVert(c[0],c[1],c[2])
          if (ia !== ib && ib !== ic2 && ic2 !== ia) {
            indices[ic++] = ia; indices[ic++] = ic2; indices[ic++] = ib
          }
        }
      }
    }
  }
  return { positions: positions.subarray(0, vc*3), vc, indices: indices.subarray(0, ic), ic }
}

export function generateRockHullData(numShapes = 6, baseSeed = 1337, hullRes = 12) {
  const out = []
  for (let s = 0; s < numShapes; s++) {
    const sdf = makeRockSDF(baseSeed + s * 7919)
    const { positions: hullPos } = marchRockSurface(hullRes, sdf)
    let cx = 0, cy = 0, cz = 0
    const vCount = hullPos.length / 3
    for (let v = 0; v < vCount; v++) { cx += hullPos[v*3]; cy += hullPos[v*3+1]; cz += hullPos[v*3+2] }
    cx /= vCount; cy /= vCount; cz /= vCount
    let total = 0, minY = Infinity, maxY = -Infinity
    for (let v = 0; v < vCount; v++) {
      const dxv = hullPos[v*3]-cx, dyv = hullPos[v*3+1]-cy, dzv = hullPos[v*3+2]-cz
      total += Math.sqrt(dxv*dxv + dyv*dyv + dzv*dzv)
      if (hullPos[v*3+1] < minY) minY = hullPos[v*3+1]
      if (hullPos[v*3+1] > maxY) maxY = hullPos[v*3+1]
    }
    out.push({
      positions: hullPos,
      vCount,
      avgRadius: total / vCount,
      squashRatio: ((maxY - minY) / 2) / (total / vCount),
      bottomY: minY,
      height: maxY - minY
    })
  }
  return out
}
