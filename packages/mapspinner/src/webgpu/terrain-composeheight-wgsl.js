export const TERRAIN_COMPOSEHEIGHT_WGSL = `
fn h3(p_in: vec3<f32>) -> f32 {
  var p = fract(p_in * vec3<f32>(0.1031, 0.1030, 0.0973));
  p = p + vec3<f32>(dot(p, p.yxz + vec3<f32>(33.33, 33.33, 33.33)));
  return fract((p.x + p.y) * p.z) * 2.0 - 1.0;
}

fn snoise3(P: vec3<f32>) -> f32 {
  let fl = floor(P);
  let f = P - fl;
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let i0 = fl;
  let i1 = fl + vec3<f32>(1.0, 1.0, 1.0);
  let n000 = h3(i0);
  let n100 = h3(vec3<f32>(i1.x, i0.y, i0.z));
  let n010 = h3(vec3<f32>(i0.x, i1.y, i0.z));
  let n110 = h3(vec3<f32>(i1.x, i1.y, i0.z));
  let n001 = h3(vec3<f32>(i0.x, i0.y, i1.z));
  let n101 = h3(vec3<f32>(i1.x, i0.y, i1.z));
  let n011 = h3(vec3<f32>(i0.x, i1.y, i1.z));
  let n111 = h3(i1);
  let x00 = mix(n000, n100, u.x);
  let x10 = mix(n010, n110, u.x);
  let x01 = mix(n001, n101, u.x);
  let x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

fn value_fbm(x_in: vec3<f32>, gain: f32, numOctaves: i32) -> f32 {
  var v = 0.0;
  var a = 1.0;
  var norm = 0.0;
  var p = x_in;
  for (var i: i32 = 0; i < numOctaves; i = i + 1) {
    v = v + a * snoise3(p);
    norm = norm + a;
    a = a * gain;
    p = p * 2.0;
  }
  return v / norm;
}

fn rotate_domain(pos: vec3<f32>, angle: f32) -> vec3<f32> {
  let c = cos(angle);
  let s = sin(angle);
  return vec3<f32>(c * pos.x - s * pos.z, pos.y, s * pos.x + c * pos.z);
}

fn value_ridged_fbm_rot(x_in: vec3<f32>, gain: f32, numOctaves: i32, offset: f32, exponent: f32) -> f32 {
  var v = 0.0;
  var w = 1.0;
  var norm = 0.0;
  var a = 1.0;
  var p = x_in;
  for (var i: i32 = 0; i < numOctaves; i = i + 1) {
    var signal = offset - abs(snoise3(p));
    signal = pow(max(signal, 0.0), exponent);
    v = v + signal * w * a;
    norm = norm + a;
    w = clamp(signal, 0.0, 1.0);
    a = a * gain;
    p = rotate_domain(p * 2.0, f32(i) * 0.5236);
  }
  return v / max(norm, 1e-5);
}

fn eval_layer0(pos: vec3<f32>) -> f32 {
  return value_ridged_fbm_rot(pos, 0.5, 10, 1.064, 1.005);
}

fn eval_layer1(pos: vec3<f32>) -> f32 {
  let raw = value_fbm(pos, 0.5, 18);
  let t = raw * 0.5 + 0.5;
  return -2.0 + 4.0 * t;
}

fn eval_layer2(pos: vec3<f32>) -> f32 {
  let raw = value_ridged_fbm_rot(pos, 0.5, 18, 1.064, 1.1);
  return -2.0 + 4.0 * raw;
}

fn sample_fractal_terrain(pCoords: vec3<f32>) -> f32 {
  let h0 = eval_layer0(pCoords);
  let warpOff = pCoords * 1.6 * h0;
  let warped = pCoords + warpOff;
  let h1 = eval_layer1(warped);
  let h2 = eval_layer2(warped);
  return (h0 + h1 + h2) / 3.0;
}

fn fractalTerrainH(dir0: vec3<f32>) -> f32 {
  let dirN = normalize(dir0);
  let p = dirN * 3.0;
  let raw = sample_fractal_terrain(p);
  var h = (raw - 0.17) * 0.6;
  let pmix = snoise3(p * 0.53 + vec3<f32>(123.0, 456.0, 789.0)) * 0.5 + 0.5;
  let vPower = mix(0.95, 1.3, pmix);
  if (h > 0.0) {
    h = pow(h, 0.8 * vPower);
  } else {
    h = -pow(-h, 0.8 * vPower);
  }
  let cRatio = clamp(snoise3(dirN * 4.0) * 0.5 + 0.7, 0.3, 1.0);
  h = h * cRatio;
  return h;
}

fn quintic(t: f32) -> f32 {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn hpfFaceUV(d: vec3<f32>) -> vec3<f32> {
  let a = abs(d);
  var face: f32;
  var u: f32;
  var v: f32;
  if (a.x >= a.y && a.x >= a.z) {
    let sc = 1.0 / a.x;
    if (d.x > 0.0) { face = 0.0; u = -d.z * sc; } else { face = 1.0; u = d.z * sc; }
    v = d.y * sc;
  } else if (a.y >= a.z) {
    let sc = 1.0 / a.y;
    if (d.y > 0.0) { face = 2.0; v = -d.z * sc; } else { face = 3.0; v = d.z * sc; }
    u = d.x * sc;
  } else {
    let sc = 1.0 / a.z;
    if (d.z > 0.0) { face = 4.0; u = d.x * sc; } else { face = 5.0; u = -d.x * sc; }
    v = d.y * sc;
  }
  return vec3<f32>(face, u * 0.5 + 0.5, v * 0.5 + 0.5);
}

fn hpfTexel(face: i32, x: i32, y: i32, res: i32) -> f32 {
  let idx = (face * res * res + (y * res + x)) * 4;
  return hpfPool[idx];
}

fn continentalBias(dir: vec3<f32>, res: i32) -> f32 {
  let fuv = hpfFaceUV(normalize(dir));
  let face = i32(fuv.x + 0.5);
  let denom = res - 1;
  let denomF = f32(denom);
  let tx = fuv.y * denomF;
  let ty = fuv.z * denomF;
  let fx0 = floor(tx);
  let fy0 = floor(ty);
  let wx = quintic(tx - fx0);
  let wy = quintic(ty - fy0);
  var x0 = i32(fx0);
  var y0 = i32(fy0);
  if (x0 < 0) { x0 = 0; } else if (x0 > denom) { x0 = denom; }
  if (y0 < 0) { y0 = 0; } else if (y0 > denom) { y0 = denom; }
  let x1 = select(denom, x0 + 1, x0 < denom);
  let y1 = select(denom, y0 + 1, y0 < denom);
  let s00 = hpfTexel(face, x0, y0, res);
  let s10 = hpfTexel(face, x1, y0, res);
  let s01 = hpfTexel(face, x0, y1, res);
  let s11 = hpfTexel(face, x1, y1, res);
  let ea = s00 + wx * (s10 - s00);
  let eb = s01 + wx * (s11 - s01);
  return ea + wy * (eb - ea);
}

fn hpfTexelCh(face: i32, x: i32, y: i32, res: i32, channel: i32) -> f32 {
  let idx = (face * res * res + (y * res + x)) * 4 + channel;
  return hpfPool[idx];
}

fn hpfClimateSample(dir: vec3<f32>, res: i32) -> vec2<f32> {
  let fuv = hpfFaceUV(normalize(dir));
  let face = i32(fuv.x + 0.5);
  let denom = res - 1;
  let denomF = f32(denom);
  let tx = fuv.y * denomF;
  let ty = fuv.z * denomF;
  let fx0 = floor(tx);
  let fy0 = floor(ty);
  let wx = quintic(tx - fx0);
  let wy = quintic(ty - fy0);
  var x0 = i32(fx0);
  var y0 = i32(fy0);
  if (x0 < 0) { x0 = 0; } else if (x0 > denom) { x0 = denom; }
  if (y0 < 0) { y0 = 0; } else if (y0 > denom) { y0 = denom; }
  let x1 = select(denom, x0 + 1, x0 < denom);
  let y1 = select(denom, y0 + 1, y0 < denom);
  let t00 = vec2<f32>(hpfTexelCh(face, x0, y0, res, 2), hpfTexelCh(face, x0, y0, res, 3));
  let t10 = vec2<f32>(hpfTexelCh(face, x1, y0, res, 2), hpfTexelCh(face, x1, y0, res, 3));
  let t01 = vec2<f32>(hpfTexelCh(face, x0, y1, res, 2), hpfTexelCh(face, x0, y1, res, 3));
  let t11 = vec2<f32>(hpfTexelCh(face, x1, y1, res, 2), hpfTexelCh(face, x1, y1, res, 3));
  let ea = mix(t00, t10, wx);
  let eb = mix(t01, t11, wx);
  return mix(ea, eb, wy);
}

fn sculptTexel(x: i32, y: i32, res: i32) -> f32 {
  var xi = x;
  var yi = y;
  if (xi < 0) { xi = 0; } else if (xi > res - 1) { xi = res - 1; }
  if (yi < 0) { yi = 0; } else if (yi > res - 1) { yi = res - 1; }
  return sculptTex[yi * res + xi];
}

fn sculptSample(uv: vec2<f32>, res: i32) -> f32 {
  let resF = f32(res);
  let tx = uv.x * resF - 0.5;
  let ty = uv.y * resF - 0.5;
  let x0 = floor(tx);
  let y0 = floor(ty);
  let fx = tx - x0;
  let fy = ty - y0;
  let ix0 = i32(x0);
  let iy0 = i32(y0);
  let s00 = sculptTexel(ix0, iy0, res);
  let s10 = sculptTexel(ix0 + 1, iy0, res);
  let s01 = sculptTexel(ix0, iy0 + 1, res);
  let s11 = sculptTexel(ix0 + 1, iy0 + 1, res);
  let ea = mix(s00, s10, fx);
  let eb = mix(s01, s11, fx);
  return mix(ea, eb, fy);
}

fn sculptOverrideAt(dir0: vec3<f32>, hBase: f32, isActive: f32, up: vec3<f32>, east: vec3<f32>, north: vec3<f32>, center: vec2<f32>, extent: f32, defRadius: f32, sculptRes: i32) -> f32 {
  if (isActive < 0.5) { return 0.0; }
  if (dot(dir0, up) <= 0.0) { return 0.0; }
  let surfR = defRadius + hBase;
  let x = surfR * dot(dir0, east);
  let z = surfR * dot(dir0, north);
  let rel = vec2<f32>(x, z) - center;
  let ext = select(1.0, extent, extent > 0.0);
  let uv = rel / (2.0 * ext) + vec2<f32>(0.5, 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 0.0; }
  return sculptSample(uv, sculptRes);
}

const CONTINENTAL_BIAS_AMP: f32 = 50.0;

fn composeHeight(dir0: vec3<f32>, landBias: f32, beachShelfM: f32, hpfRes: i32, sculptActive: f32, sculptUp: vec3<f32>, sculptEast: vec3<f32>, sculptNorth: vec3<f32>, sculptCenter: vec2<f32>, sculptExtent: f32, defRadius: f32, sculptRes: i32, reliefScale: f32) -> f32 {
  let frac = fractalTerrainH(dir0);
  let cbias = continentalBias(dir0, hpfRes) * CONTINENTAL_BIAS_AMP;
  var h = frac * 750000.0 + cbias + landBias;
  if (h < 0.0) {
    h = max(h * 1.25, -350000.0);
  } else {
    let bShelf = select(150.0, beachShelfM, beachShelfM > 1.0);
    if (h < bShelf) { h = (h * h / bShelf) * (2.0 - h / bShelf); }
  }
  h = h * select(1.0, reliefScale, reliefScale > 0.0);
  h = h + sculptOverrideAt(dir0, h, sculptActive, sculptUp, sculptEast, sculptNorth, sculptCenter, sculptExtent, defRadius, sculptRes);
  return h;
}

@group(0) @binding(0) var<uniform> paramsU: vec4<u32>;
@group(0) @binding(1) var<uniform> scalarA: vec4<f32>;
@group(0) @binding(2) var<uniform> scalarB: vec4<f32>;
@group(0) @binding(3) var<uniform> basis: array<vec4<f32>, 3>;
@group(0) @binding(4) var<storage, read> dirs: array<f32>;
@group(0) @binding(5) var<storage, read_write> heights: array<f32>;
@group(0) @binding(6) var<storage, read> hpfPool: array<f32>;
@group(0) @binding(7) var<storage, read> sculptTex: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= paramsU.x) {
    return;
  }
  let d = vec3<f32>(dirs[idx * 3u], dirs[idx * 3u + 1u], dirs[idx * 3u + 2u]);
  let hpfRes = i32(paramsU.y);
  let sculptRes = i32(paramsU.z);
  let landBias = scalarA.x;
  let beachShelfM = scalarA.y;
  let sculptActive = scalarA.z;
  let sculptExtent = scalarA.w;
  let sculptCenter = vec2<f32>(scalarB.x, scalarB.y);
  let defRadius = scalarB.z;
  let up = basis[0].xyz;
  let east = basis[1].xyz;
  let north = basis[2].xyz;
  let reliefScale = bitcast<f32>(paramsU.w);
  heights[idx] = composeHeight(d, landBias, beachShelfM, hpfRes, sculptActive, up, east, north, sculptCenter, sculptExtent, defRadius, sculptRes, reliefScale);
}
`
