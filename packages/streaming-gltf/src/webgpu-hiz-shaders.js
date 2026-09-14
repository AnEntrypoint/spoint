export const HZB_REDUCE_WGSL = `
struct ReduceParams {
  srcSize   : vec2<u32>,
  dstSize   : vec2<u32>,
};
@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var dstTex : texture_storage_2d<r32float, write>;
@group(0) @binding(2) var<uniform> params : ReduceParams;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.dstSize.x || gid.y >= params.dstSize.y) { return; }
  let base = vec2<u32>(gid.xy * vec2<u32>(2u, 2u));
  let maxC = params.srcSize - vec2<u32>(1u, 1u);
  let c00 = min(base, maxC);
  let c10 = min(base + vec2<u32>(1u, 0u), maxC);
  let c01 = min(base + vec2<u32>(0u, 1u), maxC);
  let c11 = min(base + vec2<u32>(1u, 1u), maxC);
  let d00 = textureLoad(srcTex, vec2<i32>(c00), 0).r;
  let d10 = textureLoad(srcTex, vec2<i32>(c10), 0).r;
  let d01 = textureLoad(srcTex, vec2<i32>(c01), 0).r;
  let d11 = textureLoad(srcTex, vec2<i32>(c11), 0).r;
  let m = min(min(d00, d10), min(d01, d11));
  textureStore(dstTex, vec2<i32>(gid.xy), vec4<f32>(m, m, m, 1.0));
}`;

export const HZB_SEED_WGSL = `
@group(0) @binding(0) var srcDepth : texture_depth_2d;
@group(0) @binding(1) var dstTex : texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let dstSize = textureDimensions(dstTex);
  if (gid.x >= dstSize.x || gid.y >= dstSize.y) { return; }
  let d = textureLoad(srcDepth, vec2<i32>(gid.xy), 0);
  textureStore(dstTex, vec2<i32>(gid.xy), vec4<f32>(d, d, d, 1.0));
}`;

