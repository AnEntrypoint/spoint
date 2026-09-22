export const TERRAIN_HEIGHT_WGSL = `
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

@group(0) @binding(0) var<storage, read> dirs: array<f32>;
@group(0) @binding(1) var<storage, read_write> heights: array<f32>;
@group(0) @binding(2) var<uniform> params: vec4<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.x) {
    return;
  }
  let d = vec3<f32>(dirs[idx * 3u], dirs[idx * 3u + 1u], dirs[idx * 3u + 2u]);
  heights[idx] = fractalTerrainH(d);
}
`
