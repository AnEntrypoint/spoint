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
  let m = max(max(d00, d10), max(d01, d11));
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
  thresholdCount : u32,
  cullDisable    : u32,
  fallbackIndexCount : u32,
  pad4           : u32,
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
// No sampler: the cull reads the pyramid with textureLoad, and an unused binding
// is dropped from an auto bind group layout, which then rejects the bind group.
// Previous LOD index per cluster, owned by the CPU cull (ClusterLodMesh._curLod) and
// uploaded each dispatch: the GPU cull must not keep a second copy of hysteresis state.
@group(0) @binding(6) var<storage, read> lodState : array<i32>;
@group(0) @binding(7) var<storage, read_write> frustumVisible : atomic<u32>;

fn aabbOutsidePlane(mn: vec3<f32>, mx: vec3<f32>, plane: vec4<f32>) -> bool {
  let px = select(mn.x, mx.x, plane.x > 0.0);
  let py = select(mn.y, mx.y, plane.y > 0.0);
  let pz = select(mn.z, mx.z, plane.z > 0.0);
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

fn hzbLevelFor(spanPx: f32, maxLevel: i32) -> i32 {
  return clamp(i32(ceil(log2(max(spanPx, 1.0)))), 0, maxLevel);
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

  if (frame.cullDisable == 0u && frustumCulled(wmn, wmx, frame.viewProjection)) { return; }

  let wcenter = (frame.world * vec4<f32>(c.sphereCenter, 1.0)).xyz;
  var minZ = 1.0;
  var minX = 1e30; var maxX = -1e30; var minY = 1e30; var maxY = -1e30;
  var anyInFront = false;
  var allInFront = true;
  for (var i = 0u; i < 8u; i = i + 1u) {
    let lx = select(c.aabbMin.x, c.aabbMax.x, (i & 1u) != 0u);
    let ly = select(c.aabbMin.y, c.aabbMax.y, (i & 2u) != 0u);
    let lz = select(c.aabbMin.z, c.aabbMax.z, (i & 4u) != 0u);
    let wp = (frame.world * vec4<f32>(lx, ly, lz, 1.0)).xyz;
    let clip = frame.viewProjection * vec4<f32>(wp, 1.0);
    if (clip.w <= 0.0001) { allInFront = false; continue; }
    anyInFront = true;
    let ndc = clip.xyz / clip.w;
    let sx = ndc.x * 0.5 + 0.5;
    let sy = ndc.y * 0.5 + 0.5;
    // Clip z / w is already [0, 1] near-to-far, same as the depth attachment.
    let sz = ndc.z;
    minX = min(minX, sx); maxX = max(maxX, sx);
    minY = min(minY, sy); maxY = max(maxY, sy);
    minZ = min(minZ, sz);
  }
  let toCam = frame.cameraPos - wcenter;
  let distSq = max(dot(toCam, toCam), 1e-6);
  let basisX = vec3<f32>(frame.world[0][0], frame.world[0][1], frame.world[0][2]);
  let basisY = vec3<f32>(frame.world[1][0], frame.world[1][1], frame.world[1][2]);
  let basisZ = vec3<f32>(frame.world[2][0], frame.world[2][1], frame.world[2][2]);
  let worldScale = sqrt(max(dot(basisX, basisX), max(dot(basisY, basisY), dot(basisZ, basisZ))));
  let worldRadius = c.sphereRadius * worldScale;
  let sizeSq = (frame.screenHeight * worldRadius) * (frame.screenHeight * worldRadius);

  // Same threshold walk as ClusterLodMesh._pickLod, unrolled because a uniform
  // address-space array<f32, N> is illegal in WGSL (16-byte element stride).
  let cur = lodState[ci];
  var lod = i32(frame.thresholdCount);
  var picked = false;
  if (frame.thresholdCount > 0u) {
    let eff = frame.threshold0 * select(frame.hystDown, frame.hystUp, cur < 0 || cur > 0);
    if (sizeSq > eff * eff * frame.tanHalfSq * distSq) { lod = 0; picked = true; }
  }
  if (!picked && frame.thresholdCount > 1u) {
    let eff = frame.threshold1 * select(frame.hystDown, frame.hystUp, cur < 0 || cur > 1);
    if (sizeSq > eff * eff * frame.tanHalfSq * distSq) { lod = 1; picked = true; }
  }
  let avail = i32(c.lodCount);
  if (lod >= avail) { lod = avail - 1; }
  if (lod < 0) { lod = 0; }

  var offset = c.lod0Offset; var count = c.lod0Count;
  if (lod == 1) { offset = c.lod1Offset; count = c.lod1Count; }
  if (lod == 2) { offset = c.lod2Offset; count = c.lod2Count; }

  // ClusterLodMesh counts a cluster as drawn on the frustum result alone, so the
  // fallback group has to key off that count and not off the occluded draw count.
  if (count != 0u) { atomicAdd(&frustumVisible, 1u); }

  if (allInFront && anyInFront && frame.hzbLevels > 0u) {
    minX = clamp(minX, 0.0, 1.0); maxX = clamp(maxX, 0.0, 1.0);
    minY = clamp(minY, 0.0, 1.0); maxY = clamp(maxY, 0.0, 1.0);
    let spanPx = max((maxX - minX) * frame.hzbW, (maxY - minY) * frame.hzbH);
    let level = hzbLevelFor(spanPx, i32(frame.hzbLevels) - 1);
    let lw = max(ceil(frame.hzbW / exp2(f32(level))), 1.0);
    let lh = max(ceil(frame.hzbH / exp2(f32(level))), 1.0);
    let x0 = clamp(i32(floor(minX * lw)), 0, i32(lw) - 1);
    let x1 = clamp(i32(floor(maxX * lw)), 0, i32(lw) - 1);
    // ndc y is up, texture rows are down: row = (1 - sy) * lh.
    let y0 = clamp(i32(floor((1.0 - maxY) * lh)), 0, i32(lh) - 1);
    let y1 = clamp(i32(floor((1.0 - minY) * lh)), 0, i32(lh) - 1);
    // Every texel the rect touches, maxed: a single centre texel at one mip both
    // misses occluders and reads a level that does not cover the rect.
    var farthest = 0.0;
    for (var yy = y0; yy <= y1; yy = yy + 1) {
      for (var xx = x0; xx <= x1; xx = xx + 1) {
        farthest = max(farthest, textureLoad(hzbTex, vec2<i32>(xx, yy), level).r);
      }
    }
    if (minZ > farthest + 1e-5) { return; }
  }

  if (count == 0u) { return; }

  let slot = atomicAdd(&drawCount, 1u);
  indirectArgs[slot].instanceCount = 1u;
  indirectArgs[slot].firstIndex = offset;
  atomicStore(&indirectArgs[slot].indexCount, count);
  indirectArgs[slot].baseVertex = i32(frame.baseVertex);
  indirectArgs[slot].firstInstance = frame.firstInstance;
}

// ClusterLodMesh._render emits one group spanning the whole LOD0 when no cluster
// survives the cull; the GPU cull must emit the same draw or the two disagree.
// Runs as a separate dispatch after main, so it sees main's final draw count.
@compute @workgroup_size(1, 1, 1)
fn fallbackMain() {
  if (atomicLoad(&frustumVisible) != 0u) { return; }
  if (frame.fallbackIndexCount == 0u) { return; }
  let slot = atomicAdd(&drawCount, 1u);
  indirectArgs[slot].instanceCount = 1u;
  indirectArgs[slot].firstIndex = 0u;
  atomicStore(&indirectArgs[slot].indexCount, frame.fallbackIndexCount);
  indirectArgs[slot].baseVertex = i32(frame.baseVertex);
  indirectArgs[slot].firstInstance = frame.firstInstance;
}`;

// Same reduction, from a multisampled depth attachment: `texture_depth_2d` cannot
// bind a texture with sampleCount > 1, and the shipped app renders MSAA, so the seed
// has a multisampled variant. Max over samples is the conservative choice: the
// pyramid must hold the FARTHEST depth a texel reaches, or the cull hides something
// a viewer can see. `textureNumSamples` keeps this to one pipeline for every count.
export const HZB_SEED_MSAA_WGSL = `
@group(0) @binding(0) var srcDepth : texture_depth_multisampled_2d;
@group(0) @binding(1) var dstTex : texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let dstSize = textureDimensions(dstTex);
  if (gid.x >= dstSize.x || gid.y >= dstSize.y) { return; }
  let n = textureNumSamples(srcDepth);
  var m = 0.0;
  for (var s = 0u; s < n; s = s + 1u) {
    m = max(m, textureLoad(srcDepth, vec2<i32>(gid.xy), s));
  }
  textureStore(dstTex, vec2<i32>(gid.xy), vec4<f32>(m, m, m, 1.0));
}`;

export const CLUSTER_STRIDE_BYTES = 80;
export const INDIRECT_STRIDE_BYTES = 20;
export const MAX_LOD_SLOTS = 3;
export const ENTITY_BOX_STRIDE_BYTES = 32;
export const ENTITY_PARAMS_BYTES = 80;

// One invocation per candidate entity: the entity's world AABB against the same
// pyramid the cluster cull reads. A verdict of 1 means every corner of the box is
// behind the farthest occluder depth the box's texel footprint reaches, so hiding
// the entity cannot remove anything a viewer could see. A box that straddles the
// near plane reports 0, because clip-space z is meaningless behind the eye.
export const ENTITY_HZB_WGSL = `
struct EntityBox {
  mn    : vec3<f32>, pad0 : f32,
  mx    : vec3<f32>, pad1 : f32,
};