export const CULL_LOD_WGSL = `
struct Cluster {
  aabbMin      : vec3<f32>, pad0 : f32,
  aabbMax      : vec3<f32>, pad1 : f32,
  sphereCenter : vec3<f32>, sphereRadius : f32,
  lod0Offset   : u32, lod0Count : u32,
  lod1Offset   : u32, lod1Count : u32,
  lod2Offset   : u32, lod2Count : u32,
  lodCount     : u32, pad2 : u32,
};

struct FrameParams {
  viewProjection : mat4x4<f32>,
  world          : mat4x4<f32>,
  cameraPos      : vec3<f32>, pad : f32,
  screenHeight   : f32,
  tanHalfSq      : f32,
  hystUp         : f32,
  hystDown       : f32,
  threshold0     : f32,
  threshold1     : f32,
  clusterCount   : u32,
  baseVertex     : u32,
  firstInstance  : u32,
  hzbLevels      : u32,
  hzbW           : f32,
  hzbH           : f32,
};

struct IndirectArgs {
  indexCount    : atomic<u32>,
  instanceCount : u32,
  firstIndex    : u32,
  baseVertex    : i32,
  firstInstance : u32,
};

@group(0) @binding(0) var<storage, read> clusters : array<Cluster>;
@group(0) @binding(1) var<uniform> frame : FrameParams;
@group(0) @binding(2) var<storage, read_write> indirectArgs : array<IndirectArgs>;
@group(0) @binding(3) var<storage, read_write> drawCount : atomic<u32>;
@group(0) @binding(4) var hzbTex : texture_2d<f32>;
@group(0) @binding(5) var hzbSampler : sampler;

fn aabbOutsidePlane(mn: vec3<f32>, mx: vec3<f32>, plane: vec4<f32>) -> bool {
  let px = select(mn.x, mx.x, plane.x >= 0.0);
  let py = select(mn.y, mx.y, plane.y >= 0.0);
  let pz = select(mn.z, mx.z, plane.z >= 0.0);
  return (plane.x * px + plane.y * py + plane.z * pz + plane.w) < 0.0;
}

fn frustumCulled(mn: vec3<f32>, mx: vec3<f32>, vp: mat4x4<f32>) -> bool {
  let r0 = vec4<f32>(vp[0][0], vp[1][0], vp[2][0], vp[3][0]);
  let r1 = vec4<f32>(vp[0][1], vp[1][1], vp[2][1], vp[3][1]);
  let r2 = vec4<f32>(vp[0][2], vp[1][2], vp[2][2], vp[3][2]);
  let r3 = vec4<f32>(vp[0][3], vp[1][3], vp[2][3], vp[3][3]);
  let planes = array<vec4<f32>, 6>(r3 + r0, r3 - r0, r3 + r1, r3 - r1, r3 + r2, r3 - r2);
  for (var i = 0u; i < 6u; i = i + 1u) {
    if (aabbOutsidePlane(mn, mx, planes[i])) { return true; }
  }
  return false;
}

fn selectHzbLevel(spanPx: f32, maxLevel: u32) -> u32 {
  let lvl = i32(ceil(log2(max(spanPx, 1.0))));
  return u32(clamp(lvl, 0, i32(maxLevel)));
}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let ci = gid.x;
  if (ci >= frame.clusterCount) { return; }
  let c = clusters[ci];

  var wmn = vec3<f32>(1e30, 1e30, 1e30);
  var wmx = vec3<f32>(-1e30, -1e30, -1e30);
  for (var i = 0u; i < 8u; i = i + 1u) {
    let lx = select(c.aabbMin.x, c.aabbMax.x, (i & 1u) != 0u);
    let ly = select(c.aabbMin.y, c.aabbMax.y, (i & 2u) != 0u);
    let lz = select(c.aabbMin.z, c.aabbMax.z, (i & 4u) != 0u);
    let wp = (frame.world * vec4<f32>(lx, ly, lz, 1.0)).xyz;
    wmn = min(wmn, wp);
    wmx = max(wmx, wp);
  }

  if (frustumCulled(wmn, wmx, frame.viewProjection)) { return; }

  let wcenter = (frame.world * vec4<f32>(c.sphereCenter, 1.0)).xyz;
  var minZ = 1.0;
  var minX = 1e30; var maxX = -1e30; var minY = 1e30; var maxY = -1e30;
  var anyInFront = false;
  for (var i = 0u; i < 8u; i = i + 1u) {
    let lx = select(c.aabbMin.x, c.aabbMax.x, (i & 1u) != 0u);
    let ly = select(c.aabbMin.y, c.aabbMax.y, (i & 2u) != 0u);
    let lz = select(c.aabbMin.z, c.aabbMax.z, (i & 4u) != 0u);
    let wp = (frame.world * vec4<f32>(lx, ly, lz, 1.0)).xyz;
    let clip = frame.viewProjection * vec4<f32>(wp, 1.0);
    if (clip.w <= 0.0001) { continue; }
    anyInFront = true;
    let ndc = clip.xyz / clip.w;
    let sx = ndc.x * 0.5 + 0.5;
    let sy = ndc.y * 0.5 + 0.5;
    let sz = ndc.z * 0.5 + 0.5;
    minX = min(minX, sx); maxX = max(maxX, sx);
    minY = min(minY, sy); maxY = max(maxY, sy);
    minZ = min(minZ, sz);
  }
  if (anyInFront && frame.hzbLevels > 0u) {
    let cx = clamp((minX + maxX) * 0.5, 0.0, 1.0);
    let cy = clamp((minY + maxY) * 0.5, 0.0, 1.0);
    let spanPx = max((maxX - minX) * frame.hzbW, (maxY - minY) * frame.hzbH);
    let level = selectHzbLevel(spanPx, frame.hzbLevels - 1u);
    let texel = textureLoad(hzbTex, vec2<i32>(i32(cx * frame.hzbW) >> i32(level), i32(cy * frame.hzbH) >> i32(level)), i32(level)).r;
    if (minZ >= texel + 1e-5) { return; }
  }

  let toCam = frame.cameraPos - wcenter;
  let distSq = max(dot(toCam, toCam), 1e-6);
  let basisX = vec3<f32>(frame.world[0][0], frame.world[0][1], frame.world[0][2]);
  let basisY = vec3<f32>(frame.world[1][0], frame.world[1][1], frame.world[1][2]);
  let basisZ = vec3<f32>(frame.world[2][0], frame.world[2][1], frame.world[2][2]);
  let worldScale = sqrt(max(dot(basisX, basisX), max(dot(basisY, basisY), dot(basisZ, basisZ))));
  let worldRadius = c.sphereRadius * worldScale;
  let sizeSq = (frame.screenHeight * worldRadius) * (frame.screenHeight * worldRadius);

  var lod = 2u;
  if (c.lodCount <= 1u) {
    lod = 0u;
  } else {
    let eff0 = frame.threshold0 * frame.hystUp;
    if (sizeSq > eff0 * eff0 * frame.tanHalfSq * distSq) {
      lod = 0u;
    } else if (c.lodCount > 2u) {
      let eff1 = frame.threshold1 * frame.hystUp;
      if (sizeSq > eff1 * eff1 * frame.tanHalfSq * distSq) { lod = 1u; } else { lod = 2u; }
    } else {
      lod = 1u;
    }
  }
  if (lod >= c.lodCount) { lod = c.lodCount - 1u; }

  var offset = c.lod0Offset; var count = c.lod0Count;
  if (lod == 1u) { offset = c.lod1Offset; count = c.lod1Count; }
  if (lod == 2u) { offset = c.lod2Offset; count = c.lod2Count; }
  if (count == 0u) { return; }

  let slot = atomicAdd(&drawCount, 1u);
  indirectArgs[slot].instanceCount = 1u;
  indirectArgs[slot].firstIndex = offset;
  atomicStore(&indirectArgs[slot].indexCount, count);
  indirectArgs[slot].baseVertex = i32(frame.baseVertex);
  indirectArgs[slot].firstInstance = frame.firstInstance;
}`;