struct EntityParams {
  viewProjection : mat4x4<f32>,
  count     : u32,
  hzbLevels : u32,
  hzbW      : f32,
  hzbH      : f32,
};

@group(0) @binding(0) var<storage, read> boxes : array<EntityBox>;
@group(0) @binding(1) var<uniform> params : EntityParams;
@group(0) @binding(2) var<storage, read_write> verdicts : array<u32>;
@group(0) @binding(3) var hzbTex : texture_2d<f32>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let b = boxes[i];

  var minZ = 1.0;
  var minX = 1e30;
  var maxX = -1e30;
  var minY = 1e30;
  var maxY = -1e30;
  var anyInFront = false;
  var allInFront = true;
  for (var k = 0u; k < 8u; k = k + 1u) {
    let lx = select(b.mn.x, b.mx.x, (k & 1u) != 0u);
    let ly = select(b.mn.y, b.mx.y, (k & 2u) != 0u);
    let lz = select(b.mn.z, b.mx.z, (k & 4u) != 0u);
    let clip = params.viewProjection * vec4<f32>(lx, ly, lz, 1.0);
    if (clip.w <= 0.0001) { allInFront = false; continue; }
    anyInFront = true;
    let ndc = clip.xyz / clip.w;
    let sx = ndc.x * 0.5 + 0.5;
    let sy = ndc.y * 0.5 + 0.5;
    minX = min(minX, sx);
    maxX = max(maxX, sx);
    minY = min(minY, sy);
    maxY = max(maxY, sy);
    minZ = min(minZ, ndc.z);
  }
  if (!allInFront || !anyInFront || params.hzbLevels == 0u) {
    verdicts[i] = 0u;
    return;
  }

  minX = clamp(minX, 0.0, 1.0);
  maxX = clamp(maxX, 0.0, 1.0);
  minY = clamp(minY, 0.0, 1.0);
  maxY = clamp(maxY, 0.0, 1.0);
  let spanPx = max((maxX - minX) * params.hzbW, (maxY - minY) * params.hzbH);
  let level = clamp(i32(ceil(log2(max(spanPx, 1.0)))), 0, i32(params.hzbLevels) - 1);
  let lw = max(ceil(params.hzbW / exp2(f32(level))), 1.0);
  let lh = max(ceil(params.hzbH / exp2(f32(level))), 1.0);
  let x0 = clamp(i32(floor(minX * lw)) - 1, 0, i32(lw) - 1);
  let x1 = clamp(i32(floor(maxX * lw)) + 1, 0, i32(lw) - 1);
  // ndc y is up, texture rows are down: row = (1 - sy) * lh. Both edges grow by one
  // texel: the pyramid is the previous frame's depth, so the footprint has to cover
  // where the box was as well as where it is, or a moving camera culls a box that
  // has just come into view.
  let y0 = clamp(i32(floor((1.0 - maxY) * lh)) - 1, 0, i32(lh) - 1);
  let y1 = clamp(i32(floor((1.0 - minY) * lh)) + 1, 0, i32(lh) - 1);
  var farthest = 0.0;
  for (var yy : i32 = y0; yy <= y1; yy = yy + 1) {
    for (var xx : i32 = x0; xx <= x1; xx = xx + 1) {
      farthest = max(farthest, textureLoad(hzbTex, vec2<i32>(xx, yy), level).r);
    }
  }
  verdicts[i] = select(0u, 1u, minZ > farthest + 1e-5);
}`;

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