export const CLUSTER_STRIDE_BYTES = 80;
export const INDIRECT_STRIDE_BYTES = 20;
export const MAX_LOD_SLOTS = 3;

export function flattenClusters(clusterSet, lod0Count) {
  const clusters = clusterSet.clusters;
  const n = clusters.length;
  const buf = new ArrayBuffer(n * CLUSTER_STRIDE_BYTES);
  const dv = new DataView(buf);
  for (let i = 0; i < n; i++) {
    const c = clusters[i];
    const base = i * CLUSTER_STRIDE_BYTES;
    let o = base;
    dv.setFloat32(o, c.aabb[0], true); o += 4;
    dv.setFloat32(o, c.aabb[1], true); o += 4;
    dv.setFloat32(o, c.aabb[2], true); o += 4;
    dv.setFloat32(o, 0, true); o += 4;
    dv.setFloat32(o, c.aabb[3], true); o += 4;
    dv.setFloat32(o, c.aabb[4], true); o += 4;
    dv.setFloat32(o, c.aabb[5], true); o += 4;
    dv.setFloat32(o, 0, true); o += 4;
    const sc = c.sphere.length === 4 ? c.sphere : [
      (c.aabb[0] + c.aabb[3]) * 0.5,
      (c.aabb[1] + c.aabb[4]) * 0.5,
      (c.aabb[2] + c.aabb[5]) * 0.5,
      c.sphere[0],
    ];
    dv.setFloat32(o, sc[0], true); o += 4;
    dv.setFloat32(o, sc[1], true); o += 4;
    dv.setFloat32(o, sc[2], true); o += 4;
    dv.setFloat32(o, sc[3], true); o += 4;
    for (let s = 0; s < MAX_LOD_SLOTS; s++) {
      const l = c.lods[Math.min(s, c.lods.length - 1)];
      const streamBaseIndex = l.stream === 1 ? lod0Count : 0;
      dv.setUint32(o, streamBaseIndex + l.offset, true); o += 4;
      dv.setUint32(o, l.count, true); o += 4;
    }
    dv.setUint32(o, Math.min(c.lods.length, MAX_LOD_SLOTS), true); o += 4;
    dv.setUint32(o, 0, true); o += 4;
  }
  return buf;
}
