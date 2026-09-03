// mapspinner WebGL2 terrain render shader.
// VS: spherical deformation + direct per-vertex sphere projection.
// FS: sample normal + albedo, sun-lit Lambert with ambient floor.
// The JS prepends #version + precision and compiles _VERTEX_ / _FRAGMENT_ separately.

// --- DIRECT per-vertex sphere-projection uniforms ------
// SINGLE INSTANCED DRAW: defOffset (ox,oy,l,level) + the face frame are PER-INSTANCE now (one
// gl.drawElementsInstanced over the whole visible leaf set, no per-quad uniform churn). In the VS
// they come from instance attributes (iOffset + iFace); defRadius/defViewProjRel stay uniforms
// (same for every instance). The _PROBE_ collision program uses its own probeDir, not these.
// W7 highp ISLANDS: every world-scale quantity here is ~6.4e6 m and the projection cancels at that
// magnitude -- fp16 (mediump, range +-65504, ~3 sig digits) would shatter it. Declared highp under the
// mediump global default so the planet-scale fp32 cancellation fix (camera-relative vRel) stays intact.
uniform highp float defRadius;         // R, sphere radius (~6.4e6 m)
uniform highp mat4 defViewProjNoEye;   // proj*viewRel WITHOUT folded translate(-eye) -- for camera-relative VS pos
uniform highp vec3 defCamDir;          // unit camera direction (eye/|eye|) -- vertex-jitter precision fix
uniform highp float defCamAlt;         // camera altitude above the sphere (|eye|-R)

// HIERARCHICAL PARAMETER FIELD (HPF) continental texture (shared VS+FS): per-face 2D-arrays
// baked from anchor-field.js. W12 PACK (mob-w12): the old single RGBA32F (16B/texel) is split
// into TWO smaller textures -- hpfPool RG16F (R=seaBias[m], G=elevAmp; the two PRECISION-sensitive
// floats the geometry rides on) + hpfPool2 RG8 (R=temp, G=humid; both already [0,1] climate, 8-bit
// is ample). 4B+2B = 6B/texel vs 16B = 62% less HPF VRAM/bandwidth, with NO silhouette change
// (seaBias/elevAmp keep float precision; temp/humid quantize to 1/255, far below the biome
// soft-threshold widths). hpfSample DECODES both back into the same vec4 callers expect
// (seaBias, elevAmp, temp, humid) so every consumer (VS bias, vClimate, probe, heightbake) is
// unchanged. UNCONDITIONAL format (single version; no tier branch).
uniform sampler2DArray hpfPool;    // RG16F: r=seaBias[m], g=elevAmp
uniform sampler2DArray hpfPool2;   // RG8:   r=temp[0,1], g=humid[0,1]
uniform int hasHpf;
uniform float uHpfInset;          // HPF seam-inset sampler (window.__hpfInset; 0=centred bake default, 1=edge-inset seam->0). MUST match planet-orchestrator bakeFace fu mapping. Declared here (before hpfSample) so all stages see it.
// W11 FORMAT PROBE (NOT a quality tier): OES_texture_float_linear probed ONCE at init (gl-render.js
// sets this). 1 = the float/half-float atlas pools filter LINEAR in hardware -> the manual 4-tap
// bilinear in hpfSample collapses to a single hardware texture() call.
// 0 = the driver would silently fall back to NEAREST (the 'square steps / banding' regression) so the
// manual 4-tap is kept for correctness. Numerically equivalent either way -- a FORMAT-correctness
// branch, the one admissible runtime branch.
uniform int uFloatLinearOK;
// world unit dir -> cube face + uv[0,1] (matches anchor-field.js dirToFaceUV / FACE_FRAME).
void hpfFaceUV(vec3 d, out int face, out vec2 uv) {
    vec3 a = abs(d);
    float u, v, sc;
    if (a.x >= a.y && a.x >= a.z) { sc = 1.0/a.x;
        if (d.x > 0.0) { face = 0; u = -d.z*sc; } else { face = 1; u = d.z*sc; } v = d.y*sc; }
    else if (a.y >= a.z) { sc = 1.0/a.y;
        if (d.y > 0.0) { face = 2; v = -d.z*sc; } else { face = 3; v = d.z*sc; } u = d.x*sc; }
    else { sc = 1.0/a.z;
        if (d.z > 0.0) { face = 4; u = d.x*sc; } else { face = 5; u = -d.x*sc; } v = d.y*sc; }
    uv = vec2(u*0.5 + 0.5, v*0.5 + 0.5);
}
highp vec4 hpfSample(vec3 dir) {   // W7: R=seaBias is metres (~1600) -> highp so cbias keeps full precision
    if (hasHpf == 0) return vec4(0.0, 1.0, 0.5, 0.5);   // seaBias 0, elevAmp 1, temp/humid .5
    int face; vec2 uv; hpfFaceUV(normalize(dir), face, uv);
    // W11: when float-linear filters in hardware, one texture() per pool == the 4-tap result. The
    // bake samples at texel centres so the centred (non-inset) hardware tap matches the manual one
    // exactly; the inset bake keeps the manual taps (its tap centres are k/(sz-1), not the hardware
    // (k+0.5)/sz grid) so it stays correct regardless.
    // HARDWARE-TAP FAST PATH DISABLED for the crease fix: a single hardware texture() is HARDWARE
    // BILINEAR = the SAME C0 texel-edge slope kink as raw manual weights, so on a float-linear GPU it
    // bypassed the quintic-weight fix below and the seaBias crease persisted (user 2026-06-09). Always
    // take the manual path so the quintic C2 weights apply to seaBias/elevAmp (geometry-critical). Cost:
    // 4 taps vs 1, but only per-vertex in VS/PROBE (negligible; FS reads the interpolated varying).
    // (uHpfInset>0.5 inset bake already used the manual path; this just unifies onto it always.)
    // MANUAL BILINEAR (2026-06-06, user: 'elevation divided into squares -> square STEPS / STAIRS,
    // should be smooth'). hpfSample drives vH = cbias + bShape (terrain.glsl ~743): cbias=seaBias and
    // reliefMul/ridgeMul derive from this sample, so any quantization here steps the GEOMETRY in
    // ~50km (128-texel/face) squares. The hpfPool texture is FLAGGED LINEAR (planet-orchestrator.js)
    // but RGBA32F LINEAR filtering REQUIRES OES_texture_float_linear; if that extension is absent the
    // driver SILENTLY falls back to NEAREST -> per-texel-cell constants -> the visible stairs (the
    // orchestrator's own getExtension comment names this exact 'elevations look square from NEAREST'
    // failure). Fix: bilinear in-shader so the field is smooth REGARDLESS of hardware float-linear --
    // textureSize for the texel grid, 4 taps at the surrounding texel centres, 2D lerp. Tap coords are
    // clamped to texel centres in [0.5/sz, 1-0.5/sz] = CLAMP_TO_EDGE equivalent, so this reproduces the
    // intended hardware LINEAR exactly (no new cube-face seam) when the ext IS present, and fixes the
    // steps when it is not.
    vec2 sz = vec2(textureSize(hpfPool, 0).xy);
    // SEAM-INSET MATCHED SAMPLER (hpf-seam-inset-bake, gated by uHpfInset to match the bake fu=x/(RES-1)).
    // Inset: texel k sits at uv=k/(sz-1) (edge texels at 0 and 1), so t=uv*(sz-1) and the tap centres are
    // k/(sz-1). Centred (default): texel k at uv=(k+0.5)/sz, t=uv*sz-0.5. Both must agree with the bake.
    bool inset = uHpfInset > 0.5;
    vec2 denom = inset ? (sz - 1.0) : sz;
    vec2 t  = inset ? (uv * denom) : (uv * sz - 0.5);
    vec2 t0 = floor(t);
    vec2 f  = t - t0;   // one shared floor (FXC floor/fract consistency, see snoise3)
    vec2 hb = 0.5 / sz;                           // half-texel in uv (clamp band, centred case)
    vec2 c0 = inset ? (t0)              / denom : clamp((t0 + 0.5)        / sz, hb, 1.0 - hb);
    vec2 c1 = inset ? (t0 + vec2(1.0, 0.0)) / denom : clamp((t0 + vec2(1.5, 0.5)) / sz, hb, 1.0 - hb);
    vec2 c2 = inset ? (t0 + vec2(0.0, 1.0)) / denom : clamp((t0 + vec2(0.5, 1.5)) / sz, hb, 1.0 - hb);
    vec2 c3 = inset ? (t0 + vec2(1.0, 1.0)) / denom : clamp((t0 + 1.5)        / sz, hb, 1.0 - hb);
    vec2 uv00 = clamp(c0, vec2(0.0), vec2(1.0));
    vec2 uv10 = clamp(c1, vec2(0.0), vec2(1.0));
    vec2 uv01 = clamp(c2, vec2(0.0), vec2(1.0));
    vec2 uv11 = clamp(c3, vec2(0.0), vec2(1.0));
    float ff = float(face);
    // W12 DECODE: 4 bilinear taps from EACH packed texture, reassembled into the legacy
    // vec4 (seaBias, elevAmp, temp, humid). Same uv/weights for both -> one bilinear field.
    vec2 s00 = texture(hpfPool,  vec3(uv00, ff)).rg;   // (seaBias, elevAmp)
    vec2 s10 = texture(hpfPool,  vec3(uv10, ff)).rg;
    vec2 s01 = texture(hpfPool,  vec3(uv01, ff)).rg;
    vec2 s11 = texture(hpfPool,  vec3(uv11, ff)).rg;
    // QUINTIC C2 bilinear weights (NOT raw f=fract(t)). Linear weights are C0 -> the interpolated
    // seaBias/elevAmp SLOPE kinks at every texel-cell edge; seaBias is added RAW to h (cbias+bShape)
    // so on a slope crossing a texel boundary that kink is a STRAIGHT ELEVATION CREASE (user 5 grids
    // 2026-06-09: a vertical cliff at one grid column, 0.4-38m, all rows). Quintic w is value-identical
    // at texel centres (w(0)=0,w(1)=1) so amplitude/field UNCHANGED -- only the inter-texel slope is C2.
    // Same fix class as the vnoise2 quintic. SEAM-SAFE: the texel-centre clamp (above) is untouched.
    vec2 w = f*f*f*(f*(f*6.0-15.0)+10.0);
    vec2 se  = mix(mix(s00, s10, w.x), mix(s01, s11, w.x), w.y);
    vec2 t00 = texture(hpfPool2, vec3(uv00, ff)).rg;   // (temp, humid)
    vec2 t10 = texture(hpfPool2, vec3(uv10, ff)).rg;
    vec2 t01 = texture(hpfPool2, vec3(uv01, ff)).rg;
    vec2 t11 = texture(hpfPool2, vec3(uv11, ff)).rg;
    vec2 th  = mix(mix(t00, t10, w.x), mix(t01, t11, w.x), w.y);   // same quintic C2 weights (temp/humid)
    return vec4(se.x, se.y, th.x, th.y);
}

// ---- FRACTAL NOISE PRIMITIVES ----
// PCG integer hash -> [-1,1].
// W7 highp: lattice coords reach freq*dir ~1.4e4 -> ALL noise args are highp.
// Hash: fract-sine, robust across all WebGL2 implementations.
highp float h3(highp vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z) * 2.0 - 1.0;
}
// Quintic value noise.
float snoise3(highp vec3 P) {
    // FXC CONSISTENCY (2026-07-04 needle fix): floor(P) and fract(P) computed INDEPENDENTLY let
    // ANGLE/FXC's fast-math evaluate the expression feeding each with different roundings near a
    // lattice boundary -- the cell index i and the in-cell fraction f then disagree (i from cell k,
    // f relative to cell k+-1), so the corner hashes come from the WRONG cell: an O(1) noise jump at
    // isolated points on lattice planes, surfacing as +30m single-texel height NEEDLES along a line
    // (backend split: d3d11 5 needles, vulkan/swiftshader/CPU 0 -- scripts/needle-ab.mjs; bisected
    // to a single 1-octave snoise3 call). Deriving f FROM the one shared floor result makes i/f
    // consistent BY CONSTRUCTION on every translator; value-identical where fract already agreed.
    highp vec3 fl = floor(P);
    highp ivec3 i = ivec3(fl);
    highp vec3 f = P - fl;
    highp vec3 u = f*f*f*(f*(f*6.0-15.0)+10.0);
    highp vec3 i0 = vec3(i), i1 = vec3(i) + vec3(1.0);
    float n000 = h3(i0);
    float n100 = h3(vec3(i1.x, i0.y, i0.z));
    float n010 = h3(vec3(i0.x, i1.y, i0.z));
    float n110 = h3(vec3(i1.x, i1.y, i0.z));
    float n001 = h3(vec3(i0.x, i0.y, i1.z));
    float n101 = h3(vec3(i1.x, i0.y, i1.z));
    float n011 = h3(vec3(i0.x, i1.y, i1.z));
    float n111 = h3(i1);
    float x00=mix(n000,n100,u.x), x10=mix(n010,n110,u.x);
    float x01=mix(n001,n101,u.x), x11=mix(n011,n111,u.x);
    return mix(mix(x00,x10,u.y), mix(x01,x11,u.y), u.z);   // [-1,1]
}
// FXC ANTI-UNROLL (2026-07-04, the documented d3d11/FXC mis-translation class returning): the
// NoiseLayer const structs carry compile-time-constant numOct (10/18/18/23), so these loops had
// CONSTANT bounds again -- FXC fully unrolled + cross-iteration reordered them, producing isolated
// single-texel height NEEDLES (+30m on a smooth field; backend split proof: d3d11 5 needles,
// vulkan/swiftshader 0 on the same RTX 3060, scripts/needle-ab.mjs). uNoUnroll (set 64 by
// setComposeHeightUniforms, guarded: <=0 -> numOctaves) makes the bound RUNTIME-OPAQUE in every
// branch so FXC cannot unroll; value semantics unchanged (64 > every layer's numOct). Same
// solution as the original uOctMax de-unroll -- never reintroduce a constant fractal loop bound.
uniform int uNoUnroll;
// Standard FBM.
float value_fbm(highp vec3 x, float gain, int numOctaves) {
    float v=0.0, a=1.0, norm=0.0;
    highp vec3 p=x;
    // nb == numOctaves exactly when uNoUnroll==64 (the value setComposeHeightUniforms always sets),
    // but FXC cannot prove (uNoUnroll-64)==0, so the trip count has no provable constant bound and
    // the loop CANNOT be unrolled. min(numOctaves,uniform) was tried first and FAILED: it leaves a
    // provable upper bound (numOctaves) that FXC still unrolls to with folded breaks.
    int nb = numOctaves + ((uNoUnroll > 0) ? (uNoUnroll - 64) : 0);
    for(int i=0;i<nb;i++){ v+=a*snoise3(p); norm+=a; a*=gain; p*=2.0; }
    return v/norm;
}
float value_fbm_scaled(highp vec3 x, float gain, int numOctaves, float lo, float hi) {
    return lo + (hi-lo) * (value_fbm(x,gain,numOctaves)*0.5+0.5);
}
// Per-octave domain rotation (breaks lattice axis alignment in ridged FBM).
highp vec3 rotate_domain(highp vec3 pos, float angle) {
    float c=cos(angle), s=sin(angle);
    return vec3(c*pos.x-s*pos.z, pos.y, s*pos.x+c*pos.z);
}
// Ridged FBM with per-octave rotation.
float value_ridged_fbm_rot(highp vec3 x_in, float gain, int numOctaves, float offset, float exponent) {
    float v=0.0, w=1.0, norm=0.0, a=1.0;
    highp vec3 p=x_in;
    int nb = numOctaves + ((uNoUnroll > 0) ? (uNoUnroll - 64) : 0);   // FXC anti-unroll, see value_fbm
    for(int i=0;i<nb;i++){
        float signal = offset - abs(snoise3(p));
        signal = pow(max(signal,0.0), exponent);
        v += signal * w * a;
        norm += a;
        w = clamp(signal, 0.0, 1.0);
        a *= gain;
        p = rotate_domain(p*2.0, float(i)*0.5236);
    }
    return v / max(norm, 1e-5);
}
float value_ridged_fbm_rot_scaled(highp vec3 x, float gain, int numOctaves, float offset, float exponent, float lo, float hi) {
    return lo + (hi-lo) * (value_ridged_fbm_rot(x,gain,numOctaves,offset,exponent)*0.5+0.5);
}
// Terrain noise layer constants.
// Layer types: 0=FBM, 1=ridged FBM.
const int LTYPE_FBM = 0;
const int LTYPE_RIDGED = 1;
struct NoiseLayer { int ltype; int numOct; float gain; float ridgeOffset; float ridgeExp; float warpStr; float hmin; float hmax; };
// the outer rotated base layer (ridged, 23 octaves).
const NoiseLayer noiseLayerBase = NoiseLayer(LTYPE_RIDGED, 23, 0.5, 1.064, 1.665, 0.45, 0.0, 1.0);
// terrain layers: layer0 ridged 10oct, layer1 FBM 18oct, layer2 ridged 18oct.
const NoiseLayer noiseLayer0 = NoiseLayer(LTYPE_RIDGED, 10, 0.5, 1.064, 1.005, 1.6, 0.0, 1.0);
const NoiseLayer noiseLayer1 = NoiseLayer(LTYPE_FBM,    18, 0.5, 1.064, 1.665, 2.6, -2.0, 2.0);
const NoiseLayer noiseLayer2 = NoiseLayer(LTYPE_RIDGED, 18, 0.5, 1.064, 1.1,   0.9, -2.0, 2.0);
float eval_layer(highp vec3 pos, NoiseLayer L) {
    float raw;
    float t;
    if (L.ltype == LTYPE_FBM) {
        raw = value_fbm(pos, L.gain, L.numOct);
        t = raw * 0.5 + 0.5;  // FBM: [-1,1] -> [0,1]
    } else {
        raw = value_ridged_fbm_rot(pos, L.gain, L.numOct, L.ridgeOffset, L.ridgeExp);
        t = raw;  // ridged FBM already returns [0,1]
    }
    return L.hmin + (L.hmax - L.hmin) * t;
}
// sample_fractal_terrain: 3-layer domain-warp terrain (warpLevel=3, one warp layer).
float sample_fractal_terrain(highp vec3 pCoords) {
    float h0 = eval_layer(pCoords, noiseLayer0);   // CSE: was eval'd twice with byte-identical args (once inline for warpOff, once as h0)
    highp vec3 warpOff = pCoords * noiseLayer0.warpStr * h0;
    highp vec3 warped  = pCoords + warpOff;
    float h1 = eval_layer(warped,   noiseLayer1);
    float h2 = eval_layer(warped,   noiseLayer2);
    return (h0 + h1 + h2) / 3.0;
}
const float PI = 3.14159265;
// Planet terrain height. Returns approx [-0.6,0.6]; sea level at 0.
highp float fractalTerrainH(vec3 dir0) {
    highp vec3 dirN = normalize(dir0);   // dedupe: normalize(dir0) was called twice below with identical dir0 (never mutated in this fn)
    highp vec3 p = dirN * 3.0;

    // Use the full ridged+FBM layer stack (46 octaves, domain-warped) for sharp ridges and detail.
    // sample_fractal_terrain returns roughly [-1.33, 1.67]; normalise to [-1,1] by subtracting centre ~0.17 then dividing.
    float raw = sample_fractal_terrain(p);
    float h = (raw - 0.17) * 0.6;   // centre and compress to ~[-0.6,0.6]

    // Spatially varying power exponent
    float pmix = snoise3(p * 0.53 + vec3(123.0, 456.0, 789.0)) * 0.5 + 0.5;  // 0..1
    float vPower = mix(0.95, 1.3, pmix);

    // Shape: steepen peaks; seabed mirrors land relief (same power = symmetric mountains/trenches)
    if (h > 0.0) h = pow(h, 0.8 * vPower);
    else h = -pow(-h, 0.8 * vPower);

    // Continental ratio: suppresses fine detail in low-variation regions
    float cRatio = clamp(snoise3(dirN * 4.0) * 0.5 + 0.7, 0.3, 1.0);
    h *= cRatio;

    return h;
}

// SHARED vhash/vnoise2/faceWarp helpers still needed for the VS normal taps.
highp float vhash(highp vec2 p){
  uvec2 q = uvec2(ivec2(p));
  uint h = q.x * 1597334677u + q.y * 3812015801u;
  h ^= h >> 16; h *= 2654435769u; h ^= h >> 15; h *= 2246822519u; h ^= h >> 13;
  return float(h) * (1.0 / 4294967296.0);
}
float vnoise2(highp vec2 p){ highp vec2 i=floor(p),f=p-i; vec2 u=f*f*f*(f*(f*6.0-15.0)+10.0);   // f from the one floor (FXC consistency, see snoise3)
  float a=vhash(i),b=vhash(i+vec2(1,0)),c=vhash(i+vec2(0,1)),d=vhash(i+vec2(1,1));
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y)*2.0-1.0; }
highp vec2 faceWarp(highp vec2 p){ return defRadius * tan((p / defRadius) * 0.7853981634); }
uniform float uReliefScale;
uniform float uGrid;
uniform float uNrmStepM;
uniform float uLandBias;
uniform float uBeachShelfM;

// GPU-VISIBLE SCULPT-BRUSH OVERRIDE (terrain-gpu-visible-sculpt-mesh-deformation, first slice): every
// prior raise/lower/smooth/flatten brush (src/terrain/HeightDelta.js) only ever mutated the SERVER
// collider's CPU heightFn -- the GPU-rendered mesh never moved, so a sculpted bump/pit was invisible
// to every connected client even though you could physically stand on it. This adds a small sampler2D
// heightfield-override texture (R32F, uSculptRes texels/side) covering a square window in the SAME
// tangent-plane LOCAL XZ metres space src/terrain/PlanetFrame.js/HeightDelta.js already use, uploaded
// by the host (spoint) whenever a stroke lands or the window re-centers on the player. Sampled and
// ADDED to the base composeHeight result the same additive way HeightDelta.deltaAt composes
// server-side, so the two never diverge in SIGN or MAGNITUDE (only in WHEN they update -- the render
// override is host-pushed per-stroke, the collider is the ground truth).
// COORDINATE RECONSTRUCTION: composeHeight only ever receives `dir0` (a world direction unit vector),
// not local XZ metres -- so the override reconstructs local XZ from dir0 via the CENTRAL (gnomonic)
// projection onto the tangent plane at the anchor, the exact inverse of PlanetFrame.localToDir's
// `dir0 = normalize(up + (east*x + north*z)/radius)` forward map: x = radius*dot(dir0,east)/dot(dir0,up),
// z = radius*dot(dir0,north)/dot(dir0,up). This is only valid (bounded error) near the anchor, which is
// exactly HeightDelta's own usage domain (a hand-placed brush a player is standing near) -- uSculptActive
// is expected to gate a small window around the CURRENT player position, not the whole planet.
// uSculptActive=0 (the default, no active sculpt-override window) short-circuits BEFORE the dot-product
// reconstruction or the texture fetch, so a world that has never sculpted (or has sculpted far from the
// current view) pays zero extra ALU/bandwidth on this path.
uniform float uSculptActive;      // 0 = no override this frame (default, zero-cost), 1 = sample uSculptOverride
uniform highp vec3 uSculptUp;     // PlanetFrame.up    (anchor-local tangent-plane basis, world-unit vectors)
uniform highp vec3 uSculptEast;   // PlanetFrame.east
uniform highp vec3 uSculptNorth;  // PlanetFrame.north
uniform highp vec2 uSculptCenter; // local XZ metres the override window is centered on (this frame's player position, host-tracked)
uniform float uSculptExtent;      // half-width of the override window in local XZ metres (window spans [center-extent, center+extent] on both axes)
uniform sampler2D uSculptOverride; // R32F: bilinearly-filtered accumulated height DELTA (metres) at each texel, 0 = untouched (matches HeightDelta's own "unstamped cell reads 0" invariant)

#if defined(_VERTEX_) || defined(_PROBE_) || defined(_HEIGHTBAKE_)
// Reads the sculpt-override delta (metres) at world direction `dir0`, or 0 if inactive/outside the
// window/behind the anchor horizon (dot(dir0,up)<=0 would divide by a non-positive number -- guarded
// so a vertex on the far side of the planet can never wrap into a bogus in-window UV).
highp float sculptOverrideAt(vec3 dir0){
    if (uSculptActive < 0.5) return 0.0;
    highp float cosUp = dot(dir0, uSculptUp);
    if (cosUp <= 0.0) return 0.0;
    highp float x = defRadius * dot(dir0, uSculptEast) / cosUp;
    highp float z = defRadius * dot(dir0, uSculptNorth) / cosUp;
    highp vec2 rel = vec2(x, z) - uSculptCenter;
    highp float ext = (uSculptExtent > 0.0) ? uSculptExtent : 1.0;
    highp vec2 uv = rel / (2.0 * ext) + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
    return texture(uSculptOverride, uv).r;
}

// Single height function using the fractal terrain algorithm.
highp float composeHeight(vec3 dir0, highp vec2 faceLocal, float tileM){
    highp float frac = fractalTerrainH(dir0); // -0.5..0.5
    highp float h = frac * 750000.0 + uLandBias;
    if (h < 0.0) {
        // Seabed: remap fractal value to gradual depth, preserving full variation.
        // frac at sea-level boundary ~ -0.133 (= -uLandBias/750000). Deep ocean frac ~ -0.5.
        // Use h directly (already = frac*750000 + bias, range ~0..-280000 for ocean)
        // and scale it so shallow coast is near 0 and deep ocean reaches -350000 raw (=-350m).
        // Avoid clamping to 0 from above — let the linear map run so near-coast slopes naturally.
        h = max(h * 1.25, -350000.0);
    } else {
        highp float bShelf = uBeachShelfM > 1.0 ? uBeachShelfM : 150.0;
        if (h < bShelf) h = (h * h / bShelf) * (2.0 - h / bShelf);
    }
    h = h * (uReliefScale > 0.0 ? uReliefScale : 1.0);
    // Sculpt delta is already in final rendered metres (matches HeightDelta's own post-reliefScale
    // server-side domain -- the collider heightFn HeightDelta wraps is the reliefScale-applied result,
    // never the raw pre-scale fractal), so it is added AFTER uReliefScale, not before.
    h += sculptOverrideAt(dir0);
    return h;
}
#endif

uniform float uIsWater;                    // 0 = terrain pass, 1 = water-surface pass
uniform float uUnderwater;                 // 0 = camera above water, 1 = camera below sea level
uniform float uBeachTopM;                  // beach upper limit metres

// WEATHER-DRIVEN WETNESS (wetness-material-modifier-weather-driven, 2026-07-21): 0=dry..1=soaked,
// driven live from client/core/Weather.js's rain state via window.__wetness (see gl-render.js's
// _g('wetness',0) uniform set, matching the uWireframe/uNightLights precedent -- a plain tuning
// scalar, no new texture/attribute). Consumed post-lighting, terrain-pass-only (see the shading
// block near fragColor below) -- kept OUT of the splat/albedo block above on purpose: this is a
// surface-response change (darker + a specular sheen), not a material-identity change, so it must
// not perturb terrainAlbedoClimate/the splat gates AT ALL (zero risk to the already-tuned look at
// uWetness=0, the default/dry value).
uniform float uWetness;

// Ocean wave uniforms -- shared between VS (swell displacement) and FS (shading)
uniform highp float oceanTime;   // animation time (seconds) grows unbounded -> highp
uniform float oceanAmp;          // wave amplitude scale
uniform float oceanChoppy;       // wave directional sharpness
uniform float oceanFoam;         // foam amount

// Integer-permutation hash: avoids sin() transcendental, same quality for wave noise
float seaHash(vec2 p) {
    uvec2 q = uvec2(ivec2(p)) * uvec2(1597334673u, 3812015801u);
    uint  n = (q.x ^ q.y) * 1597334673u;
    return float(n) * (1.0 / 4294967296.0);
}
float seaNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = p - i;   // one shared floor (FXC consistency, see snoise3)
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(seaHash(i), seaHash(i+vec2(1,0)), f.x),
               mix(seaHash(i+vec2(0,1)), seaHash(i+vec2(1,1)), f.x), f.y);
}
float seaOctave(vec2 uv, float choppy) {
    uv += seaNoise(uv);
    vec2 wv  = 1.0 - abs(sin(uv));
    vec2 swv = abs(cos(uv));
    wv = mix(wv, swv, wv);
    return pow(1.0 - pow(wv.x * wv.y, 0.65), choppy);
}

#ifdef _VERTEX_
layout(location=0) in vec3 vertex;   // vertex.xy in [0,1] parametric quad coord
layout(location=1) in highp vec4 iOffset;  // W7: PER-INSTANCE (ox, oy, l, level) face-local metres ~6.4e6 -> highp
layout(location=2) in float iFace;   // PER-INSTANCE cube face index 0..5
layout(location=3) in float iLayer;  // THC: PER-INSTANCE height-pool array layer for this tile (uThc on)
// GEOMORPHING LOD (CDLOD-style, PER-VERTEX -- see the morph block in main() below): deliberately NOT a
// per-instance attribute. A per-quad/per-instance morph ratio was tried first and PROVEN (by direct
// construction) to crack the mesh: two same-level sibling leaves can legitimately sit at different
// dist-to-split-threshold ratios (that per-quad ratio is exactly what the quadtree's LOD-selection
// distance metric is FOR), so blending each quad's own vertices by its OWN ratio moves two quads'
// shared boundary vertices by different amounts, opening a real lateral seam gap. The crack-free fix
// computes morph PER-VERTEX from that vertex's own world distance to the camera against a LEVEL-keyed
// (not quad-keyed) detail range built from uMorphSplitDist/uMorphDistFactor/uMorphMaxLevel below -- a
// shared boundary vertex has one world position and one level, so both neighboring quads' vertex shaders
// evaluate the identical formula and produce the identical morph, crack-free BY CONSTRUCTION.
uniform float uMorphSplitDist;   // == quadtree.js Quadtree.splitDist for this frame (0 disables morph entirely -- safe no-op default)
uniform float uMorphDistFactor;  // == quadtree.js Quadtree.distFactor for this frame
uniform float uMorphMaxLevel;    // == quadtree.js Quadtree.maxLevel for this frame (a maxLevel-capped quad never morphs -- no finer child exists to pre-empt)
// THC (Tile Heightmap Cache): when uThc>0.5 the VS reads the baked composeHeight from uHeightPool
// (a 2D-array, one layer per visible tile, parametric uv = vertex.xy) instead of re-evaluating
// composeHeight 5x/vertex. uPoolLinear=0 -> manual bilinear (R32F not linear-filterable).
uniform float uThc;
uniform sampler2DArray uHeightPool;
uniform float uPoolRes;
uniform float uPoolLinear;
highp float thcSample(highp vec2 uv, float layer){
    highp vec2 t = clamp(uv, 0.0, 1.0) * (uPoolRes - 1.0);
    if (uPoolLinear > 0.5) return texture(uHeightPool, vec3((t + 0.5) / uPoolRes, layer)).r;
    highp vec2 f = floor(t); highp vec2 fr = t - f;
    highp vec2 b0 = (f + 0.5) / uPoolRes, b1 = (f + 1.5) / uPoolRes;
    highp float h00 = texture(uHeightPool, vec3(b0.x, b0.y, layer)).r;
    highp float h10 = texture(uHeightPool, vec3(b1.x, b0.y, layer)).r;
    highp float h01 = texture(uHeightPool, vec3(b0.x, b1.y, layer)).r;
    highp float h11 = texture(uHeightPool, vec3(b1.x, b1.y, layer)).r;
    return mix(mix(h00, h10, fr.x), mix(h01, h11, fr.x), fr.y);
}
out highp vec3 vWorld;   // W7 highp ISLAND: absolute world pos ~6.4e6 m (FS lighting/atmosphere) -- fp16 would jitter it
out highp float vH;      // W7: signed elevation (metres, ~13000) -- highp for the material ramp / strata / ocean depth
out highp vec3 vNrm;     // W8: world-space per-vertex analytic normal (fixed-step central diff of the FULL composeHeight). The SOLE FS lit normal -- replaces the jittery cross(dFdx,dFdy). highp to match vWorld on the ~6.4e6 m planet.
out vec3 vTexWarp;       // texture domain warp, computed ONCE in the VS (2026-06-12 'make warp as performant
                         // as possible': was 9 snoise3 PER PIXEL in the FS splat; the warp waves are >=1.8km
                         // so per-vertex evaluation + linear interpolation is visually identical at any GRID).
                         // The FS applies it EXACTLY ONCE (wt += vTexWarp * uTexWarp) -- single-application
                         // by construction, every texture layer inherits it through the shared wt.
// W5: vNrmPV/vMacroSlope/vShadeAO out-varyings deleted -- the lit normal, rock-gate slope and per-vertex
// AO are all derived in the FS from the Sobel normal now (THC sole path).
// UNIFIED-FIELD water/incision masks: computed ONCE per vertex from the same carve fields that cut
// the geometry, then INTERPOLATED to the FS. The FS no longer re-evaluates the sharp ridged carve
// fields per-pixel (that was a separate high-freq evaluation that aliased = the biome-localized
// moire the user reported). One field, sampled at the vertices, smooth in between.

out highp vec3 vTexRel; // W7: CAMERA-RELATIVE world position (= vWorld - camWorld) for the texture UV. Built from the
                        // same precise (dir0-defCamDir)*R camera-relative form as gl_Position, so it carries NO
                        // 6.4e6m fp32 cancellation -> the texture UV is as stable as the geometry (kills 'UV jumps
                        // wildly up close'). Absolute vWorld would re-quantize ~0.4m/frame as the camera moves.
out float vLevel;       // quad LOD level (per-instance iOffset.w) for the patches debug view
out vec2  vGrid;        // per-quad parametric mesh coord [0,1] (for the wireframe overlay)
out vec4 vClimate;      // (seaBias, elevAmp, temp, humid) sampled ONCE per vertex from the HPF
                        // texture + INTERPOLATED, so the FS never reads the HPF texture per-pixel
                        // (that per-pixel texture read showed the HPF texel grid as UV lines/moire
                        // up close, biome colours following the blocky cells -- user: 'definitely UV').

// cube face index -> face-local->world rotation (col0=U, col1=V, col2=center). MUST match the JS
// FACE_FRAME in planet-orchestrator.js + render localToWorld3(). Built per-instance from iFace so
// the whole visible leaf set draws in ONE instanced call.
mat3 faceFrame(float f){
    int i = int(f + 0.5);
    if (i==0) return mat3( 0.0,0.0,-1.0,  0.0,1.0,0.0,   1.0,0.0,0.0);   // +X
    if (i==1) return mat3( 0.0,0.0, 1.0,  0.0,1.0,0.0,  -1.0,0.0,0.0);   // -X
    if (i==2) return mat3( 1.0,0.0,0.0,   0.0,0.0,-1.0,  0.0,1.0,0.0);   // +Y
    if (i==3) return mat3( 1.0,0.0,0.0,   0.0,0.0, 1.0,  0.0,-1.0,0.0);  // -Y
    if (i==4) return mat3( 1.0,0.0,0.0,   0.0,1.0,0.0,   0.0,0.0,1.0);   // +Z
    return            mat3(-1.0,0.0,0.0,  0.0,1.0,0.0,   0.0,0.0,-1.0);  // -Z
}

// continental elevation bias (meters) from the HPF (shared hpfSample), as a continuous
// function of world dir -> replaces the old hardcoded sin/cos lobe with the editable field.
highp float continentalBias(vec3 dir) { return hpfSample(dir).r; }   // W7: R = seaBias (meters) -> highp

// ---- CONTINUOUS BROAD+MID SHAPE (LOD-uniformity fix). The
// per-level g_noiseAmp cascade adds a DIFFERENT noise draw at each LOD, so consecutive levels
// look different (1500km vs 1200km "way different"). The fix: source the broad+regional SHAPE
// from ONE continuous fBm of WORLD DIRECTION, sampled the same at every LOD -> a finer level is
// a denser SAMPLE of the SAME field, divergence ~0 BY CONSTRUCTION (CLI continuous-field-proof
// meanDiv 0.02-0.08 vs cascade 0.52). Because it is a pure function of world dir it is:
//   - LOD-invariant  -> identical in zf and zc, so CLOD blend is automatically smooth
//   - C0 across tile AND cube-face boundaries -> seamless by construction (no seam probe needed)
// (shash3/snoise3 are defined in the SHARED preamble above so the FS riverMask can use them too.)
// broad+mid fBm of unit world dir -> metres. ONE field sampled IDENTICALLY at every LOD: a finer
// LOD is a denser SAMPLE of the SAME function, so consecutive LODs are maximally similar BY
// CONSTRUCTION (CLI continuous-field-proof meanDivergence 0.02 vs cascade 0.52). Crucially there
// is NO tile-size/LOD term here -- a per-tile octave fade was tried and REFUTED live (it made the
// field itself LOD-DEPENDENT: 1500km faded out octaves a 1200km tile kept, so they diverged).
// 8 fixed octaves span continent->regional->local; baseFreq sets the coarsest continent
// wavelength; seaBias offset sets land fraction (~0.3). Validated regime A0 5000, gain 0.6.
// PER-BIOME RELIEF (reliefMul, ridgeMul): the continent BASE octaves (o0-5) are ALWAYS full so
// the land/sea silhouette + hypsometry + LOD-uniformity are untouched (they were CLI/browser
// validated). The REGIONAL+FINE octaves (o6-13) are scaled by reliefMul and folded toward RIDGES
// by ridgeMul, BOTH supplied per-point from the anchor biome (mountains: high relief + ridged;
// plains/meadow: low relief; desert: medium smooth; swamp/tundra: very low). This makes the
// SHAPE distinguish biomes (not just color) WITHOUT breaking the broad silhouette or LOD-safety
// (still a pure fn of world dir -> denser-sample-of-same-field, no per-LOD term).
// ---- PER-VERTEX micro-relief: the FINE CONTINUATION of the single terrain field, below the
// scale broadShapeM resolves at vertex rate. Keyed on ABSOLUTE world wavelengths (fixed metres),
// NOT tile size, so a finer LOD is a DENSER SAMPLE of the SAME fine field -> detail grows
// monotonically on approach and never "pops" between LODs (the old tileM-relative wavelength was
// a different draw per level, which popped, so it was disabled). Pure fn of face-local world
// position (continuous across tiles on a face -> seamless). Default ON: this is what gives a
// close-up patch real relief instead of sitting flat inside one broad feature.
// vtxDetail/vhash/vnoise2/vnoise2D MOVED to the common preamble (THC-Normal W1) so composeHeight() can
// call them; vtxDisplace MOVED to the shared VS/PROBE region. (were here.)
// anchor elevAmp -> rugged multiplier. MEASURED LIVE (browser-1887): rendered elevAmp clusters
// ~8.0-8.5 (NOT the full 7.5-10.5 band range), so the old smoothstep(7.8,9.6) damped EVERYWHERE
// to ~0.2 -> the whole planet read flat. Recalibrate to the actual distribution: map [7.9,8.7]
// so typical terrain gets meaningful relief (~0.5-1.8) and only genuinely-low belts soften,
// high belts amplify into mountains. Floor 0.5 keeps plains gently rolling, not dead-flat.
// elevAmp range is REALLY ~29-40 (browser-4626), not ~8 -- the old smoothstep(7.9,8.7) saturated to
// 1.8 everywhere (uniform rugged -> uniform bumpiness, no plains/mountain differentiation). Map the
// real range so plains (low elevAmp) are gently rolling and only the high tail is rugged.
// ruggedFromElevAmp + faceWarp MOVED to the common preamble (THC-Normal W1, shared by composeHeight).

void main() {
    // PER-INSTANCE deform params (one instanced draw over the whole leaf set): the quad origin+size
    // and its face frame come from the instance attributes, replacing the old per-quad uniforms.
    highp vec4 defOffset = iOffset;            // W7: face-local metres ~6.4e6 -> highp
    mat3 defLocalToWorld = faceFrame(iFace);   // face-local -> world rotation

    // GEOMORPHING LOD (CDLOD-style vertex blend -- PER-VERTEX, level-keyed; see quadtree.js _recurse
    // for why a per-quad/per-instance morph ratio was tried first and reverted as neighbor-inconsistent
    // -- crack-free by construction). Blends this vertex's position toward the nearest grid line of the
    // COARSER (level-1, half-density) grid, by a ratio in [0,1] computed from THIS VERTEX'S OWN world
    // distance to the camera vs a level-keyed (not quad-keyed) detail range, so a quad about to split
    // pre-emptively slides its own vertices into the shape its not-yet-split parent already draws (and
    // a freshly-split child starts exactly there, un-morphing as the camera closes in) -- eliminating
    // the vertex-position pop at an LOD transition WITHOUT the per-quad approach's seam risk: two
    // adjacent same-level leaves' SHARED boundary vertex has one world position and one level, so both
    // sides evaluate the identical formula -> identical morph -> identical morphed position.
    highp vec2 absLocal = defOffset.xy + vertex.xy * defOffset.z;   // pre-warp face-local meters (this quad's own grid)
    highp float vMorph = 0.0;
    // SKIRT/RING EXCLUSION (2026-07-22, production-enable crack fix): vertex.z>0.5 marks a ring vertex
    // whose xy is ALREADY CPU-clamped onto this quad's true [0,1] edge (gl-render.js's "SKIRT not
    // OVERLAP" mesh build) and whose job is to drop radially straight down from THAT exact edge point,
    // hiding whatever T-junction crack exists at the tile boundary (see the skirt term below). Morphing
    // a ring vertex's absLocal snaps it onto the COARSER PARENT grid line -- a lateral slide off the true
    // edge -- which decouples the hidden curtain's footprint from the edge it is supposed to seal,
    // opening a real visible gap between the curtain and the (possibly differently-morphed, since a
    // same-level neighbor quad can be at a different lateral fall/floor split priority even though the
    // shared-formula argument holds for INTERIOR vertices) neighbor surface. Live-witnessed: a hard
    // straight-line crack across open land terrain, present with geomorphLod on, absent with it off,
    // reproduced at a fixed shore pose (spoint TerrainBackdrop screenshot A/B, 2026-07-22) -- gating ring
    // vertices out of the morph (keeping their skirt drop from the UNMORPHED, CPU-clamped edge position,
    // exactly as before this feature existed) removed it. Interior vertices (vertex.z==0) are unaffected
    // and keep the full crack-free-by-construction morph.
    if (vertex.z < 0.5 && uIsWater < 0.5 && uGrid > 0.0 && uMorphSplitDist > 0.0 && defOffset.w >= 1.0 && defOffset.w < uMorphMaxLevel) {
        // Cheap per-vertex world distance-to-camera: the UNDEFORMED (pre-height) sphere point is close
        // enough for a smooth visual blend ratio (morph only affects a sub-pixel-to-few-metre lateral
        // slide near an LOD boundary, not the final rendered position's own precision) -- avoids a 2nd
        // full composeHeight evaluation just to refine the distance used for this ratio.
        highp vec3 campWorld = defCamDir * (defRadius + defCamAlt);
        highp vec3 vtxDir0 = normalize(defLocalToWorld * vec3(faceWarp(absLocal), defRadius));
        highp float distToCam = distance(vtxDir0 * defRadius, campWorld);
        // LEVEL-KEYED (not quad-keyed) detail range: threshold = l * uMorphSplitDist, the SAME global
        // splitDist every quad at this size uses -- deliberately dropping the quadtree's per-quad
        // fall/floor/latC adjustments (those exist to steer WHICH quads split, not to define a
        // neighbor-safe continuous morph range). distFactor mirrors the quadtree's own altitude-vs-
        // lateral distance weighting so the morph band engages at a scale consistent with the real
        // split cadence. MORPH_BAND=1.0 spans dist in [threshold, 2*threshold] -- matches the
        // structural bound a freshly-split child is born near (its parent split at
        // dist~threshold_parent == 2*threshold_child), so the full un-morph from a freshly-split
        // child (morph~1 at birth) back to full detail (morph~0) spans most of its real lifetime.
        highp float threshold = defOffset.z * uMorphSplitDist * uMorphDistFactor;
        highp float morphEnd = threshold * 2.0;
        highp float m = (morphEnd - distToCam) / (morphEnd - threshold);
        vMorph = clamp(m, 0.0, 1.0);
        vMorph = vMorph * vMorph * (3.0 - 2.0 * vMorph);   // smoothstep: C1-continuous ramp, no velocity kink at the band edges
    }
    // MUST snap in FACE-ABSOLUTE pre-warp meters (defOffset.xy + vertex.xy*defOffset.z), NOT in this
    // quad's own normalized [0,1] parametric space: a quad's cell size in absolute meters is l/uGrid,
    // its parent's is 2l/uGrid (same uGrid, double the world extent) -- ONE fixed absolute grid, shared
    // by every level, whose lines a coarser level's vertices already sit on exactly. Snapping the
    // ABSOLUTE coordinate to the nearest multiple of the parent's cell size is therefore bit-exact
    // for ANY uGrid (even or odd) -- verified by direct construction (every child-quadrant vertex at
    // morph=1 lands on a real parent-grid point, 0 mismatches for uGrid in {8,9,11,16}). A per-quad
    // normalized-space snap (round(vertex.xy/(2*du))*(2*du)) is only exact when uGrid is EVEN (odd
    // uGrid doesn't divide evenly into 2 coarse cells across [0,1]) -- this is why the snap works on
    // ABSOLUTE meters, which are continuous and shared across the whole face, not per-quad-relative.
    if (vMorph > 0.0) {
        highp float parentCell = (2.0 * defOffset.z) / uGrid;   // parent quad's cell size in the SAME absolute meters
        highp vec2 coarseAbs = round(absLocal / parentCell) * parentCell;
        absLocal = mix(absLocal, coarseAbs, vMorph);
    }
    highp vec2 vxy = (absLocal - defOffset.xy) / defOffset.z;   // back to parametric [0,1]-ish coord (may extend slightly for skirt/ring verts, same as the unmorphed vertex.xy did) for the THC/debug-varying paths below
    // (elevation atlas removed -- terrain height is the GPU fractal broadShapeM, no tile sample.)
    // world direction of this vertex (pre-deform) for the continental mask.
    highp vec2 faceLocal = faceWarp(absLocal);   // hoisted: reused for dir0 and composeHeight (was computed twice); absLocal carries the geomorph blend
    vec3 dir0 = normalize(defLocalToWorld * vec3(faceLocal, defRadius));  // W7: faceWarp/defRadius highp -> pre-normalize ~6.4e6 stays highp
    highp vec4 hpf0 = hpfSample(dir0);    // (seaBias, elevAmp, temp, humid) -- used for vClimate

    // Height from the fractal terrain algorithm
    highp float hN0 = 0.0;
    highp vec3 vN = dir0;
    // Water pass still needs seabed height for vH so FS depthM = max(-vH,0) is correct.
    if (uIsWater > 0.5) { hN0 = composeHeight(dir0, faceLocal, defOffset.z); }
    else if (uIsWater < 0.5 && uThc > 0.5) {
        hN0 = thcSample(vxy, iLayer);
        highp float duP = 1.0 / ((uGrid > 0.0) ? uGrid : 16.0);
        highp float hPU = thcSample(vxy + vec2(duP, 0.0), iLayer);
        highp float hMU = thcSample(vxy + vec2(-duP, 0.0), iLayer);
        highp float hPV = thcSample(vxy + vec2(0.0, duP), iLayer);
        highp float hMV = thcSample(vxy + vec2(0.0, -duP), iLayer);
        highp vec3 dPU = normalize(defLocalToWorld * vec3(faceWarp((vxy + vec2(duP,0.0)) * defOffset.z + defOffset.xy), defRadius));
        highp vec3 dMU = normalize(defLocalToWorld * vec3(faceWarp((vxy + vec2(-duP,0.0)) * defOffset.z + defOffset.xy), defRadius));
        highp vec3 dPV = normalize(defLocalToWorld * vec3(faceWarp((vxy + vec2(0.0,duP)) * defOffset.z + defOffset.xy), defRadius));
        highp vec3 dMV = normalize(defLocalToWorld * vec3(faceWarp((vxy + vec2(0.0,-duP)) * defOffset.z + defOffset.xy), defRadius));
        vN = normalize(cross(dPU * (defRadius + hPU) - dMU * (defRadius + hMU),
                             dPV * (defRadius + hPV) - dMV * (defRadius + hMV)));
        if (dot(vN, dir0) < 0.0) vN = -vN;
    } else if (uIsWater < 0.5) {
        highp float duP = 1.0 / ((uGrid > 0.0) ? uGrid : 16.0);
        highp float hPU = 0.0, hMU = 0.0, hPV = 0.0, hMV = 0.0;
        highp vec3 dPU = dir0, dMU = dir0, dPV = dir0, dMV = dir0;
        int fdIters = (uGrid >= 0.0) ? 5 : 1;
        for (int i = 1; i < fdIters; i++) {
            highp vec2 off = (i == 1) ? vec2(duP, 0.0) : (i == 2) ? vec2(-duP, 0.0) : (i == 3) ? vec2(0.0, duP) : vec2(0.0, -duP);
            highp vec2 fl = faceWarp((vxy + off) * defOffset.z + defOffset.xy);
            highp vec3 dd = normalize(defLocalToWorld * vec3(fl, defRadius));
            highp float hh = composeHeight(dd, fl, defOffset.z);
            if (i == 1) { hPU = hh; dPU = dd; } else if (i == 2) { hMU = hh; dMU = dd; }
            else if (i == 3) { hPV = hh; dPV = dd; } else { hMV = hh; dMV = dd; }
        }
        hN0 = composeHeight(dir0, faceLocal, defOffset.z);
        highp vec3 wPU = dPU * (defRadius + hPU), wMU = dMU * (defRadius + hMU);
        highp vec3 wPV = dPV * (defRadius + hPV), wMV = dMV * (defRadius + hMV);
        vN = normalize(cross(wPU - wMU, wPV - wMV));
        if (dot(vN, dir0) < 0.0) vN = -vN;
    }
    highp float h = hN0;
    highp float hR;
    if (uIsWater > 0.5) {
        // Swell displacement: low-frequency seaOctave in tangent plane so waves lap the shore.
        vec3 refAxisW = (abs(dir0.y) < 0.99) ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0);
        vec3 uxW = normalize(cross(refAxisW, dir0));
        vec3 uyW = cross(dir0, uxW);
        const float SWELL_FREQ = 0.016;
        const float SWELL_SPEED = 1.2;
        const float SWELL_AMP = 0.8;
        vec2 swellTime = vec2(oceanTime * SWELL_SPEED * 0.6, oceanTime * SWELL_SPEED * 0.4);
        highp vec2 swellP = vec2(dot(dir0, uxW), dot(dir0, uyW)) * defRadius;
        vec2 d0 = vec2(0.866, 0.5); vec2 d1 = vec2(-0.5, 0.866);
        float swell = (seaOctave((swellP * SWELL_FREQ + d0 * swellTime.x), oceanChoppy) +
                       seaOctave((swellP * SWELL_FREQ + d1 * swellTime.y), oceanChoppy)) * 0.5;
        hR = (swell - 0.5) * SWELL_AMP * oceanAmp;
    } else {
        hR = h;
    }
    highp float skirt = (vertex.z > 0.5 && uIsWater < 0.5) ? max(defOffset.z * 0.06, 30.0 * (uReliefScale > 0.0 ? uReliefScale : 1.0)) : 0.0;

    vH    = hN0;
    vNrm  = (uIsWater > 0.5) ? dir0 : vN;
    vWorld = dir0 * (defRadius + hR - skirt);

    highp vec3 vRel = (dir0 - defCamDir) * defRadius + dir0 * (hR - skirt) - defCamDir * defCamAlt;
    gl_Position = defViewProjNoEye * vec4(vRel, 1.0);
    vTexRel = vRel;

    if (uIsWater < 0.5) {
        highp vec3 w0 = dir0 * 450.0;
        vTexWarp = vec3(snoise3(w0), snoise3(w0 + vec3(7.3)), snoise3(w0 + vec3(23.9))) * 1.2;
    } else {
        vTexWarp = vec3(0.0);
    }

    vGrid    = vertex.xy;
    vLevel   = defOffset.w;
    vClimate = hpf0;
}
#endif

#ifdef _FRAGMENT_
in highp vec3 vWorld;   // W7: MUST match the VS highp vWorld (world pos ~6.4e6 m) -- precision-mismatched varyings fail to link
in vec3 vTexWarp;       // VS-computed texture domain warp (halved freqs); applied once in the splat block
in highp float vH;      // W7: match VS highp vH (signed metres)
in highp vec3 vNrm;     // W8: world-space analytic normal from the VS (matches VS highp out). Sole lit normal.

in float vLevel;          // quad LOD level (patches view)
in vec2  vGrid;            // per-quad parametric mesh coord (wireframe overlay)
in highp vec3 vTexRel;     // W7: camera-relative world pos for the precise (jitter-free) texture UV
uniform highp vec3 uTexCamFrac; // camWorld reduced mod uTexTileM per-axis on the CPU (fp64) -> small + precise; world UV = (vTexRel + uTexCamFrac)/uTexTileM (the dropped integer tiles are REPEAT-wrap-invariant)
uniform float uWireframe;  // 1 = overlay the mesh grid lines (window/cam wireframe toggle)
uniform float uFsCheap;    // GPU-TIMER VS/FS attribution: 1 = short-circuit the FS to a trivial
                           // constant color immediately after the per-vertex normal is read, so a
                           // timed cheap frame measures VS+raster cost only; (full - cheap) = FS cost.
uniform float uWaterDbg;   // WATER-FS DEBUG READOUT (live via window.__waterDbg): 1=refrCol 2=refl
                           // 3=fogT(grey) 4=waterBody 5=spec*NoL*0.5 -- isolates which term is white.
                           // Set by window.__gpuTimer's measure frame (gl-render). 0 in normal render.
uniform highp sampler2D uSceneDepth;  // full-res scene DEPTH texture; the half-res water FS samples it
uniform float uOccludeDepth;          // for per-pixel terrain occlusion. 1 = occlude (half-res water pass).
uniform float uDepthOnly;             // 1 = the shared-depth water re-draw pass (colorMask off): skip all shading ALU after the discard test, since the color is masked anyway.
uniform float uWaterVisProbe;         // 1 = the water-visibility probe draw: SKIP the vH>1 land discard. The probe is a pure
                                      // rasterization-coverage query (depthFunc ALWAYS, depthMask off, double-sided) and must only
                                      // ever OVER-report visibility -- a false negative here gates the whole water color pipeline
                                      // off (live-witnessed 2026-08-23: shoreline poses returned 0 samples for 90% of frames because
                                      // the depth test, the vH discard and the winding EACH independently zeroed the coarse mesh's
                                      // samples, leaving the ocean unrendered = "ground swallowing the water/land" report).
in vec4 vClimate;     // (seaBias, elevAmp, temp, humid) interpolated -- FS does NOT sample the HPF texture
layout(location=0) out vec4 fragColor;

uniform vec3 sunDir;       // world-space sun direction (normalized) -- unit, mediump-safe
uniform int displayMode;   // 0 = lit, 1 = raw normals, 2 = material albedo (unlit)
uniform highp vec3 camWorld;     // W7: world-space camera position ~6.4e6 m -> highp
uniform highp float terrainR;    // W7: sphere radius ~6.4e6 m -> highp
uniform sampler2D uSceneTex;   // snapshot of terrain pass color buffer for refraction
uniform vec2 uResolution;      // viewport size in pixels (for uSceneTex UV)

// HOST-ENGINE SHADOW BRIDGE (terrain-shadow-bridge-never-wired): the host (spoint) owns a real
// THREE.js DirectionalLight shadow map (PCFShadowMap) that terrain -- raw WebGL2 outside THREE's
// mesh graph -- can never receive through WebGLShadowMap. The host threads its live shadow depth
// texture + light-space matrix in here per frame (see gl-render.js's shadowInfo upload, called from
// planet-orchestrator.js's frame() 9th arg, built by TerrainBackdrop.js's _buildShadowInfo). uShadowMap
// is a sampler2DShadow bound to THREE's shadow.map.depthTexture, which THREE itself configures with
// COMPARE_REF_TO_TEXTURE for PCFShadowMap -- sampling it here returns the SAME hardware-filtered
// 0..1 visibility THREE's own onBeforeCompile shadow shader would compute, no re-implementation of
// PCF taps needed. uHasShadow gates the whole path off (no shadow yet this frame / host has no
// caster) so the function degrades to fully-lit, matching the pre-bridge look exactly.
uniform highp float uHasShadow;      // 0 = no shadow data this frame (fail-open to fully lit)
uniform highp mat4  uShadowMatrix;   // world -> shadow-map [0,1] NDC (THREE's light.shadow.matrix)
uniform highp sampler2DShadow uShadowMap;  // THREE's shadow.map.depthTexture (COMPARE_REF_TO_TEXTURE)
uniform highp float uShadowBias;     // THREE's light.shadow.bias (applied host-side into the matrix's z already; kept for an optional manual nudge)
uniform highp float uShadowTexelSize; // 1/mapSize, for the 3x3 PCF offset taps

// Returns sun visibility [0,1] at a world-space point: 1 = fully lit, 0 = fully shadowed. Fails
// open to 1.0 (no darkening) whenever the host has no valid shadow data this frame, or the point
// falls outside the shadow camera's frustum (its own fixed +-60m player-following box, far=200 --
// see spoint's updateSunShadow) -- a terrain fragment far from the shadow camera's tracked region
// must never be wrongly darkened by an out-of-range projection.
highp float sampleHostShadow(highp vec3 worldPos) {
    if (uHasShadow < 0.5) return 1.0;
    highp vec4 sc = uShadowMatrix * vec4(worldPos, 1.0);
    if (sc.w <= 0.0) return 1.0;
    highp vec3 proj = sc.xyz / sc.w;                 // already in [0,1] NDC (THREE's shadow matrix bakes the 0.5*x+0.5 bias)
    if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z < 0.0 || proj.z > 1.0) return 1.0;
    // 4-tap rotated-square PCF (perf-terrain-shadow-pcf-4tap, 2026-07-07): terrain shadows are cast by
    // distant tree canopies and viewed from further away / shallower angles than a close-up character
    // shadow, so the softer/coarser edge from 4 taps is not visually distinguishable in practice, while
    // this terrain fragment shader runs the tap loop over every visible terrain pixel within the shadow
    // camera's tracked box each frame (the dominant new per-pixel cost the host-shadow bridge added).
    // Offsets sit at 1.5x texel (not 1.0x) on a rotated square so the 4-sample footprint still spans
    // roughly the same area a 3x3 kernel would, approximating its softness with 4/9ths the texture
    // traffic; each tap is still a hardware COMPARE_REF_TO_TEXTURE fetch (0/1 or linear-filtered).
    // Was a full 3x3 (9-tap) kernel -- see git history for that version if a quality regression is
    // ever reported and a partial reversion (e.g. a 5-tap cross) is warranted.
    highp float sum = 0.0;
    sum += texture(uShadowMap, vec3(proj.xy + vec2(-1.5, -0.5) * uShadowTexelSize, proj.z));
    sum += texture(uShadowMap, vec3(proj.xy + vec2( 0.5, -1.5) * uShadowTexelSize, proj.z));
    sum += texture(uShadowMap, vec3(proj.xy + vec2( 1.5,  0.5) * uShadowTexelSize, proj.z));
    sum += texture(uShadowMap, vec3(proj.xy + vec2(-0.5,  1.5) * uShadowTexelSize, proj.z));
    return sum * 0.25;
}
// Returns height h at point p for use in FD normal computation.
// SEA_AMP_M: physical wave amplitude in world-metres; slope = amp/wavelength must be visible.
// At SEA_FREQ=0.0004 wavelength=15km; 200m amplitude gives max slope ~0.08 (visible from orbit).
// oStart = runtime first-octave index (FXC-safe: the loop bound is a runtime int, NEVER a constant,
// so ANGLE/FXC cannot unroll+reorder it -- the AGENTS hard rule for VS fractal loops). Up close the
// lowest octaves are the ~314m/~165m swells whose per-pixel slope contribution is negligible at the
// deck, so the close-up water path passes oStart>0 to SKIP them. The skipped octaves only advance
// freq/amp/choppy (no seaOctave call) so the remaining octaves are bit-identical to the full sum's
// tail. All 3 FD taps in oceanWaveSlope pass the SAME oStart -> the FD errors cancel exactly.
float seaHeight(highp vec2 p, highp float t, int oStart, int oEnd) {
    // terrainR=6360m: wavelength = 2pi/SEA_FREQ; 0.02 -> ~314m swells (~1/20 planet)
    const float SEA_FREQ  = 0.2;
    const float SEA_SPEED = 2.4;
    const float SEA_AMP_M = 0.6;   // HF amplitude halved
    float freq    = SEA_FREQ;
    float amp     = oceanAmp * SEA_AMP_M;
    float choppy  = oceanChoppy;
    vec2 seaTime  = vec2(t * SEA_SPEED * 0.6, t * SEA_SPEED * 0.4);
    float h = 0.0;
    // oStart..oEnd is a RUNTIME window (FXC-safe -- the loop bound stays the constant 8, the octave is
    // skipped by a runtime compare so freq/amp advance identically and ANGLE cannot unroll+reorder).
    // oEnd caps the HIGH-FREQ octaves: their amp is amp0*0.45^i so octaves 6,7 add <1% and go sub-pixel
    // at any real view distance -- the per-pixel FS wave normal drops them with no visible change.
    for (int i = 0; i < 8; i++) {
        if (i >= oStart && i < oEnd) {
            float a  = float(i) * 1.57079633;
            float sa = sin(a), ca = cos(a);
            vec2 duv = mat2(ca, -sa, sa, ca) * p;
            float ts = 1.0 - 0.08 * float(i);
            h += seaOctave((duv + seaTime * ts) * freq, choppy) * amp;
        }
        freq   *= 1.9;
        amp    *= 0.45;
        choppy  = mix(choppy, 1.0, 0.3);
    }
    return h;
}
// Returns tangent-plane slope via finite differences -- same method as reference getNormal(). All 3 FD
// taps run the SAME runtime [oStart,oEnd) window so the FD errors cancel exactly (no fake slope).
vec2 oceanWaveSlope(highp vec2 p, highp float t, int oStart, int oEnd) {
    const float eps = 0.25;   // FD step ~1/63 of base wavelength (16m/63=0.25m)
    float h  = seaHeight(p,            t, oStart, oEnd);
    float hx = seaHeight(p + vec2(eps, 0.0), t, oStart, oEnd);
    float hy = seaHeight(p + vec2(0.0, eps), t, oStart, oEnd);
    return vec2(hx - h, hy - h) / eps;
}
// Low-frequency slope: two crossed octaves with different directions for overlapping swell pattern.
vec2 oceanWaveSlopeLF(highp vec2 p, highp float t) {
    const float SEA_FREQ_LF = 0.16;
    const float SEA_SPEED   = 2.4;
    const float SEA_AMP_M   = 0.6;
    const float eps = 1.25;
    // Two direction vectors 60 degrees apart for crossing swell pattern
    vec2 d0 = vec2(0.866, 0.5);
    vec2 d1 = vec2(-0.5, 0.866);
    float s0 = t * SEA_SPEED * 0.6;
    float s1 = t * SEA_SPEED * 0.4;
    float h  = (seaOctave((p * SEA_FREQ_LF + d0 * s0), oceanChoppy) +
                seaOctave((p * SEA_FREQ_LF + d1 * s1), oceanChoppy)) * oceanAmp * SEA_AMP_M * 0.5;
    float hx = (seaOctave(((p + vec2(eps,0.0)) * SEA_FREQ_LF + d0 * s0), oceanChoppy) +
                seaOctave(((p + vec2(eps,0.0)) * SEA_FREQ_LF + d1 * s1), oceanChoppy)) * oceanAmp * SEA_AMP_M * 0.5;
    float hy = (seaOctave(((p + vec2(0.0,eps)) * SEA_FREQ_LF + d0 * s0), oceanChoppy) +
                seaOctave(((p + vec2(0.0,eps)) * SEA_FREQ_LF + d1 * s1), oceanChoppy)) * oceanAmp * SEA_AMP_M * 0.5;
    return vec2(hx - h, hy - h) / eps;
}

// Procedural height+slope material ramp (placeholder until the OrthoProducer lands):
// water / shore / lowland / grass / rock / snow by signed elevation, with rock on steep
// slopes. World-continuous (pure function of h + slope) so it has no per-tile seam.
// LIVE-ADJUSTABLE biome ramp (full-adjustability via window.__gen.biome). Each color + band edge
// is a uniform defaulting to its tuned literal when the JS global is unset (no behaviour change
// until edited). bcXxx = band colors; bandEdgesLo=(shore->lowland end, lowland->grass end),
// bandEdgesHi=(rock start, rock end), snowEdges=(snow start, snow end), seaDepthM, slopeRock=(lo,hi).
uniform vec3 bcDeepSea, bcSea, bcShore, bcLowland, bcGrass, bcRock, bcSnow;
uniform vec2 bandEdgesLo;   // (lowland-blend end, grass-blend end)
uniform vec2 bandEdgesHi;   // (rock start, rock end)
uniform vec2 snowEdges;     // (snow start, snow end)
uniform float seaDepthM;    // depth (m) over which sea->deepSea
uniform vec2 slopeRock;     // (lo, hi) slope range that forces rock
uniform float uAoAmt;       // canyon/cliff ambient-occlusion strength (window.__aoAmt; 1.0 default)
// (uBiomeBandBias removed 2026-06-18 -- dead with the anchor-point biome system.)
// REAL-WORLD LOOK overhaul uniforms (2026-06-05 workflow wxb9n2907) -- all window.__gen-overridable.
uniform vec3  uOceanDeep;    // deep open-ocean color (near-black navy)            [0.008,0.025,0.06]
uniform vec3  uOceanShallow; // shallow-water turquoise (first metres)             [0.07,0.22,0.26]
uniform vec3  uOceanK;       // per-channel Beer-Lambert extinction (kR>>kG>>kB)   [0.030,0.012,0.0045]
// (uBiomeSat + uBiomeClimate removed 2026-06-18 -- dead with the anchor-point biome system removal.)
uniform float uVariationAmt; // intra-biome value mottle amplitude (+/-)           0.08
uniform float uHazeMul;      // aerial-perspective strength multiplier (1 = full haze, 0 = none)
// LIVE A/B ISOLATION TOGGLES (window.__rockBump / __chroma / __strata, default 1). Multiply each material
// detail layer so the user can flip one to 0 and see which layer produces the close-up uv scramble.
uniform float uFlatNormal;   // 1=force the SMOOTH analytic normal (nBand), bypassing the raw cross(dFdx,dFdy) geometric normal that scrambles on steep deck faces (A/B isolation)
uniform float uSkyFill;      // sky-ambient fill weight (was implicit 1.0)         0.45
uniform float uTerminatorGlow;// sunset reddening strength at the grazing terminator 0.5
uniform float uNightLights;  // night/shadow fill intensity (lift dark areas, not black)  1.0
uniform float uNightFloor;   // unlit-hemisphere brightness floor (dim, not black) 0.05
uniform float uTermWidth;    // terminator half-width (wider=softer twilight)      0.25
uniform float uExposure;     // pre-tonemap exposure (was 1.25)                    1.0
uniform float uLookSat;      // post-ACES saturation Look (>1 = more saturated)    1.15
uniform float uLookContrast; // post-ACES contrast Look (>1 = more contrast)       1.08
// SURFACE PHOTO-TEXTURES (user 2026-06-10 'use the textures in textures/, calculate normals from
// displacement'). Two 1024x1024x4 sampler2DArrays loaded at runtime (gl-render loadSurfaceTextures):
// uSurfAlb = sRGB color (RGB) + displacement (A), uSurfNrm = tangent normal xy (RG, 0.5-biased) +
// displacement (B). Layers: 0=grass 1=rock 2=sand 3=snow. The normals are Sobel-derived from the
// displacement JPGs at load (wrap edges, JS). SUPERSEDES the 2026-06-01e 'no detail texturing'
// directive by explicit user request. Triplanar-sampled in the FS, blended by the existing material
// gates (slopeRock / snowEdges / climate), height(displacement)-sharpened, distance-faded by pxWorld.
uniform sampler2DArray uSurfAlb;
uniform sampler2DArray uSurfNrm;
uniform float uHasSurfTex;   // 1 once the arrays are uploaded (0 = procedural-only fallback)
uniform float uTexTileM;     // world metres per texture repeat (__texTile, default 2400 -- user: 24m read as noise/rock, '100x bigger')
uniform float uTexNrmK;      // texture detail-normal strength (__texNrmK, default 0.5; keep <=1: scramble lesson)
uniform float uTexMix;       // texture albedo blend amount (__texMix, default 0.85; 0 = off)
uniform float uTexWarp;      // anti-repetition domain-warp amplitude (__texWarp, default 1.0)
uniform float uReliefShade;  // gentle-slope relief-shading exaggeration (__reliefShade, default 1.7; 1 = off)
uniform float uTexPhoto;     // raw photo-color fraction (__texPhoto, default 0 = full macro tint; user: patch must match the shade it replaces)
uniform float uTexPhotoNear; // near-field MATERIAL-IDENTITY fraction (__texPhotoNear, default 0.45): up close the
                             // photo keeps its OWN hue at the macro's luminance, so ground reads clearly as
                             // grass/rock/sand/snow (user 2026-06-12 'light brown patches that need to be either
                             // grass or sand but is neither' -- the full macro tint painted biome browns/greys onto
                             // every layer). Far field returns to the shade-matched macro (no distance pop).
uniform vec4 uSurfMeanL;     // per-layer mean linear luminance of the photo color (loader-computed; shade-match divisor)
uniform float uBiomeTint;    // how much macro biome/climate color is mixed OVER the texture (__biomeTint, default 0.22; was a hard 0.5 = washed the photo color out). 0 = pure texture color, 1 = pure biome.
uniform float uTexBright;    // overall ground brightness multiplier (__texBright, default 0.92)
uniform float uTexSat;       // texture chroma saturation around its own luma (__texSat, default 1.0; >1 = more vivid photo color)
uniform float uXSoft;        // crossover fade HALF-WIDTH (__xSoft): the A/B crossover is ONE constant-width directional fade smoothstep(-uXSoft,uXSoft,s); the width is CONSTANT (warp shifts POSITION only, never width -- user 2026-06-17). Bigger = softer/wider fade, smaller = crisper.
uniform float uXFinger;      // near-field displacement FINGERING amount (__xFinger): how hard the two materials interlock by their relief up close; fades to 0 with distance (crossFade) so the mipped/far crossover is a SIMPLE fade with NO band (user 2026-06-17 'a simple fade from the over texture to the under texture').
uniform float uOrdPush;      // overlay-priority POSITIONAL push (__ordPush): the covering material (higher ord: sand<rock<grass<snow) expands over the covered one by shifting the fade's 50% point -- a position shift, NOT a width change. Makes grass cover the grass<->sand band so it never reads as green sand (user 2026-06-17).
uniform float uBiomeWarp;    // biome-distribution domain-warp amount (__biomeWarp, default 1.0): warps the climate temp/humid that selects the biome so biome regions FINGER/break up instead of wide blobs (user 2026-06-16). 0 = off (raw anchor blobs), >1 = more broken up.
uniform float uNrmLow;       // low-octave normal strength (__nrmLow, default 1.0) -- scales the two lower octaves of the rock normal pyramid
uniform float uXFade0;       // crossover-displacement fade start metres (__xFade0, default 3000)
uniform float uXFade1;       // crossover-displacement fade end metres (__xFade1, default 9000) -- high-octave disp gone past here (anti-sparkle)
uniform float uTriSharp;     // triplanar weight exponent (__triSharp, default 4.0) -- higher = harder dominant-axis pick (8+ flips at 45deg), lower = softer blend
uniform float uNrmFade0;     // normal-texture fade start metres (__nrmFade0, default 40000)
uniform float uNrmFade1;     // normal-texture fade end metres (__nrmFade1, default 80000) -- texture normals gone past here
uniform float uBandWarp;     // snow/rock/BEACH biome-band warp amplitude metres (__bandWarp, default 1100) -- one low-freq field warps every elevation-keyed biome edge incl. the beach
uniform float uBeachWidth;   // grass<->beach crossover band WIDTH (x beachTop) (__beachWidth, default 5.0) -- wide = the displacement maps interlock a broad fingered shoreline (narrow = a thin line)
uniform float uTexFar0;      // splat->biome far-fade start (pxWorld metres) (__texFar0, default 0 = full splat from camera)
uniform float uTexFar1;      // splat->biome far-fade end (pxWorld metres) (__texFar1, default 26000) -- splat gone to macro biome past here
uniform float uOctFar0;      // coarse-albedo-octave blend start (pxWorld metres) (__octFar0, default 200) -- fine octave pure below this
uniform float uOctFar1;      // coarse-albedo-octave blend end (pxWorld metres) (__octFar1, default 2000) -- fully coarse octave albedo above this
// MATERIAL-BOUNDARY DITHER REVERTED (2026-06-05): the threshold-perturbation approach (matEdgeNoise on
// the smoothstep input) produced HARD-EDGED PATCHES + a UV-like grid on uniform grass/snow (user live
// eye: 'hard uninteresting lines between rocky/grass', 'grass/snow UV problem') -- perturbing a near-
// binary boundary snaps material across wide areas instead of softly interfingering, and the high-freq
// octave aliased on bright materials. Reverted to the clean smoothstep boundaries; a non-aliasing
// 'interesting boundary' technique (e.g. a wide soft transition material band) is a separate future task.
vec3 terrainAlbedo(float h, float slope, float rockSlope, highp vec3 worldPos, highp vec3 nwp, float pxW) {   // highp: nwp=normalize(worldPos) passed in from caller (already computed in terrainAlbedoClimate)
    // DISTANCE-WIDENED rock-slope band (user 2026-06-14 'hard edge to rock slopes at a distance'): the
    // close-up height-blend doesn't run far off, so the macro slope gate showed a hard edge. Widen its
    // upper threshold with distance so the rock->grass slope boundary fades softly when it's far.
    float rockWiden = smoothstep(20.0, 500.0, pxW) * 0.20;
    vec3 c;
    if (h < 0.0) {
        // SEABED: depth-keyed albedo so terrain relief reads through the water column.
        // Shallow shelf (0 -> -200m): sandy/bright. Mid-depth (-200 -> -1500m): darker silt.
        // Deep basin (-1500m+): near-black basalt. Steep faces key to rock at any depth.
        float depthT = clamp(-h / 300.0, 0.0, 1.0);    // h in rendered metres; seabed ≈ 0-500m after 8x amplify, 300m = full colour transition
        vec3 bcShelf  = bcShore;                          // sandy shelf
        vec3 bcSilt   = vec3(0.12, 0.11, 0.09);          // dark silt / sediment
        vec3 bcBasalt = vec3(0.06, 0.06, 0.07);          // deep basalt floor
        vec3 bedBase  = mix(bcShelf, bcSilt,   smoothstep(0.0, 0.5, depthT));
        bedBase       = mix(bedBase, bcBasalt, smoothstep(0.5, 1.0, depthT));
        c = mix(bedBase, bcRock, smoothstep(slopeRock.x, slopeRock.y, rockSlope));
    } else {
        c = mix(bcShore, bcLowland, smoothstep(0.0, bandEdgesLo.x, h));
        c = mix(c, bcGrass, smoothstep(bandEdgesLo.x, bandEdgesLo.y, h));
        // BIOME-BAND WARP (user 2026-06-14 'hard bands between biomes ... make that more interesting'):
        // the single-octave warp made smooth wavy contour lines. A 3-octave domain-warped field breaks
        // the rock/snow boundaries into irregular fingers + patches (height-keyed band wobbles +/-~1.1km
        // over 1-15km scales), so the biome edge reads natural, not a band. highp dir for the lattice.
        highp vec3 bww = nwp + vec3(snoise3(nwp * 130.0)) * 0.004;   // domain warp -> non-parallel fingers (nwp = normalize(worldPos), passed from caller)
        float bandWarp = (snoise3(bww * 210.0) * 1.0 + snoise3(bww * 560.0) * 0.5 + snoise3(bww * 1450.0) * 0.25) * uBandWarp;
        c = mix(c, bcRock, smoothstep(bandEdgesHi.x + bandWarp, bandEdgesHi.y + bandWarp, h));
        c = mix(c, bcSnow, smoothstep(snowEdges.x + bandWarp, snowEdges.y + bandWarp, h));
        c = mix(c, bcRock, smoothstep(slopeRock.x, slopeRock.y + rockWiden, rockSlope) * step(0.0, h));
        // OLD PROCEDURAL GREY ROCKFACE DELETED (max-speed sweep 2026-06-10, user 'replace the original
        // rock completely'): the photo-rock splat owns steep faces; the 3-tap grey fBm fallback is gone.
    }
    return c;
}
// CLIMATE-BIASED albedo: the anchor field carries latitude-driven temp + humidity (now
// SHIPPED). Drive Earth-like biome COLOR on land from climate so warm+wet reads lush green,
// warm+dry reads arid tan, and cold reads pale/desaturated with an earlier snow line --
// instead of a pure height ramp. Sea unchanged. temp,humid in [0,1].
// BIOME PALETTE: each biome a DISTINCT recognizable color, blended by soft temp/humidity
// thresholds (CLI-validated 7 distinct classes, entropy 2.59).
// World-continuous (pure fn of climate -> seam-safe).
// biomeColor() (climate temp/humid -> biome material palette) REMOVED with the anchor-point biome system
// (user 2026-06-18 'get rid of anchorpoint biomes to make the system more performant'). It was called only
// from the uBiomeClimate-gated FS block (default off -> branch-skipped), so removing it is visually neutral
// and cuts the dead FS source. The elevation-band material (grass/rock/snow by height+slope+splat) is the
// land look. (biomeClassColor below is the DEBUGVIEW-only displayMode-9 climate map, unrelated to render cost.)
// DISCRETE biome class -> a flat distinct color (for the biome-MAP diagnostic displayMode 9 +
// __biomeAt). Hard argmax of the same climate axes biomeColor blends, so the witness can COUNT
// contiguous biome regions instead of reading a continuous gradient. Water/ice keyed on h/temp.
// Returns a flat saturated key color per class (NOT the naturalistic biomeColor palette).
#ifdef _DEBUGVIEW_
vec3 biomeClassColor(float temp, float humid, float h) {
    if (h < 0.0) return vec3(0.10, 0.30, 0.75);                 // OCEAN (blue)
    if (temp < 0.30) return vec3(0.55, 0.60, 0.55);            // TUNDRA (grey-green) -- climate ICE/snow class REMOVED (user 2026-06-18): very-cold maps to tundra, not white; elevation snow only
    // SWAMP: warm + very-wet + low ground (h<120m proxy) -> murky teal key color (distinct class).
    if (temp > 0.50 && humid > 0.66 && h >= 0.0 && h < 120.0) return vec3(0.20, 0.40, 0.30);
    bool warm = temp > 0.52;
    if (warm && humid < 0.22) return vec3(0.95, 0.80, 0.30);    // DESERT (yellow)
    if (warm && humid < 0.42) return vec3(0.80, 0.70, 0.20);    // SAVANNA (gold)
    if (humid > 0.66) return warm ? vec3(0.00,0.55,0.10)        // RAINFOREST (bright green)
                                  : vec3(0.05,0.25,0.12);       // TAIGA (dark green)
    if (humid > 0.45) return vec3(0.20, 0.65, 0.25);            // FOREST (green)
    return vec3(0.55, 0.70, 0.30);                              // MEADOW/STEPPE (yellow-green)
}
// RIVER NETWORK: thin continuous water lines on land. A world-dir-continuous ridged-noise
// network: riverField = 1 - |fBm(worldDir)| peaks (->1) along the zero-crossing ridge lines of
// the fBm, giving a connected branching channel pattern. Thresholded thin near 1.0 -> the river
// line. Pure fn of worldPos (vWorld) -> C0 seam-safe across tiles AND faces by construction (no
// per-tile state). Gated to land below a snowline + present in wet/temperate regions, scarce in
// desert (dry). `px` is a sub-pixel fade so the thin line does not alias/shimmer at altitude.
// NOT an elevation incision (FS albedo only) -> zero CLOD/seam/LOD-uniformity risk.
float riverMask(vec3 worldPos, float h, float temp, float humid, float px) {
    if (h <= 0.0) return 0.0;
    // ONE FRACTAL (user 2026-06-02, same fix as canyon): the FS used its OWN inline loop over
    // worldPos/terrainR (= dir*(1+h/R), elevation-shifted) -> a different field/position/resolution
    // than the VS riverCarveM. Call the IDENTICAL riverRidgeField the VS carve uses, at
    // normalize(worldPos) (== radial dir), so the FS river network coincides with the carved geometry.
    // Inline river ridge field: ridged FBM at a river-network frequency, output remapped 0..1.
    highp vec3 rdir = normalize(worldPos);
    float ridge = value_ridged_fbm_rot(rdir * 280.0, 0.55, 6, 1.0, 1.5) * 0.5 + 0.5;  // 0..1, ->1 on channel network
    // thin the network to a line. MEASURED ridge distribution (diag-river.mjs nodejs-2037):
    // p90=0.858 p97=0.903 max=0.985; areaFrac>0.90 = 3.4%, >0.88 = 6%. Center the line band at
    // ~0.90 (lo 0.88 -> hi 0.935) for ~4-6% believable drainage density -- the old 0.92->0.985
    // band selected <2% and was invisible. Width grows slightly with px so the line stays >=1px.
    float wid = clamp(px * 0.0008, 0.0, 0.04);
    float line = smoothstep(0.875 - wid, 0.935, ridge);
    // climate gate: rivers in wet/temperate land, sparse in desert (very dry+warm) and on ice.
    float wetGate = smoothstep(0.30, 0.55, humid);          // need some moisture
    float notFrozen = smoothstep(0.20, 0.34, temp);          // not polar ice
    // NO altFade (user 2026-06-02: 'river field is fading in instead of integrated'). The line WIDTH
    // already grows with px (wid above) so the channel stays >=1px and AA-safe at every distance
    // WITHOUT vanishing -> the river network is a permanent part of the field, not a distance overlay.
    return line * wetGate * notFrozen;
}

// CANYONS (user-named): deep narrow incised gorges cutting ELEVATED ARID plateaus. Distinct from
// rivers (canyons = dry+deep+arid biome; rivers = water+shallow+wet). World-dir-continuous ridged
// network like riverMask but NARROWER + a HIGHER threshold (sparser, sharper) and a DIFFERENT
// noise phase so canyons and rivers do not coincide. Gated to ELEVATED (h>250m) DRY+WARM regions.
// FS-albedo only (no elevation incision) -> zero CLOD/seam risk, AA via pxWorld. Returns line + a
// depth term for strata banding. out_depth = how deep into the gorge (0 rim -> 1 floor), for strata.
float canyonMask(vec3 worldPos, float h, float temp, float humid, float px, out float depth) {
    depth = 0.0;
    // gentle elevation gate: canyons want SOME relief above the lowland, not only rare high
    // plateaus (h>250 made them NEVER appear -- witnessed canyonFieldFrac 0). Fade in over 60..200m.
    // ONE FRACTAL (user 2026-06-02: 'canyon field shows two different resolutions, expected the same
    // fractal'). The FS used its OWN inline loop over worldPos/terrainR (= dir*(1+h/R), elevation-
    // SHIFTED off the VS sample) -> a different field/position/resolution than the VS carve. Now call
    // the IDENTICAL canyonRidgeField the VS canyonCarveM uses, at normalize(worldPos) (== the radial
    // dir), so the FS network coincides EXACTLY with the carved geometry. Same field, no elevation shift.
    // Inline canyon ridge field: same ridged FBM but different phase/frequency so it doesn't coincide with rivers.
    highp vec3 cdir = normalize(worldPos);
    float ridge = value_ridged_fbm_rot(cdir * 310.0 + vec3(47.3, 81.1, 23.7), 0.55, 6, 1.0, 1.5) * 0.5 + 0.5;
    float wid = clamp(px * 0.0006, 0.0, 0.03);                 // narrower than rivers
    float line = smoothstep(0.875 - wid, 0.94, ridge);        // ~river-density threshold so they appear
    depth = smoothstep(0.875, 0.95, ridge);                   // deeper toward the channel centre
    // NO altFade (user: canyon field fading instead of integrated). wid grows with px -> >=1px AA at
    // every distance without vanishing; the canyon network is permanent, not a distance overlay.
    return line * step(0.0, h);
}
#endif   // biomeClassColor/riverMask/canyonMask: DEBUGVIEW-only (called solely from displayMode blocks) -- excluded from render FS cold-compile (FS-2, workflow w4y1bnrqc)

vec3 terrainAlbedoClimate(float h, float slope, float rockSlope, float temp, float humid, highp vec3 worldPos, float pxWorld) {   // highp: worldPos feeds normalize(worldPos)*freq noise UVs (mottle/river/canyon ridge) -- mediump scrambles the lattice up close
    highp vec3 nwp = normalize(worldPos);   // hoisted: reused by terrainAlbedo + mottle + river/canyon ridge dirs
    vec3 c = terrainAlbedo(h, slope, rockSlope, worldPos, nwp, pxWorld);
    if (h < 0.0) {
        // SEA ICE: near-polar ocean (very cold) freezes to white-blue pack ice. Pure fn of the
        // anchor temp -> seam-safe; the soft threshold gives an irregular (not hard-zonal) margin.
        float seaIce = 1.0 - smoothstep(0.12, 0.22, temp);
        return mix(c, vec3(0.82, 0.88, 0.94), seaIce * 0.9);
    }
    // biome weight: full on gentle lowland, fading where rock/snow/steep takes over.
    // VEG SLOPE GATE (user 2026-06-14 'hard line of light grass around rocks'): the gate faded veg over
    // `slope` (the macro, gentler) while the ROCK blend keys off `rockSlope` (the raw geometric normal,
    // steeper). The two thresholds didn't coincide, so on the approach to a rock the dark biome-green
    // vegetation dropped out a beat BEFORE the rock arrived -> a light bare-grass ring. Key veg off the
    // SAME rockSlope so vegetation fades EXACTLY as rock fades in -> grass stays dark right up to the
    // rock with no light gap, and veg is 0 wherever rock is full (no biome-green bleeding onto rock).
    // BREAK THE VEG RING (user 2026-06-14 'hard separation between dark and light grass, a hard circle
    // around mountains'): veg dropped at a clean elevation+slope threshold -> a dark->light grass ring
    // circling every peak. Warp BOTH thresholds with ONE cheap noise (~2-3km) so the dark/light grass
    // boundary fingers irregularly instead of a contour ring. (Reuses the hoisted nwp; one snoise3.)
    // ANCHOR-POINT CLIMATE-BIOME MATERIAL REMOVED (user 2026-06-18 'get rid of anchorpoint biomes to make
    // the system more performant'). uBiomeClimate defaulted to 0, so this whole climate temp/humid ->
    // biomeColor tint block was already BRANCH-SKIPPED at runtime -- removing it is VISUALLY NEUTRAL (the
    // elevation-band material + the splat carry the entire look) and drops the dead FS source from the
    // compile. The climate temp/humid still drives rivers/canyons/sand/dunes; biomeClassColor displayMode-9
    // stays as a climate-distribution diagnostic (DEBUGVIEW-only, zero render cost).
    // INTRA-BIOME VALUE MOTTLE (Real-World Look): real terrain is never one flat color per biome --
    // soil/moisture/vegetation patchiness mottles albedo. Reuse the snoise3 already evaluated for
    // cliffRock (same normalize(worldPos)*~1k pattern, no new octave) as a VALUE-only multiplier (NO
    // hue jitter, low 1200 freq -> does NOT reintroduce the per-pixel swamp moire the pipeline removed).
    float mot = snoise3(nwp * 120.0);   // detail-tex-rockface-canyon-10x: *1200->*120 (~10x larger mottle features, user 2026-06-06)
    c *= (1.0 + uVariationAmt * mot);
    // (CLIMATE snow REMOVED with the anchor-point biomes -- it was *uBiomeClimate (=0) so it contributed
    // nothing yet still computed; elevation snow stays via the snowEdges height bands + the splat snowHi.)
    // BEACH BAND (user 2026-06-11 'all land at the level of the ocean should be beach -- the grass
    // must stop and become sand, which continues under the water'): below uBeachTopM the biome/
    // grass/snow color yields to shore sand (the same bcShore the underwater bed starts from, so the
    // material is continuous through the waterline). Steep coastal cliffs keep their rock.
    // WIDENED TRANSITION (2026-06-13): 0.6->0.3 softens the grass-sand boundary from 12m to 21m.
    float beachM = (1.0 - smoothstep(uBeachTopM * 0.3, uBeachTopM, h))
                 * (1.0 - smoothstep(slopeRock.x, slopeRock.y, rockSlope));
    c = mix(c, bcShore, beachM);
    // INLAND WATER -- COLOUR GATED BY THE CARVE FIELD (alignment + no-fade fix, browser-2705/2699).
    // The water colour now keys off the SAME world-dir carve fields that cut the geometry
    // (lakeCarveM/riverCarveM at this fragment's world dir), NOT an independent h-smoothstep. So the
    // blue sits EXACTLY in the carved bowl/channel at every LOD (color == depression by construction)
    // -- this kills both the 'lakes fade on approach' (was gated by h<70 which shifts with relief)
    // and the 'rivers/lakes out of alignment with their elevation' defects. Climate still gates WHICH
    // regions get water (wet for lakes/rivers) but no longer the SHAPE (the carve owns the shape).
    // INLAND WATER + INCISION COLOUR -- UNIFIED: keyed off the carve masks computed ONCE in the VS
    // and INTERPOLATED here (vLakeWet/vRiverWet/vCanyonDep), NOT re-evaluated per-pixel. This removes
    // the separate per-pixel ridged-field evaluation that aliased into biome-localized moire (user
    // 2026-06-01h: 'UV issue only in patches where the biome is like that'). The VS already folded
    // the climate gates into the masks, so the FS just applies colour.
    float warmth = smoothstep(0.48, 0.62, temp);
    // SWAMP: only the WARM + VERY-WET end of a lake basin reads murky olive-teal. The humid gate
    // (0.66-0.86) was lost in the unify rewrite -> the teal leaked into merely-warm wet land (user:
    // 'faint teal area, moire'); restored here. The per-pixel mottle snoise3 (freq 900) was the last
    // per-pixel noise field -> it gave the teal its grain; REMOVED (flat swamp colour, no aliasing).
    // INLAND WATER ALBEDO IS NOT SET HERE ANYMORE. Lakes and rivers are WATER (user 2026-06-01i:
    // 'use the same content as the sealevel to draw because its also water'), so they are shaded by
    // the SAME ocean water branch (fresnel + sun glint + depth tint) post-lighting, gated on the
    // submerged-depth varying vWaterDepth so the color lands EXACTLY on the flat water plane (lines
    // up with the carve) instead of being painted over the whole basin including the dry shoulder.
    // The terrain albedo (rock/biome) stays under the water and shows through where shallow.
    // CLIFF STRATA BLOCK DELETED (max-speed sweep 2026-06-10): the photo-rock splat owns cliff
    // appearance; the 2-tap bedding-warp strata fallback is gone (-2 snoise3, ~35 LOC).
    // DUNES: warm sand on the desert floor, keyed off the interpolated dune-crest mask (vDuneCrest =
    // crest * duneSand gate from the VS). Crest sun-bleached lighter, trough ochre.
    // Dune crest removed with old carve system; vDuneCrest is now always 0.
    // PERLIN-EVERYWHERE OVERLAY (user 2026-06-10 'pale + featureless in some areas -- add perlin
    // everywhere and overlay the other noises'): 3-octave value fbm over ALL materials (biome, rock,
    // snow, sand) so no area is ever a flat color. World-dir keyed (no camera scroll -- the lesson of
    // the deleted 2026-06-01 detail texturing), value-only (no hue shift), and each octave fades out
    // via a pxWorld Nyquist gate before its features go sub-pixel (no orbit speckle, no leopard band).
    {
        highp vec3 od = nwp;
        float ov = 0.0, oa = 0.0;
        float fq = 75.0, am = 1.0;                 // octaves: ~84km / 17km (user 2026-06-23: 3->2 octaves, cuts fine detail snoise3 calls, ~0.8ms speedup + 33 quads)
        int fdOcts = 2;
        for (int o = 0; o < fdOcts; o++) {
            float wl = 40000000.0 * uReliefScale / fq;   // feature wavelength (m) ~ 2*pi*R/fq. *uReliefScale = SCALE-INVARIANT: the octave is angular so its WORLD wavelength scales with R; the 40000000 Earth-circumference ref must scale too or the Nyquist sub-pixel fade engages at the wrong relative distance at the small-radius scale (2026-06-18 real-size).
            float nyq = 1.0 - smoothstep(wl * 0.03, wl * 0.12, pxWorld);   // fade before sub-pixel
            ov += am * nyq * snoise3(od * fq + vec3(float(o) * 7.3));
            oa += am;
            fq *= 5.0; am *= 0.6;
        }
        // ALBEDO amplitude decoupled from the elevation lever (user 2026-06-11 'normals seem wrongly
        // calculated, not on the sides of slopes' -- witnessed: at the user-tuned uDetailOverlay 6 the
        // albedo term was *= 1 +/- 0.54, painting slope-INDEPENDENT dark braids over every material
        // that read as misplaced shading / rock bands). 0.09 -> 0.02: lever 6 now gives +/-12% value
        // variation (anti-featureless, as asked) while the +/-180m ELEVATION term keeps the full lever.
        c *= 1.0 + 0.02 * (ov / max(oa, 1e-3));
    }
    return c;
}

// ---- DETAIL MATERIAL (1-2 texel/pixel from anchor biome weights). The coarse biome+ortho
// PER-PIXEL DETAIL TEXTURING REMOVED (user 2026-06-01e: "get rid of any detail texturing, we only
// want one fractal"). The old FS grain (detailMaterial/detailNormal/grainH + the dnoise lattice)
// was a SECOND high-frequency source on top of the VS height fractal -- it caused the moire and the
// scroll/jump (its lattice was keyed on the moving camera). Deleted entirely. The single terrain
// fractal is the VS world-dir height field; closeup detail comes from the mesh subdividing into a
// denser sample of THAT one field, never a per-pixel fake-relief texture.

// SURFACE PHOTO-TEXTURE triplanar tap: 3 axis-projected samples of one array layer, blended by
// the pow-softened |n| weights (same continuous-projection rationale as the rock bump biplanar --
// no hard dominant-axis flip). wt = world pos in tile units (fragment-anchored, fp32-precise).
const float TEX_LOD_BIAS = 0.0;   // 1.0->0.0 (2026-06-15): the +1 bias selected a COARSER mip -> bigger texels -> the diamond/cross-hatch magnification grid (shot.png) got worse. 0 = sharpest mip (finest available detail up close).
vec4 surfTriTap(sampler2DArray sm, highp vec3 wt, vec3 bw, float layer) {
    return texture(sm, vec3(wt.y, wt.z, layer), TEX_LOD_BIAS) * bw.x
         + texture(sm, vec3(wt.x, wt.z, layer), TEX_LOD_BIAS) * bw.y
         + texture(sm, vec3(wt.x, wt.y, layer), TEX_LOD_BIAS) * bw.z;
}
// WORLD-SPACE triplanar normal perturbation (UDN) -- THE 'math issue causing both' (user 2026-06-11):
// the old path triplanar-BLENDED the per-plane RG tangent normals, then applied the blend in the
// single radial (ux,uy) frame -- but each projection plane has its own tangent axes, so the blended
// RG was rotated arbitrarily vs the frame it was applied in (bumps lit from wrong directions =
// statistical darkening + shading off the slope sides), and the apply site SUBTRACTED an
// already-negated Sobel normal (double negation = lit from the wrong side outright). Here each
// plane's RG perturbs along that plane's own world axes, sign-flipped to push outward, blended by
// the same weights -- a world-space delta added to the lit normal. Same 3 taps.
vec3 surfTriNrm(sampler2DArray sm, highp vec3 wt, vec3 bw, float layer, vec3 sn) {
    vec2 px = texture(sm, vec3(wt.y, wt.z, layer), TEX_LOD_BIAS).rg * 2.0 - 1.0;   // X plane: in-plane axes (Y,Z)
    vec2 py = texture(sm, vec3(wt.x, wt.z, layer), TEX_LOD_BIAS).rg * 2.0 - 1.0;   // Y plane: in-plane axes (X,Z)
    vec2 pz = texture(sm, vec3(wt.x, wt.y, layer), TEX_LOD_BIAS).rg * 2.0 - 1.0;   // Z plane: in-plane axes (X,Y) -- same LOD bias as albedo so normal+color mip together (else normal detail at a different scale = 'normals next to where they should')
    return vec3(0.0, px.x, px.y) * (bw.x * sign(sn.x))
         + vec3(py.x, 0.0, py.y) * (bw.y * sign(sn.y))
         + vec3(pz.x, pz.y, 0.0) * (bw.z * sign(sn.z));
}

// shared water day/night + ACES tonemap chain (used by underwater + surface water paths)
vec3 waterTonemapped(vec3 wcol, vec3 uz) {
    float macroMuW = dot(uz, sunDir);
    float dayShadeW = mix(uNightFloor, 1.0, smoothstep(-uTermWidth, uTermWidth, macroMuW));
    vec3 cW = wcol * dayShadeW * uExposure;
    vec3 mappedW = clamp((cW * (2.51 * cW + 0.03)) / (cW * (2.43 * cW + 0.59) + 0.14), 0.0, 1.0);
    float lumW = dot(mappedW, vec3(0.2126, 0.7152, 0.0722));
    mappedW = mix(vec3(lumW), mappedW, uLookSat);
    return clamp((mappedW - 0.5) * uLookContrast + 0.5, 0.0, 1.0);
}

void main() {
    // PER-FRAGMENT tangent frame from vWorld (the sphere position, C0 across quad edges):
    // uz = up (radial), ux = normalize(Y x uz), uy = uz x ux. Continuous across adjacent quads
    // -> no per-quad shading-baseline seam.
    highp vec3 nWorld = normalize(vWorld);   // computed ONCE, reused for the tangent up + every band/noise/lighting dir (perf: was ~7 separate normalize() calls)
    vec3 uz = nWorld;
    // AUDIT FIX 2026-06-06 (audit-tangent-frame-degeneracy): the reference axis was a FIXED vec3(0,1,0),
    // so cross(Y, uz) -> zero-length (NaN normal) wherever uz is parallel to Y -- i.e. the +Y/-Y cube
    // faces and the poles, exactly 'wrong normals in the wrong places'. Pick the world axis LEAST
    // parallel to uz so the cross product is always well-conditioned (|ux| ~ 1) everywhere on the sphere.
    vec3 refAxis = (abs(uz.y) < 0.99) ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 ux = normalize(cross(refAxis, uz));
    vec3 uy = cross(uz, ux);
    // ---- WATER-SURFACE PASS (uIsWater=1, the separate ocean surface at sea level). vH carries the
    // TRUE seabed elevation under this fragment -> depthM = the water column. Shade as animated
    // water (Gerstner normal + fresnel sky + sun glint + foam) and ALPHA-blend over the already-
    // rendered seabed: alpha rises with optical depth (Beer-Lambert) + fresnel/foam, so shallows
    // show the sand through real transparency and deep basins read opaque navy. Early return --
    // none of the terrain material/atmosphere work below runs for water fragments.
    if (uIsWater > 0.5) {
        // TEMP DIAGNOSTIC (__passProbe-gated via window.__waterDbg, remove after the
        // black-band investigation): mode 10 = constant magenta as the FIRST statement,
        // before any discard/math -> distinguishes "no water fragment rasterizes in the
        // band" from "fragment runs and outputs black". Witnessed repro: site (707,707),
        // gy=-21.63, dy=2 (camAlt~-0.9), hard black horizon band, all pass toggles neutral.
        if (uWaterDbg > 9.5) { fragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
        if (vH > 1.0 && uWaterVisProbe < 0.5) {
            // TEMP DIAGNOSTIC: mode 11 = magenta INSTEAD of discarding -> reveals whether
            // vH>1-dropped fragments cover the band (coarse interpolated vH wrong at grazing).
            if (uWaterDbg > 10.5) { fragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
            discard;                       // surface under land: depth test culls it anyway; discard kills shoreline shimmer
        }
        // Shared-depth re-draw pass: colorMask is already off (nothing written reads fragColor), so
        // skip the whole water shading ALU below (Gerstner slope taps, fresnel/sky/glint/foam) --
        // the rasterizer's depth write already happened via the discard test above, independent of
        // fragColor. Preserves the exact discard set -> bit-identical depth output.
        if (uDepthOnly > 0.5) { fragColor = vec4(0.0); return; }
        // FS DEPTH OCCLUSION (NVIDIA-portable): the half-res water has NO hardware depth test (the cross-
        // size depth blit was broken on NVIDIA/ANGLE). Sample the full-res scene depth at this fragment's
        // screen position and DISCARD where terrain is in front. gl_FragCoord.z and the sampled scene
        // depth share the same projection -> compare directly. Bias avoids waterline z-fighting.
        if (uOccludeDepth > 0.5) {
            float sceneZ = texture(uSceneDepth, gl_FragCoord.xy / uResolution).r;
            if (gl_FragCoord.z > sceneZ + 0.00003) discard;   // terrain in front -> water occluded
        }
        // UNDERWATER WATER SURFACE (camera below sea level): render the surface from below as
        // opaque deep blue with Gerstner wave animation. No sky reflection, no Fresnel (TIR from
        // below = mostly opaque deep water), no Beer-Lambert (there is no seabed above the camera).
        if (uUnderwater > 0.5) {
            highp vec3 wOriginW = floor(camWorld / 1024.0) * 1024.0;
            highp vec2 wpW = vec2(dot(vWorld - wOriginW, ux), dot(vWorld - wOriginW, uy));
            vec2 slopeW = oceanWaveSlope(wpW, oceanTime, 0, 8);   // full octaves: planet-scale swells from below
            highp float wDistW = length(camWorld - vWorld);
            // no distance fade -- planet-scale swells visible from orbit
            vec3 wn = normalize(uz - ux * slopeW.x - uy * slopeW.y);
            vec3 viewW = normalize(camWorld - vWorld);
            float ndl = max(dot(wn, sunDir), 0.0);
            // Sunlight attenuated through the water column; deep blue ambient
            float depthAtten = exp(-max(0.0, terrainR - length(camWorld)) * 0.0005);
            vec3 sunUnder = vec3(1.0, 0.6, 0.3) * depthAtten * ndl;
            vec3 deepBlue = vec3(0.005, 0.06, 0.18);
            vec3 waveBright = vec3(0.0, 0.02, 0.06) * length(slopeW);
            vec3 wcol = deepBlue + sunUnder * 0.4 + waveBright;
            // SNELL'S WINDOW (user 2026-06-14 'no water surface visible from underneath'): looking UP, the
            // surface is a bright window to the sky within the critical angle (near-vertical view) and a
            // dark total-internal-reflection mirror at grazing angles. upness = how vertical the view->
            // surface ray is; brighten toward the refracted sky + a sun disc inside the window.
            float upness = abs(dot(viewW, wn));
            float snell = smoothstep(0.50, 0.82, upness);
            vec3 skyWindow = vec3(0.40, 0.60, 0.85) * (0.5 + 0.9 * ndl);
            wcol = mix(wcol, skyWindow, snell * 0.85);
            float sunw = pow(max(dot(viewW, sunDir), 0.0), 180.0);   // sun seen through the window
            wcol += vec3(1.0, 0.92, 0.70) * sunw * (0.4 + 0.6 * snell);
            vec3 mappedW = clamp((wcol * (2.51 * wcol + 0.03)) / (wcol * (2.43 * wcol + 0.59) + 0.14), 0.0, 1.0);
            fragColor = vec4(pow(mappedW, vec3(1.0 / 2.2)), 1.0);
            return;
        }
        // RAYMARCH: find where the camera ray meets the animated wave surface.
        // Only needed within 120m (nearFade zone); beyond that use flat mesh hit.
        vec3 rayDir = normalize(vWorld - camWorld);
        highp vec3 wOriginW = floor(camWorld / 1024.0) * 1024.0;
        highp float flatDist = length(vWorld - camWorld);
        highp vec2 wpFlat = vec2(dot(vWorld - wOriginW, ux), dot(vWorld - wOriginW, uy));

        // Quick estimate: if the flat mesh hit is already beyond the near zone, skip raymarch.
        highp float tHit;
        highp vec2 wpW;
        if (flatDist > 140.0) {
            // Far fragment: use flat mesh intersection directly (no raymarch cost)
            tHit = flatDist;
            wpW  = wpFlat;
        } else {
            // Near fragment: seed + bisect raymarch. BOUNDED-QUANT the bisect count by distance: the
            // wave-surface hit precision only needs to be sub-pixel, and a far-near fragment (closer to
            // the 140m cutoff) needs far fewer refinement steps than one at the deck. bisectN ramps 5->2
            // over 30..140m via a RUNTIME int (FXC-safe, never a constant bound on a fractal-bearing
            // loop). Visual-neutral (the extra steps changed tHit by <<1px out there) -- saves up to 3
            // seaHeight(8-octave) evals per far-near water fragment. Seed stays 5 (must not miss the hit).
            int bisectN = int(clamp(5.0 - (flatDist - 30.0) / 36.0, 2.0, 5.0));
            highp float tMax = flatDist * 1.5;
            highp float tMin = 0.0;
            highp float stepT = tMax / 5.0;
            for (int i = 1; i <= 5; i++) {
                highp float ti = stepT * float(i);
                highp vec3 pi = camWorld + rayDir * ti;
                highp vec2 wpi = vec2(dot(pi - wOriginW, ux), dot(pi - wOriginW, uy));
                float rayH = dot(pi - uz * terrainR, uz);
                float fi = rayH - seaHeight(wpi, oceanTime, 0, 8);
                if (fi < 0.0) { tMin = ti - stepT; tMax = ti; break; }
            }
            for (int i = 0; i < 5; i++) {
                if (i >= bisectN) break;   // runtime-bounded refinement
                highp float tMid = (tMin + tMax) * 0.5;
                highp vec3 pm = camWorld + rayDir * tMid;
                highp vec2 wpm = vec2(dot(pm - wOriginW, ux), dot(pm - wOriginW, uy));
                float rayH = dot(pm - uz * terrainR, uz);
                float fi = rayH - seaHeight(wpm, oceanTime, 0, 8);
                if (fi < 0.0) tMax = tMid; else tMin = tMid;
            }
            tHit = (tMin + tMax) * 0.5;
            highp vec3 wHit = camWorld + rayDir * tHit;
            wpW = vec2(dot(wHit - wOriginW, ux), dot(wHit - wOriginW, uy));
        }
        highp float wDistW = tHit;
        // LOD crossfade: near = raymarched HF slope, far = LF slope at flat mesh hit (no raymarch)
        float nearFade = clamp(1.0 - wDistW / 120.0, 0.0, 1.0);
        float farFade  = clamp((wDistW - 30.0) / 60.0, 0.0, 1.0) * clamp(1.0 - wDistW / 300.0, 0.0, 1.0);
        // CLOSE-UP LF OCTAVE DROP: slopeNear only contributes within ~120m (nearFade), where the two
        // lowest seaHeight octaves (~314m,~165m swells) are far larger than the footprint and add
        // negligible per-pixel slope -- the LF swell is already carried by slopeFar. Skip them via a
        // RUNTIME int (FXC-safe, never a constant bound): oStart ramps to 2 as you approach the deck,
        // dropping 2 of 8 octaves x3 FD taps = 6 fewer seaOctave calls per near water fragment.
        int nearOStart = int(clamp(2.0 - wDistW / 40.0, 0.0, 2.0));
        // HIGH-FREQ OCTAVE CAP by distance: the finest 2 wave octaves go sub-pixel as the fragment
        // recedes, so ramp oEnd 8->6 over 0..120m. Combined with nearOStart this runs ~4 octaves at the
        // deck vs 8 -> roughly halves the per-pixel wave-normal cost (the measured 8.4ms water FS-ALU).
        int nearOEnd = int(clamp(8.0 - wDistW / 60.0, 6.0, 8.0));
        vec2 slopeNear = oceanWaveSlope(wpW, oceanTime, nearOStart, nearOEnd) * nearFade;
        vec2 slopeFar  = oceanWaveSlopeLF(wpFlat, oceanTime) * farFade;
        float depthAmp = clamp(-vH / 6.0, 0.0, 1.0);  // HF waves flatten in shallows
        vec2 slopeW = slopeNear * depthAmp + slopeFar;
        vec3 wn = normalize(uz - ux * slopeW.x - uy * slopeW.y);

        vec3  viewW   = -rayDir;

        // Procedural sky (used by both reflection and distance fog)
        vec3 skyZenith  = vec3(0.15, 0.45, 0.95);
        vec3 skyHorizon = vec3(0.55, 0.75, 1.00);

        // ---- reflection ----
        vec3 reflDir = reflect(-viewW, wn);
        float reflY  = dot(reflDir, uz);
        float reflSun = max(dot(reflDir, sunDir), 0.0);
        float hh = pow(1.0 - max(reflY, 0.0), 3.0);
        vec3 skyRefl = mix(skyZenith, skyHorizon, hh)
                     + vec3(1.0, 0.9, 0.7) * pow(reflSun, 8.0) * 0.8
                     + vec3(1.0, 0.85, 0.55) * pow(reflSun, 16.0) * 0.4;
        // SSR REMOVED (perf 2026-06-24): the screen-space terrain reflection (a defViewProjNoEye matrix
        // mult + a 2nd uSceneTex tap PER WATER PIXEL) was barely visible -- the reflective sheen reads
        // from the procedural skyRefl, which is what the depth/grazing-gated reflW blends in. Dropping
        // the SSR saves a per-pixel matrix transform + texture fetch on the measured 8.4ms water FS-ALU
        // with no visible change to the sheen. (Re-add SSR only if mirror-sharp terrain reflections are
        // ever wanted on calm water.)
        vec3 refl = skyRefl;

        // PERFORMANCE-MODE: flat low-specular water (no per-pixel GGX BRDF -- Dggx/G/Fresnel-pow5
        // was expensive full-microfacet gloss redundant with the tight sun-glint term below; Fortnite
        // Performance Mode explicitly runs low-specular flat-shaded water, so cut the specular BRDF
        // and keep only NoV/NoL needed by the existing absorption + glint terms.
        float NoV  = max(dot(wn, viewW), 0.0);
        float NoL  = max(dot(wn, sunDir), 0.0);

        // ---- water body: refraction + PURE VIEW-GEOMETRY scatter (NO ELEVATION DATA) ----
        // USER HARD RULE 2026-06-24: 'its still setting the transparency of the water surface based on
        // elevation data, making windows that look wrong at an angle -- we must not use elevation data
        // to splat the water.' The previous model keyed opacity off waterDepth = max(-vH,0) = the COARSE
        // interpolated seabed elevation, so the scatter stepped per water-mesh cell into 'windows' that
        // looked wrong at an angle. vH is BANNED from the water look. Opacity is now a pure function of
        // the view ray's geometric optical path through water -- view distance to the surface (wDistW)
        // lengthened by the grazing factor (1/NoV). No seabed depth, no scene-depth texture needed
        // (uSceneTex is RGBA8 colour only). The result is a smooth, elevation-independent scatter.
        // DEEP-WATER COLOUR MODEL from the wX3BRf reference (user 2026-06-24 'take deep-water cues'):
        // per-channel RED-FIRST absorption (sigma high in R, low in B) so the refracted seabed loses red
        // first and the body builds a teal->deep-blue gradient WITH path length -- richer than a flat
        // tint mix. deepColor is the scatter target the water tends toward as the column deepens.
        // Red-first absorption tuned to SEE THE SEABED in shallow water (user 2026-06-24 'shallow water,
        // can barely see the terrain underneath' -- the prior sigma 0.35 + 4m floor over-absorbed and
        // crushed the sand to opaque teal). Moderate sigma so shallow water lightly tints the sand
        // (reads as water, seabed clearly visible through it) and only DEEP water builds toward deepColor.
        vec3  sigma      = vec3(0.09, 0.028, 0.012);   // gentler red-first absorption: shallow water stays
                                                        // CLEAR/transparent over a longer range (seabed
                                                        // shows through), the teal veil builds slowly with
                                                        // depth -- user 2026-06-24 'not quite transparent'
        vec3  deepColor  = vec3(0.04, 0.34, 0.52);     // deep ocean scatter: BRIGHTER + more saturated
                                                        // blue so the scatter version reads as a vivid
                                                        // sunlit sea, not a near-black teal (user 2026-06-24
                                                        // 'we dont see the scatter version' -- the old dark
                                                        // (0.02,0.16,0.24) target rendered deep water almost
                                                        // black so the scatter never read as blue).
        vec3  scatterCol = deepColor;                   // used for open-ocean / empty-refraction pixels
        vec2  screenUV  = gl_FragCoord.xy / uResolution;
        // REFRACTION DISTANCE CUT (~300m): beyond ~300m view distance the refraction distortion is lost
        // in scatter anyway, so fade the uSceneTex offset to 0 over 250..350m (skips the meaningful
        // distortion math on far water; far water reads scatter regardless).
        float refrW   = 1.0 - smoothstep(250.0, 350.0, wDistW);
        // DOUBLED refraction intensity: slope-driven UV displacement 0.36 (2x the prior 0.18, 4.5x the
        // original 0.08) so the bent seabed reads strongly at the coast. Faded by refrW for far water.
        vec2  refrUV  = clamp(screenUV + slopeW * (0.36 * refrW * NoV), vec2(0.001), vec2(0.999));
        vec3  refrCol = texture(uSceneTex, refrUV).rgb;
        // Black pixels = no terrain behind (open ocean, GL clear) -> use scatterCol directly
        float isEmpty = step(dot(refrCol, vec3(1.0)), 0.01);
        refrCol       = mix(refrCol, scatterCol, isEmpty);
        // WATER-COLUMN OPTICAL PATH (user 2026-06-24, refined): the scatter must = how much WATER the
        // VIEW RAY crosses, which is the water DEPTH below this fragment lengthened by the view angle --
        // NOT the camera-to-surface distance wDistW (that scales with ALTITUDE, so at 1.9km looking down
        // at 3m-deep water it read 100% opaque milk). depth = max(-vH,0) is the genuine water column
        // thickness; /NoV lengthens it at grazing angles (a steep look through clear shallow water whose
        // line of sight continues into the deep section crosses a long water path -> that deep background
        // fogs OUT, which is exactly what the user wants). The earlier 'windows at an angle' came from a
        // HARD depth threshold (smoothstep) stepping per coarse water-mesh cell; this is a SMOOTH Beer
        // exponential with NO thresholds, so depth varies continuously -> no stepped windows. The fog is
        // strong (short e-fold) so the underwater background is fully obscured at depth/distance.
        // wX3BRf REFERENCE ABSORPTION (user 2026-06-24): the refracted seabed was reading as pale
        // 'milky' sand because almost no water tint sat over it. Apply per-channel RED-FIRST Beer
        // absorption so even shallow water visibly tints the bright sand toward teal (=reads as sand
        // SEEN UNDERWATER, transparent yet unmistakably water) and deeper water builds toward deepColor.
        //   absorb  = exp(-sigma * path)   -> red drops first (sigma.r >> sigma.b)
        //   body    = refrCol*absorb + deepColor*(1-absorb)   (ref: scatter = deepColor*(1-absorb))
        // path = water-column depth /NoV (view-angle lengthened), elevation-derived but SMOOTH (no
        // thresholds -> no cell windows). sigma scaled so ~3-8m shallow already reads teal, deep -> blue.
        float depthW     = max(-vH, 0.0);
        // NO surface-skin floor (user 2026-06-24 'grey and milky, not really transparent'): a +1m floor
        // forced ~15% deepColor veil over even glass-shallow water = the flat grey film sitting on top of
        // the seabed. With floor 0, shallow water -> absorb~1 -> waterBody is pure (dimmed) refraction =
        // the seabed shows THROUGH, transparent; the deepColor veil only builds as real depth accrues.
        float pathM      = depthW / max(NoV, 0.10);        // metres of water along the view ray (no floor)
        vec3  absorb     = exp(-sigma * pathM);            // per-channel transmittance through the column
        // DIM THE SUBMERGED SEABED: light seen through water is attenuated (down-welling + up-welling
        // path), so the refracted seabed is genuinely DARKER than the same ground in air. Without this
        // the bright sand (~0.69 linear) sits in the exact midtone band the gamma curve blows out to
        // pale white -- THE tint the user kept seeing was the per-water tonemap washing the bright
        // refraction, NOT a colour-model fault (debug: waterBody was a fine teal, lit came out pale).
        // 0.55 keeps the seabed clearly visible (refractive) but out of the wash-zone -> reads underwater.
        // WET SAND IS DARK (user 2026-06-24 'it would be better if it darkened the sand rather than
        // making it lighter cause wet sand is dark'): submerged ground is wet -> markedly darker than
        // the dry albedo. Darken the refracted seabed hard (0.4) so the shallows read as wet dark sand
        // seen through clear water (transparent), not a pale light film. Deeper water still builds the
        // teal scatter veil on top. This is what makes shallow water read transparent yet unmistakably wet.
        // EDGE TRANSPARENCY = SEE THE WET-DARK SEABED, NOT a bright film (user 2026-06-24, corrected):
        // the earlier edgeDim ramp BRIGHTENED the seabed toward 0.9 at the waterline -> waterBody came
        // out BRIGHTER than the raw seabed (158 vs 141 witnessed) -> the tonemap washed it pale white =
        // 'washed out and white instead of transparent'. Transparency at the shallow edge is NOT a
        // brighter seabed -- it is the WET-DARK seabed (0.40) shown through CLEAR water (absorb->1 at
        // depth 0 means zero teal veil, so the bare dark seabed reads through = see-through). Keep the
        // seabed dim a constant wet-dark; the shallow band already reads transparent because the
        // deepColor scatter builds only with depth.
        vec3  waterBody  = refrCol * 0.40 * absorb + deepColor * (1.0 - absorb);
        float fogT       = 1.0 - dot(absorb, vec3(0.333)); // scalar 'how scattered' for the reflection weight below
        // REFLECTIVE SKY SHEEN = the 'scatter version' the user means (a reflective SURFACE look, not the
        // underwater colour). It is GATED OFF in shallow water (must stay transparent/refractive there --
        // user 2026-06-24 'that sheen must not affect shallow water') and ramps in only over DEEP water at
        // grazing angles: reflW = Fresnel(grazing) * fogT(depth gate, ~0 shallow -> 1 deep). Uses the real
        // sky/SSR reflection (refl), only lightly tinted, so deep/angled water reads as a reflective sea
        // surface -- this is the look that was missing (the prior 0.08-cap blue-tinted sheen killed it).
        float fresnel    = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
        float reflW      = fresnel * fogT;               // fogT=0 in shallows -> NO sheen on clear water
        vec3  reflTinted = mix(scatterCol, refl, 0.7);   // mostly real sky reflection, slight sea tint
        vec3  base       = mix(waterBody, reflTinted, reflW);
        // Sun glint: must be a TIGHT specular highlight, NOT a broad wash. pow(reflSun,3)*0.3 added
        // ~0.19 to EVERY water fragment facing roughly sunward (witnessed: debug mode 8 = (49,49,49)
        // over the whole 'milky' patch) -> that broad additive white WAS the milkiness, on top of an
        // already-refractive waterBody (mode 4 = a fine teal (141,180,157)). Tighten the exponent hard
        // (3 -> 64) so glint is a small bright glance off the sun only, and drop the gain, so the water
        // body (refraction + absorption) is what you actually see across the surface.
        float glint = pow(reflSun, 64.0) * 0.5;
        vec3  wcol  = base + vec3(glint);

        // DEBUG READOUT: output a chosen intermediate (linear, no tonemap) to find the white term.
        if (uWaterDbg > 0.5) {
            vec3 dbg = vec3(0.0);
            if (uWaterDbg < 1.5)      dbg = refrCol;                 // 1: refracted scene tex
            else if (uWaterDbg < 2.5) dbg = refl;                   // 2: reflection (sky/SSR)
            else if (uWaterDbg < 3.5) dbg = vec3(clamp(fogT,0.0,1.0)); // 3: scatter scalar (grey)
            else if (uWaterDbg < 4.5) dbg = waterBody;              // 4: absorbed body
            else if (uWaterDbg < 5.5) dbg = vec3(glint);            // 5: glint contribution (spec removed, PERFORMANCE-MODE)
            else if (uWaterDbg < 6.5) dbg = base;                   // 6: post-reflection base
            else if (uWaterDbg < 7.5) dbg = vec3(reflW);            // 7: reflection weight (grey)
            else if (uWaterDbg < 8.5) dbg = vec3(glint);            // 8: glint additive
            else                      dbg = vec3(wDistW / (wDistW + max(terrainR * 1.0, 1.0)));  // 9: distance-fog weight fogW (grey)
            fragColor = vec4(clamp(dbg, 0.0, 1.0), 1.0);
            return;
        }

        // ---- foam: WAVE-CREST / BREAKING only (NOT a shoreline band) ----
        // The old foamEnv keyed a white band on |depth - 0.04|, which PEAKS exactly at the waterline
        // -> the entire shallow coast washed to opaque white (the 'shallow ends nearly opaque white'
        // bug). Foam is now driven ONLY by steep wave slope (breaking crests) modulated by foam noise,
        // so shallows stay clear/refractive and white appears only on actual crests. depthFoam lets a
        // little extra foam ride the very shallowest breaking water without painting the whole band.
        float foamNoise = seaNoise(wpW * 0.7 + vec2(oceanTime * 0.02, -oceanTime * 0.03));
        vec2  foamUV    = wpW * 4.0 + vec2(oceanTime * 1.4, oceanTime * 0.9);
        float patchMask = mix(foamNoise,
            mix(seaOctave(foamUV, oceanChoppy),
                seaOctave(foamUV * 0.5 + vec2(1.3, 2.7), oceanChoppy * 0.7), 0.4), 0.6);
        float crest     = clamp((length(slopeW) - 0.45) * 2.0, 0.0, 1.0);   // steep wave faces = breaking
        float foamAmt   = clamp(crest * (0.4 + 0.6 * patchMask) * oceanFoam, 0.0, 1.0);
        wcol = mix(wcol, vec3(0.95, 0.98, 1.0), foamAmt * (0.15 + 0.35 * NoL));

        // ---- distance atmosphere fog (Padé, same form as fogT above) ----
        // MILKINESS FIX (user 2026-06-24 'theres a milkyness on the shallow water still'): the old
        // fogScale = terrainR*0.056 (~356m) put the half-fog point at ~356m, so coast water at a few
        // hundred metres view distance picked up ~40-50% of the pale sky-grey wash = the milky cast.
        // Push the half-fog point WAY out (~6km) so near/coast water stays clear; only genuinely
        // distant open ocean toward the horizon hazes. uHazeMul still scales it.
        float fogScale = max(terrainR * 1.0, 1.0);
        float fogW     = wDistW / (wDistW + fogScale);
        float viewY = max(dot(viewW, uz), 0.0);
        wcol = mix(wcol, mix(skyHorizon, skyZenith, viewY) * 0.5, fogW * uHazeMul);

        // ACES tonemapping + gamma. NO *1.2 exposure boost on water (the terrain path uses it, but on
        // water it pushed the body midtone up the gamma curve into a pale milky wash -- witnessed: a
        // teal waterBody (120,167,149) came out pale (209,223,219) purely from *1.2 + ACES + gamma).
        // 1.0 keeps the saturated teal/blue through the tonemap.
        vec3 mappedW = clamp((wcol * (2.51 * wcol + 0.03)) / (wcol * (2.43 * wcol + 0.59) + 0.14), 0.0, 1.0);
        fragColor = vec4(pow(mappedW, vec3(1.0 / 2.2)), 1.0);
        return;
    }
    // W8 SOLE FS LIT NORMAL (P1 data-first, P9 all-distances): vNrm is the per-vertex analytic central-
    // difference normal of the FULL composeHeight field, computed in the VS at a FIXED STABLE world step.
    // Full landform relief (broadShapeM fine octaves + carves) at ALL distances, NO per-pixel jitter, NO
    // fade, NO band-limit. Replaces the cross(dFdx,dFdy) geometric normal (it jumped per-pixel across the
    // bumpy displaced vWorld = the 'completely messed up' scramble) and the bandFadeN macro-only fade
    // (which made fine relief go missing). It is a continuous function of dir0 only -- adjacent fragments
    // get the linearly-interpolated VS value, so it is smooth by construction (no dFdx/dFdy, no fwidth).
    // uFlatNormal kept as a cheap escape hatch: pure sphere normal (uz) for A/B isolation.
    vec3 n = (uFlatNormal > 0.5) ? uz : normalize(mix(vNrm, uz, 0.05));

    // GPU-TIMER VS-ISOLATION: a cheap measurement frame short-circuits the whole per-pixel shade
    // here (uses vNrmPV + vWorld so the VS outputs are not dead-code-eliminated) -> the timed cheap
    // frame is VS+raster only; (full - cheap) attributes the per-pixel FS cost. No effect when 0.
    if (uFsCheap > 0.5) { fragColor = vec4(n * 0.5 + 0.5, 1.0); return; }


    // DIAGNOSTIC displayModes (1,5,6,7,8,9,10,11,12) are gated behind _DEBUGVIEW_ so they are
    // ONLY compiled into the lazily-built DEBUG program (gl-render.js), NOT the hot render program.
    // They added 7132 chars (25%) of translated HLSL to the render FS (browser-1590) -- pure dead
    // weight on the lit path, and the heavy ones pull in riverMask/canyonMask/biomeClassColor which
    // ANGLE then drops from the render program once unreferenced. Cheap albedo modes 2/4 stay live
    // below (one fragColor=albedo each). The render program forces displayMode 0 (lit) effectively.
#ifdef _DEBUGVIEW_
    // displayMode 1 (Normals) MOVED below the splat (user 2026-06-11 'in the normals view we dont
    // see the texture normals'): this early return showed the pre-splat geometric normal, so the
    // displacement-derived texture normals (texDn) were invisible in the debug view. The handler
    // now lives after nLit/texDn assembly and shows the FINAL lit normal.
    // DIAG displayMode 5: land/sea map -- RED where vH>0 (land), BLUE where vH<0 (ocean).
    // Unambiguous test of the elevation sign distribution the render actually samples.
    if (displayMode == 5) { fragColor = (vH < 0.0) ? vec4(0.1,0.2,0.9,1.0) : vec4(0.9,0.3,0.1,1.0); return; }
    // DIAG displayMode 6: encode signed vH into RGB. R = vH/8000 (positive), B =
    // -vH/8000 (negative), G = |vH|/8000. Lets a readback recover the actual elevation
    // magnitude the render samples (independent of the biome ramp / readTile artifact).
    // ELEVATION displayMode 6: HYPSOMETRIC ramp (no hard clip / washed-out tops, user 2026-06-02).
    // Sea = blue (deeper -> darker); land ramps green->tan->brown->grey->white by height over a 0..9km
    // scale, each band a smoothstep so peaks read as distinct grey/white rock, NOT a saturated white
    // blob. >9km (shouldn't occur after the massif tame) just stays at the snow-rock top, no blow-out.
    // ELEVATION displayMode 6: a SCIENTIFIC (non-albedo) data ramp so it reads as an elevation MAP,
    // not naturalistic terrain colour (user 2026-06-02: 'elevation view looks weird like albedo').
    // Sea = dark->mid blue by depth; land = turbo-style cyan->green->yellow->orange->red->white by
    // height (8.5km full scale). Clearly a heatmap, no hard clip.
    if (displayMode == 6) {
        if (vH < 0.0) {
            float dep = clamp(-vH / 6000.0, 0.0, 1.0);
            fragColor = vec4(mix(vec3(0.10,0.55,0.85), vec3(0.0,0.05,0.30), dep), 1.0); return;
        }
        // full scale 11km so even an 8km peak reads RED/MAGENTA, not saturated white; white reserved
        // for the very rare >10.5km tip -> NO broad white-clipped areas (user 2026-06-02: 'fully white').
        float t = clamp(vH / 11000.0, 0.0, 1.0);
        vec3 ec = mix(vec3(0.0,0.80,0.85), vec3(0.10,0.85,0.20), smoothstep(0.0, 0.18, t));   // cyan->green
        ec = mix(ec, vec3(0.95,0.95,0.10), smoothstep(0.18, 0.38, t));    // -> yellow
        ec = mix(ec, vec3(0.95,0.50,0.05), smoothstep(0.38, 0.58, t));    // -> orange
        ec = mix(ec, vec3(0.80,0.10,0.10), smoothstep(0.58, 0.78, t));    // -> red
        ec = mix(ec, vec3(0.55,0.10,0.40), smoothstep(0.78, 0.93, t));    // -> magenta (very high)
        ec = mix(ec, vec3(1.0,1.0,1.0),    smoothstep(0.95, 1.0,  t));    // -> white only at the tip
        fragColor = vec4(ec, 1.0); return;
    }
#endif // _DEBUGVIEW_ (modes 1,5,6)

    float slope = 1.0 - max(0.0, dot(n, uz));   // 0 = flat, ->1 = steep
    // Rock classification keys on TRUE slope = 1-dot(n,uz) from the sole band-limited geometric normal.
    // ROCK-FACE BREAKUP NOISE DELETED (user 2026-06-11, 3-way isolation witness: the braided
    // km-scale rock/grass interfingering at this noise's exact 2.5km wavelength WAS the 'rocky
    // patches' -- fake texture ridges the real terrain (normals-view smooth) does not have, hence
    // 'normals dont match elevation'. The breakup compensated for the over-steep pre-14ad9b8 peak
    // stack; with sane slopes the plain gate is correct.)
    float rockSlope = clamp(slope, 0.0, 1.0);
    // world metres spanned by one screen pixel (MOVED up from ~line 1321 so the close-up signal fade is
    // available to the rock-detail block below). nearFade=1 at the deck (a crag is many px) -> 0 at
    // altitude (the crag goes sub-pixel) so the entire close-up rock signal fades to zero from orbit and
    // the macro path is unchanged there (contrast-on-approach-safe, no orbit shimmer).
    float pxWorld  = max(length(fwidth(vWorld)), 0.001);
    // FADE CEILING 40->180m (live-deck witness 2026-06-05, browser-31: pxWorld is ~5m DIRECTLY below the
    // eye but climbs PAST 40m across the rest of a wide-FOV near-ground frame, so at 40m the close-up rock
    // detail + microAO + chromatic colorVar switched OFF across most of the visible deck -- the realism
    // never reached the FPS range the user actually flies (tens-to-hundreds of m/px). 180m keeps the whole
    // near-ground swath engaged while still fully fading by orbit (8m floor unchanged -> no orbit shimmer).
    // T-8: nearFade removed -- it was dead (vAO uses fsShadeAO directly at all distances per the FADE-IN FIX).
    // PROCEDURAL ROCK DETAIL-NORMAL DELETED (max-speed sweep 2026-06-10): the photo-rock
    // displacement normal owns rock micro-relief; the 3-tap snoise3D biplanar bump is gone.
    // microSlope/microCurv keep their macro defaults for the material/AO consumers below.
    vec3 nLit = n;
    float microSlope = rockSlope;
    // base biome albedo from the coherent height/slope ramp, biased by anchor CLIMATE
    // (latitude-driven temp + humidity) so lowland color sorts by biome (lush/arid/cold).
    vec4 climate = vClimate;   // (seaBias, elevAmp, temp=.z, humid=.w) -- INTERPOLATED from the VS,
                               // NOT a per-pixel HPF texture read (that read showed the HPF texel
                               // grid as UV lines/moire up close). Smooth biome transitions now.
    // (pxWorld is computed up near the slope block now -- moved so nearFade can fade the rock detail.)
    vec3 albedo = terrainAlbedoClimate(vH, slope, microSlope, climate.z, climate.w, vWorld, pxWorld);
    // CURVATURE MICRO-AO REMOVED 2026-06-15 (user 'get rid of the AO code, its costing computation') -- it was
    // already a no-op (microCurv hardcoded 0 -> microAO 1.0); deleted the dead clamp/smoothstep/multiply.
    // CLOSE-UP CHROMA VARIATION DELETED (max-speed sweep 2026-06-10): the photo textures carry
    // near-field color variation now (-2 snoise3/pixel).
    // ---- SURFACE PHOTO-TEXTURE SPLAT (user 2026-06-10): triplanar grass/rock/sand/snow color +
    // displacement-derived normal, blended by the SAME gates the procedural materials use (slope ->
    // rock, snowline+cold -> snow, hot-dry climate / dunes -> sand, else grass) so texture and macro
    // material always agree. Distance-faded by pxWorld; mips + macro biome color carry the far field.
    // MIP-OUT, not fade-out (user 2026-06-11 'instead of fading out the textures, mip them out'):
    // the 15-20km camera-distance fade is GONE -- the splat persists at every distance and the
    // hardware mip chain carries the far field, where the texture averages to its mean color
    // (= the macro shade, by the layer-mean shade-match; rock's raw-photo mean = __surfRockMean).
    vec3 texDn = vec3(0.0);   // photo-texture WORLD-SPACE normal perturbation, applied after uReliefShade
    // SPLAT RUNS UNDERWATER TOO (user 2026-06-11 'continue under water as sand and rock'): the old
    // vH > -2 gate cut the photo textures at the waterline, leaving the seabed flat-colored.
    highp float camDist = length(camWorld - vWorld);
    float texFarFade = 1.0 - smoothstep(uTexFar0 * uReliefScale, uTexFar1 * uReliefScale, pxWorld);   // splat->macro-biome handoff; LIVE LEVER (__texFar0/__texFar1). *uReliefScale = SCALE-INVARIANT: pxWorld (m/px) scales with the planet radius, so the absolute-metre thresholds must too -> the splat fades at the same RELATIVE distance at any planet size (2026-06-18 real-size).
    if (uHasSurfTex > 0.5 && uTexMix > 0.001 && texFarFade > 0.001) {
        vec3 biomeC = albedo;   // SUBTLE landscape color variation (user 2026-06-14 're-introduce ... use existing data, make it subtle'): the macro biome/climate color is ALREADY computed; save it now and mix a touch back after the material override (no new computation).
        // material weights from the existing gates (climate = vClimate: z=temp, w=humid)
        // SAND GATE = THE MACRO DESERT GATE (user 2026-06-11 'all the grassy areas need to have the
        // grass texture'): the old humid<0.42 band splatted SAND across savanna/steppe/meadow-edge
        // regions whose MACRO color is green/gold vegetation (biomeColor only reaches DESERT at
        // smoothstep(0.60,0.85,1-humid)) -- green ground wore the sand photo. One source of truth:
        // reuse the exact macro desert ramp, so the sand texture appears precisely where the macro
        // paints desert; savanna/steppe splat GRASS tinted dry-gold by the layer shade-match.
        float dryHot = smoothstep(0.60, 0.85, 1.0 - climate.w) * smoothstep(0.42, 0.62, climate.z);
        // BEACH (user 2026-06-10 'the beaches should be sand'): the shore profile eases over the
        // first ~60m of elevation, so low gentle land near sea level splats sand regardless of climate.
        // NOISE-VARIED THRESHOLDS (2026-06-13): vTexWarp.x adds an irregular wavy line so the sand
        // doesn't follow a strict elevation contour — reads as a natural beach, not a cut.
        // SHARED biome-band warp pattern (user 2026-06-14: the SAME warping on snow/rock bands AND the
        // beach->land crossover). 2-oct world-dir noise, 1/4 freq (~13km + ~5km waves). Computed once
        // here; the snow/rock bandWarp below reuses warpN. highp dir for the lattice precision.
        highp vec3 bwDir = nWorld;
        // 3-oct (added the ~1km octave, user 2026-06-14 'make biome bands more interesting') -> the
        // texture-splat rock/snow/beach edges break into finer fingers as you approach, not a hard band.
        // HIGHER-FREQ octaves added (user 2026-06-14 'sand-grass crossover too straight; snow warps ok
        // but sand-grass doesnt'): the snow line follows the mountains so it reads wavy, but the beach
        // sits on flat coastal land where the old 12/5/2.3km warp shifted the line UNIFORMLY = still a
        // straight horizontal line. Add ~900m + ~360m octaves so the beach/biome edges wiggle locally.
        // SHARED biome-band warp (user 2026-06-15 'get rid of the beach warp and just use the already-available
        // snow warp on it'): ONE low-frequency world-dir field (~36km + ~15km waves at uBandWarp amplitude)
        // warps EVERY elevation-keyed biome edge -- snow, rock band, AND the beach. Computed here so the beach
        // gate can reuse it; the snow/rock gates below reuse the same bandWarp.
        float bandWarpN = snoise3(bwDir * 1100.0) + 0.5 * snoise3(bwDir * 2580.0);   // ~ +/-1.5
        float bandWarp  = bandWarpN * uBandWarp * 0.25;   // 4x NARROWER biome-crossover scatter band (user 2026-06-16 'the band where we apply noise to scatter biome crossovers should be ~4x narrower'): the elevation-keyed biome edges (snow/rock/beach) wander +/-uBandWarp; quartering it = crisper, less-scattered crossovers. (Scaled here in the cache-busted shader so it reliably reaches a warm tab; window.__bandWarp still scales it.)
        // GRASS<->BEACH: bandWarp shifts the threshold (moves the band); the WIDE crossover span lets the
        // texture DISPLACEMENT height-blend (bSharp below) interlock grass+sand across it (user 2026-06-15
        // 'the beach-to-sand band is super narrow not letting the displacement replacement do much' -- the old
        // 0.5x beachTop band was a ~15m strip = a thin horizontal LINE). uBeachWidth (default 5x) widens it.
        float beach = (1.0 - smoothstep(max(0.0, bandWarp), uBeachTopM * uBeachWidth + max(0.0, bandWarp), vH))
                    * (1.0 - smoothstep(0.18, 0.55, slope));
        // SAND BLEED REMOVED (user 2026-06-17 'our warp should not affect the width of the band'): the old
        // sandBleed = max(0,vTexWarp.y)*0.35*... added SAND WEIGHT by the WARP AMPLITUDE, so the grass<->sand
        // band grew wider where the warp was positive and narrower where it wasn't = the variable width. The
        // beach gate below keeps a CONSTANT vH-width (both smoothstep edges get +bandWarp) so bandWarp shifts
        // the band POSITION but never its WIDTH; that is now the ONLY width source -> uniform band everywhere.
        // SAND REGIONS SUPPRESS ROCK (user 2026-06-10 'rock being used instead of sand'): in
        // deserts/dunes/beaches sand drapes moderate slopes; rock only wins on genuinely steep faces
        // there (gate shifted toward 0.5-0.7 inside sand regions instead of slopeRock 0.28-0.55).
        float sandRegion = clamp(max(dryHot, beach), 0.0, 1.0);
        // SPLAT ROCK GATE DECOUPLED from the macro slopeRock (user 2026-06-11 'a lot of grass turning
        // into rocky patches again'): the user-calibrated global soft blend slopeRock [-0.6,1] puts
        // ~37% ROCK LAYER weight on perfectly flat ground, and the displacement-sharpened top-2
        // crossfade then flips whole displacement blobs to the rock PHOTO on grassland. The macro
        // color blend keeps the calibrated tone; the rock TEXTURE layer needs real slope: floor the
        // splat gate at 0.18 so flat/gentle land splats grass, rock starts on genuine slopes.
        // WIDENED TRANSITION (2026-06-13): srLo+0.2 -> srLo+0.4 so rock/grass and rock/sand/snow
        // boundaries have a wider blend band — the slope gradient between materials is no longer
        // a ~0.2-unit hard step but a ~0.4-unit gradual fade.
        float srLo = max(slopeRock.x, 0.05), srHi = max(slopeRock.y, srLo + 0.25);   // 0.18->0.10->0.05 lo; band +0.35->+0.25 (user 2026-06-14 repeated 'rock face angle more sensitive'): rock fully engages by a GENTLER slope. Stays above truly-flat (rockSlope~0).
        float wRockSlope = smoothstep(mix(srLo, 0.50, sandRegion), mix(srHi, 0.70, sandRegion), rockSlope);
        // bandWarp (the snow/rock/beach band warp) is computed once above the beach gate and reused here.
        float snowHi   = smoothstep(snowEdges.x + bandWarp, snowEdges.y + bandWarp, vH);
        // ROCK BAND leading up to the snow (user 2026-06-14): a rocky belt ~0.4-2.2km below the snow
        // line so high mountains show rock between alpine grass and snow, not grass straight to snow.
        float rockBand = smoothstep(snowEdges.x * 0.7 + bandWarp, snowEdges.x * 0.9 + bandWarp, vH) * (1.0 - snowHi);
        float wRock = max(wRockSlope, rockBand);
        // (SPLAT climate snow + polar/ice climate snow REMOVED with the anchor-point biomes -- both were
        // *uBiomeClimate (=0) so contributed nothing yet still computed; elevation snow stays via snowHi.)
        float wSnow = clamp(snowHi, 0.0, 1.0) * (1.0 - 0.6 * wRock);
        float wSand = sandRegion * (1.0 - wRock) * (1.0 - wSnow) * (1.0 - smoothstep(0.30, 0.70, slope));
        float wGrass = max(1.0 - wRock - wSnow - wSand, 0.0);
        vec4 w4 = vec4(wGrass, wRock, wSand, wSnow);   // layers 0..3 = grass,rock,sand,snow
        // BEACH BAND + UNDERWATER in one mask (user 2026-06-11): sand owns everything below the
        // beach ceiling uBeachTopM -- grass/snow weight folds into sand continuously through h=0 to
        // the seabed, so no vegetation can ever splat at or below the waterline (structural).
        // WIDENED (2026-06-13): 0.6->0.3 to match the macro beach transition, softer fade-out.
        float uwM = 1.0 - smoothstep(uBeachTopM * 0.3, uBeachTopM, vH);
        w4.z += (w4.x + w4.w) * uwM; w4.x *= 1.0 - uwM; w4.w *= 1.0 - uwM;
        w4 /= (w4.x + w4.y + w4.z + w4.w + 1e-4);
        // top-2 layer pick: 4-way blending would cost 24 taps; the gates are spatially near-exclusive,
        // so the two heaviest layers + a displacement-sharpened crossfade carry every transition.
        float lA = 0.0, wA = w4.x, lB = 0.0, wB = -1.0;
        if (w4.y > wA) { lB = lA; wB = wA; lA = 1.0; wA = w4.y; } else if (w4.y > wB) { lB = 1.0; wB = w4.y; }
        if (w4.z > wA) { lB = lA; wB = wA; lA = 2.0; wA = w4.z; } else if (w4.z > wB) { lB = 2.0; wB = w4.z; }
        if (w4.w > wA) { lB = lA; wB = wA; lA = 3.0; wA = w4.w; } else if (w4.w > wB) { lB = 3.0; wB = w4.w; }
        // tile-unit coords, FRAGMENT-ANCHORED snap (the rockO fp32 lesson): raw vWorld/tile loses
        // fp32 precision = visible UV stairs. Snap step = 1024 tiles exactly, so wt jumps by an
        // integer tile count across a snap boundary = identical wrapped sample (REPEAT), no phase
        // reset, camera-independent.
        // PRECISION FIX (2026-06-15 'UV jumps wildly up close'): the ROOT was the absolute vWorld (~6.4e6m)
        // -> fp32 quantizes it to ~0.4m, so the per-pixel world position (and thus the texture UV) re-rounds
        // every frame as the camera moves = the jumping. The GEOMETRY does NOT jump because gl_Position is
        // built from the camera-RELATIVE vRel (the (dir0-defCamDir)*R form, no 6.4e6 intermediate). FIX: build
        // the UV from that SAME precise camera-relative coord. vTexRel = vWorld - camWorld (small near the
        // camera, fp32-precise); uTexCamFrac = camWorld mod uTexTileM from the CPU (fp64). world UV =
        // (vTexRel + uTexCamFrac)/uTexTileM -- the integer tiles dropped from camWorld are exact multiples of
        // uTexTileM so the REPEAT-wrapped sample is identical (world-anchored, seam-free, camera-independent).
        highp vec3 wt = (vTexRel + uTexCamFrac) / uTexTileM;
        // DOMAIN WARP anti-repetition (user 2026-06-10 'distort the textures so they dont look
        // repeated' + 'distort more, waves a bit large'): 2-octave world-dir warp -- ~11km waves at
        // +/-0.6 tile plus ~2.8km waves at +/-0.3 tile -- so repeats both shift AND shear locally;
        // no straight tile lattice survives. World-dir keyed -> seam-safe, camera-independent.
        // uTexWarp (__texWarp) scales the whole warp live.
        // VS-COMPUTED WARP, APPLIED EXACTLY ONCE (2026-06-12): vTexWarp carries the 3-octave halved-
        // frequency warp from the vertex shader (-9 snoise3/pixel). This is the ONLY place the warp
        // touches texture coordinates; every layer tap (albedo A/B, normal A/B, all four materials)
        // samples through this shared wt, so the warp cannot layer or double-apply.
        wt += vTexWarp * uTexWarp;
        // TRIPLANAR WEIGHTS (2026-06-15): power-sharpened abs(n), normalized. uTriSharp dials it.
        // HISTORY: ^8 (very hard) made the dominant axis switch ABRUPTLY at ~45deg -> the projection (and its
        // normal) snapped between two states as the camera moved ('normals flipping between two states'). That
        // hard pick was compensating for UV swim that the camera-relative UV (vTexRel) now fixes at the source,
        // so back off to ^4 (default) for a smooth axis blend with no bistable flip. window.__triSharp.
        vec3 tw = pow(abs(n), vec3(uTriSharp)); tw /= (tw.x + tw.y + tw.z + 1e-4);
        const vec3 LUMA = vec3(0.299, 0.587, 0.114);
        float bAB = clamp(wA / max(wA + wB, 1e-4), 0.0, 1.0);
        // SINGLE HIGH-FREQUENCY OCTAVE + MIPS (user 2026-06-14 'instead of swapping out texture octaves,
        // just use the highest one and let it mip and get rid of the fade-in'): sample the material at the
        // FINE scale (wt*4, ~0.6m/texel) at EVERY distance and let the GPU mip chain average it down far
        // off (= the old low-freq look) -- no second octave, no detailFade. Albedo = luma STRUCTURE (macro
        // color carries chroma); normal strong (x1.4); displacement drives the height-blend (mips soften
        // the displacement, and thus the blend, at distance automatically).
        // LOW-OCTAVE NORMAL BLEND (user 2026-06-14 'blend the higher octave with the lower octave's
        // NORMALS for a less repetitive faraway look -- dont fade it, draw both'): the high octave (wt4)
        // tiles tightly so it repeats visibly far off; ADD the low octave (wt, 2.4km, less repetitive)
        // NORMAL on top -- ALWAYS, no fade -- to break that repetition. Albedo stays high-octave only.
        // Fixed fine-octave scale -- GPU mip chain handles all distance/LOD variation automatically.
        // Dynamic octScale (camDist or pxWorld) caused visible frequency artifacts: wrong mip at
        // grazing angles (pxWorld version) or LOD seam jumps (camDist version). The hardware aniso
        // mip chain is the correct per-pixel LOD mechanism; wt*4 keeps texels near 1px close-up and
        // mips down naturally. uNrmLow blends in the low-octave (wt) normal always for break-repetition.
        highp vec3 wt4 = wt * 4.0;
        // COARSE ALBEDO OCTAVE (user 2026-06-23 'add 1 lower frequency octave to the textures when going further away'):
        // blend from fine (wt4=600m tiles) to coarse (wt=2400m tiles) albedo as pxWorld grows. 4x tile scale
        // ratio produces a clear pattern-scale shift at distance -> breaks repetition without a second texture.
        // Normals carry both octaves at all distances. dispA stays fine-octave (near-field displacement only).
        float octFarFade = smoothstep(uOctFar0 * uReliefScale, uOctFar1 * uReliefScale, pxWorld);
        vec4 albA = surfTriTap(uSurfAlb, wt4, tw, lA);
        vec3 cA = mix(albA.rgb, surfTriTap(uSurfAlb, wt, tw, lA).rgb, octFarFade);
        vec3 nA = surfTriNrm(uSurfNrm, wt4, tw, lA, n) * 1.0
                + surfTriNrm(uSurfNrm, wt,  tw, lA, n) * (1.7 * uNrmLow);
        float dispA = albA.a;
        // NO BIOME COLOR INHERITANCE (user 2026-06-14 'take away all biome color inheritance, it will
        // speed it up' -- and fixes 'sand near grass tinted green'): each layer wears its OWN material
        // color (grass/rock/sand/snow), NOT the macro biome color. mcA = layer A's base color.
        vec3 mcA = lA < 0.5 ? bcGrass : (lA < 1.5 ? bcRock : (lA < 2.5 ? bcShore : bcSnow));
        vec3 texMatColor = mcA;
        vec3 texNrm = nA;
        // TEXTURE-DETAIL FADES (user 2026-06-15): two curves keyed on camera distance.
        // texFade (20->40km) fades the NORMAL textures (user 'mip the normal textures closer, gone by 40km').
        // crossFade (CLOSER, uXFade0->uXFade1 default 3->9km) fades the CROSSOVER ramp's high-octave
        // DISPLACEMENT fingering -- user 'the crossover displacement textures should mip closer, theyre causing
        // high-frequency noise at a distance'. The high-octave disp (~1.2m) goes sub-pixel far out and the *1.5
        // amplification turned mip residue into sparkle; dropping it early collapses the boundary to the smooth
        // weight ramp well before it can alias. Both window-dialable (__texNrmFadeKm not needed; __xFade0/__xFade1).
        float texFade   = 1.0 - smoothstep(uNrmFade0, uNrmFade1, camDist);   // DOUBLED 20/40 -> 40/80km (user 2026-06-15 'double the distance of the max normal textures'); dial __nrmFade0/__nrmFade1
        float crossFade = 1.0 - smoothstep(uXFade0, uXFade1, camDist);
        // albFade REMOVED (user 2026-06-15 'a curved line circles the mountain, lighter grass'): the manual
        // detail->flat-material collapse created a visible ARC at its transition distance (proven by A/B: the
        // arc vanishes when the collapse is pushed all-near or all-far -- it IS the transition zone). The GPU
        // mip chain already fades the albedo detail gradually with distance (no discrete boundary), so let it.
        // ===== CROSSOVER: ONE clean constant-width directional fade (user 2026-06-17 redesign) =====
        // REPLACED the displacement water-level blend (bw + wRamp + ord*0.45, mh = max(hA,hB)-bw). That model
        // had three faults the user named: (1) when the displacement mipped away at distance it collapsed to a
        // narrow ord-biased BAND, not a fade ('the texture band when mipped back to fading produces a band');
        // (2) its width tracked the warp/displacement ('our warp should not affect the width of the band');
        // (3) a HARD texMatColor pick over a SMOOTHLY-mixed photo -> the photo wore the wrong layer's
        // brightness = GREEN SAND. The new model is a single smoothstep fade: WIDTH is the constant uXSoft,
        // POSITION is shifted by overlay priority (the covering material expands), and an optional near-field
        // displacement FINGERING fades to zero with distance so the far/mipped crossover is a SIMPLE A->B fade.
        float ordA = lA < 0.5 ? 0.6 : (lA < 1.5 ? 0.3 : (lA < 2.5 ? 0.0 : 1.0));   // overlay priority: sand<rock<grass<snow
        // layer-A detail = the photo's OWN hue rescaled to layer A's MATERIAL brightness. Each layer keeps its
        // own colour AND brightness, so a transition pixel is a true grass<->sand blend -- never the grass
        // photo wearing sand brightness (that mismatch was the 'green sand').
        float mA = uSurfMeanL[int(lA + 0.5)];
        vec3 satA = max(mix(vec3(dot(cA, LUMA)), cA, uTexSat), 0.0);
        vec3 detailA = satA * (dot(mcA, LUMA) / max(mA, 0.02));
        vec3 detail = detailA;   // single-layer default; the crossfade below overwrites it when a 2nd layer exists
        float bSharp = 1.0;      // 1 = pure layer A; reused by the texDn relief fade below
        if (wB > 0.02) {   // second layer only where a real transition exists
            vec4 albB = surfTriTap(uSurfAlb, wt4, tw, lB);
            vec3 cB = mix(albB.rgb, surfTriTap(uSurfAlb, wt, tw, lB).rgb, octFarFade);
            vec3 nB = surfTriNrm(uSurfNrm, wt4,      tw, lB, n) * 1.0
                    + surfTriNrm(uSurfNrm, wt, tw, lB, n) * (1.7 * uNrmLow);
            float dispB = albB.a;
            float ordB = lB < 0.5 ? 0.6 : (lB < 1.5 ? 0.3 : (lB < 2.5 ? 0.0 : 1.0));
            vec3 mcB = lB < 0.5 ? bcGrass : (lB < 1.5 ? bcRock : (lB < 2.5 ? bcShore : bcSnow));
            // SIGNED SEAM COORDINATE s (+deep in A, -deep in B, 0 at the visual seam):
            //   (bAB-0.5)*2.0        = the gate weight (0 at the weight boundary, +1 deep in A; the A/B top-2
            //                          swap flips its sign continuously across the seam, so the fade is symmetric);
            //   (ordA-ordB)*uOrdPush = POSITION shift only -- the covering material's 50% point moves outward,
            //                          width UNCHANGED (grass covers the grass<->sand band so it can't read green);
            //   finger               = displacement interlock, faded to 0 by crossFade so the FAR crossover is a
            //                          plain over->under fade (no band) and the warp can't widen it at distance.
            float finger = (dispA - dispB) * uXFinger * crossFade;
            float s = (bAB - 0.5) * 2.0 + (ordA - ordB) * uOrdPush + finger;
            bSharp = smoothstep(-uXSoft, uXSoft, s);   // CONSTANT-width directional fade (width = 2*uXSoft)
            // crossfade the two fully-resolved per-layer detail colours (each at its OWN brightness): near, the
            // displacement fingering drives bSharp hard to 0/1 = pure pixels (no muddy mid); far, bSharp is a
            // smooth gradient = the simple over->under fade. No green sand at any distance.
            float mB = uSurfMeanL[int(lB + 0.5)];
            vec3 satB = max(mix(vec3(dot(cB, LUMA)), cB, uTexSat), 0.0);
            vec3 detailB = satB * (dot(mcB, LUMA) / max(mB, 0.02));
            detail = mix(detailB, detailA, bSharp);
            texMatColor = mix(mcB, mcA, bSharp);   // base material colour follows the SAME fade (consistent, no mismatch)
            texNrm = mix(nB, nA, bSharp);
        }
        // detail + texMatColor are now resolved PER-LAYER inside the crossover above (each layer's photo hue at
        // its OWN material brightness, crossfaded by bSharp) -- so no separate texC/texL recompute, and no
        // 'green sand' from a mixed photo wearing a hard-picked brightness. k = how much textured detail shows
        // vs the flat material colour; texFarFade hands the splat off to the macro biome past the splat radius.
        float k = uTexMix * texFarFade;
        // albedo = the per-layer textured detail (k high = near) fading to the flat material colour (k low =
        // far / past the splat radius). The macro biome albedo is NOT the base, so no biome colour bleeds into
        // the ground; each material reads unambiguously as itself (grass green / sand tan / rock grey / snow).
        // (Dead uTexPhoto/uTexPhotoNear raw-photo path removed 2026-06-17 -- it computed photoF every pixel and
        // never used it; the per-layer detail above carries material identity.)
        albedo = clamp(mix(texMatColor, detail, k), 0.0, 1.0);
        // BIOME TINT OFF SAND (user 2026-06-17 'green sand'): biomeC is green in a grassland, and mixing it over a
        // beach/desert sand patch greened the sand. Fade the tint out where the sand layer dominates (w4.z) so
        // sand stays tan; grass/rock/snow keep the full subtle biome tint. (Pairs with the overlay push that
        // makes grass cover most of the band -- together: grass where it should be, clean tan sand where it isn't.)
        float biomeTintHere = uBiomeTint * (1.0 - 0.85 * clamp(w4.z, 0.0, 1.0));
        albedo = mix(albedo, biomeC, biomeTintHere);   // LIVE LEVER (window.__biomeTint, default 0.22): macro biome color subtly over the texture
        albedo *= uTexBright;   // overall ground brightness (__texBright, default 0.92)
        // FAR CONTINUITY (user 2026-06-15 'weird crossover at ~6Mm [altitude]'): outside the splat radius this
        // whole block is SKIPPED -> far terrain = the PURE macro biome albedo (biomeC), but inside the block
        // the splat applied the biome mix (0.22) + brightness (0.92) -> a visible RING where the two formulas
        // meet at the splat fade edge. Blend the splat result back to EXACTLY biomeC as texFarFade->0 so the
        // inner (splat) and outer (skipped) albedo are identical at the boundary = no ring.
        albedo = mix(biomeC, albedo, texFarFade);
        // (AO REMOVED 2026-06-14 user 'fps dropped a lot, no visual improvement, get rid of all the ao
        // for texture and landscape': the displacement texAO + the broadShapeLowM-Laplacian elevation AO
        // are both gone; the latter's 5 wide VS taps were the FPS cost. vConcavity varying also removed.)
        // displacement-normal relief: WORLD-SPACE UDN perturbation from surfTriNrm (each projection
        // plane's tangent axes, not the radial frame). Amplitude capped low (scramble lesson d262b5e);
        // applied AFTER the uReliefShade exaggeration below so the exaggeration never amplifies it.
        // Cap texNrm to unit length before applying as world-space perturbation.
        // nA = two surfTriNrm() sums (weights 1.0 + 1.7*uNrmLow) -> magnitude can exceed 2.
        // An oversized additive delta tilts nLit nearly horizontal at grazing view angles,
        // creating a light-independent glazy/specular artifact. Normalize caps magnitude at 1.
        texDn = normalize(texNrm) * (uTexNrmK * k) * texFade;   // NORMAL textures fade out 20->40km (user 2026-06-15 'mip the normal textures closer, gone by 40km') via the shared texFade -- distant relief is carried by the macro lit normal, not the photo normal
    }
#ifdef _DEBUGVIEW_
    // DIAG displayMode 7: raw river field -> blue where the river line fires, grey ridge field
    // elsewhere. Lets a witness SEE the drainage network + camera together to tune frequency
    // (not guess from screenshots). Pure diagnostic; no effect on the lit path.
    if (displayMode == 7) {
        float rv = riverMask(vWorld, vH, climate.z, climate.w, pxWorld);
        fragColor = vec4(mix(vec3(0.15), vec3(0.1,0.4,0.9), rv), 1.0); return;
    }
    // DIAG displayMode 9: DISCRETE BIOME MAP -> each fragment flat-colored by its classified
    // biome (ocean/ice/tundra/desert/savanna/rainforest/taiga/forest/meadow). Lets a witness
    // COUNT contiguous biome regions + confirm logical placement (deserts in subtropics, ice at
    // poles, rainforest at equator), instead of eyeballing the blended lit palette.
    if (displayMode == 9) {
        // same biome DOMAIN WARP as the lit path (user 2026-06-16 'apply the elevation warp to the biome map too')
        highp vec3 bwN = normalize(vWorld);
        float bwT = snoise3(bwN * 230.0 + vec3(3.7, 9.1, 1.3)) * 0.65;   // single-octave (matches the lit path's trimmed warp)
        float bwH = snoise3(bwN * 230.0 + vec3(21.3, 4.7, 17.9)) * 0.65;
        fragColor = vec4(biomeClassColor(clamp(climate.z + bwT * 0.13 * uBiomeWarp, 0.0, 1.0), clamp(climate.w + bwH * 0.16 * uBiomeWarp, 0.0, 1.0), vH), 1.0); return;
    }
    // DIAG displayMode 10: CANYON field -> red where the gorge network fires (arid elevated only),
    // grey ridge field elsewhere. Lets a witness SEE the canyon network density independent of
    // landing the nadir exactly on a thin gorge line.
    // DIAG displayMode 11: CLIFF validation view -> RED = cliff/escarpment riser faces (vCliffFace),
    // GREEN = canyon walls (vCanyonDep on steep slope), so the user can SEE where cliffs are placed
    // independent of lighting/strata. Grey elsewhere. The witness for the cliff terrace placement.
    // DIAG displayMode 12: PATCHES -> each LOD LEVEL a DISTINCT colour (user: validate the dense LOD
    // is always centered under the camera). Hue cycles by level via a golden-ratio rotation so any two
    // adjacent levels are far apart in hue; the finest (highest-level) patches under the camera read as
    // the hottest band, and the rings must be CONCENTRIC + CENTERED on the camera nadir. A thin dark
    // cell-grid (vGrid) overlays so individual quads are visible. Pure per-instance vLevel -> no field.
    if (displayMode == 12) {
        float h = fract(vLevel * 0.61803398875);            // golden-ratio hue per level (well-spread)
        // HSV->RGB at full sat/val for h, mid-V so text/grid reads.
        vec3 rgb = clamp(abs(fract(h + vec3(0.0, 0.6666667, 0.3333333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
        vec3 col = rgb * 0.85 + 0.1;
        // quad-cell grid overlay (same fwidth-AA lines as wireframe) so patch boundaries are crisp.
        vec2 g = vGrid * 24.0; vec2 gf = abs(fract(g) - 0.5); vec2 gw = fwidth(g) * 1.2;
        float line = 1.0 - min(smoothstep(0.0, gw.x, gf.x), smoothstep(0.0, gw.y, gf.y));
        col = mix(col, vec3(0.0), clamp(line, 0.0, 1.0) * 0.55);
        fragColor = vec4(col, 1.0); return;
    }
#endif // _DEBUGVIEW_ (modes 7-12)
    // Material = the biome height/slope/climate ramp (provably 0 edges). The ortho atlas + per-pixel
    // detail texturing are both REMOVED (GPU one-fractal): closeup detail comes from the mesh
    // subdividing into a denser sample of the single VS height fractal, never a tile sample or grain.
    if (displayMode == 4) { fragColor = vec4(albedo, 1.0); return; } // biome ramp
    if (displayMode == 2) { fragColor = vec4(albedo, 1.0); return; }

    // ---- Bruneton-style atmospheric lighting (ported analytic single-scatter) ----
    // Map the terrain point + camera into atmosphere space (km, surface=ATM_BOTTOM).
    highp vec3 pAtm   = atmPos(vWorld, terrainR);    // W7: km-scale (~6360) atmosphere coords -> highp for the AP segment precision
    highp vec3 camAtm = atmPos(camWorld, terrainR);
    // GENTLE-SLOPE RELIEF SHADING (user 2026-06-10 'even gentle slopes shaded so terrain elevation
    // is obvious'): exaggerate the tangential tilt of the LIT normal only -- the material gates keep
    // the true geometric n, so placement is unchanged; lighting contrast on rolling ground increases.
    if (uReliefShade > 1.0) {
      // Relief exaggeration of the LIT normal's tangential tilt. The old SCREEN-SPACE dFdx(vH) term was
      // REMOVED (user 2026-06-14 'jagged normals, still there on the normals view'): dFdx/dFdy of the
      // INTERPOLATED vH varying is CONSTANT PER TRIANGLE and discontinuous at every triangle edge =
      // hard facets baked straight into the lit normal -- the jaggedness root, not the vertex normal.
      // It was a workaround for when vNrm ~= uz on gentle ground; the central-difference vNrm now
      // captures gentle slopes (real gradient), so (nLit-uz) is non-zero on real slopes and the plain
      // exaggeration is legible without the faceted screen-space hack.
      nLit = normalize(uz + (nLit - uz) * uReliefShade);
    }
    // photo-texture detail normal at its calibrated amplitude, OUTSIDE the relief exaggeration.
    // ADDED in world space (the old `- ux*dn.x - uy*dn.y` subtracted an already-negated Sobel
    // normal in a frame the triplanar RG was never expressed in -- the fundamental both-at-once
    // math bug: bumps lit from wrong directions everywhere the splat is active).
    nLit = normalize(nLit + texDn);
    vec3 nAtm   = nLit;   // relief-exaggerated normal for lighting (macro n still drives material)
#ifdef _DEBUGVIEW_
    // Normals view shows the FINAL lit normal (geometry + relief exaggeration + texture detail
    // normal) -- the normal the lighting actually uses, texture normals included.
    if (displayMode == 1) { fragColor = vec4(nAtm * 0.5 + 0.5, 1.0); return; }
#endif

    // ANIMATED OCEAN BRANCH REMOVED (user 2026-06-11 'the ocean should be a separate surface'):
    // sub-sea fragments are the real SEABED now (sand/rock, lit as land below); the animated water
    // shading moved to the uIsWater=1 water-surface pass (early return at the top of main), alpha-
    // blended over this seabed. Sea ice still keys the seabed albedo near the poles.

    vec3 skyIrr;
    vec3 sunIrr;
    if (uUnderwater > 0.5) {
        // Underwater terrain (seabed): sun attenuated through water column, blue ambient, no
        // atmospheric Rayleigh/Mie scattering. Sun colour shifts toward green-blue with depth.
        float depth = max(0.0, terrainR - length(camWorld));
        float atten = exp(-depth * 0.0004);
        float ndl = max(dot(nAtm, sunDir), 0.0);
        sunIrr = vec3(1.0, 0.65, 0.35) * atten * ndl * 0.7;
        skyIrr = vec3(0.02, 0.07, 0.18);
    } else {
        sunIrr = atm_sunSkyIrradiance(pAtm, nAtm, sunDir, skyIrr);
    }
    // HOST-ENGINE SHADOW BRIDGE: darken the DIRECT sun term only (skyIrr ambient stays, matching real
    // shadow physics -- a shadowed patch still gets sky-fill light, just not direct sun) by the host's
    // THREE shadow-map visibility. Applied uniformly to both the underwater and above-water sunIrr
    // branches, before any other consumer reads sunIrr. Fails open to 1.0 (unchanged look) when the
    // host has no shadow data this frame.
    sunIrr *= sampleHostShadow(vWorld);
    // The Rayleigh sky irradiance is strongly blue; at full strength it tints the lit
    // CONTINENTS blue-grey from orbit (witnessed: lit mean [83,95,112] vs warm albedo
    // [90,83,74] at 2000km -- the blue is the sky-irradiance term, NOT aerial inscatter).
    // Partially DESATURATE skyIrr toward its luminance so it still brightens shadowed/
    // ambient regions without washing the land's true color blue. Land albedo dominates;
    // a modest blue ambient remains (physically the sky does add some blue fill).
    float skyL = dot(skyIrr, vec3(0.2126, 0.7152, 0.0722));
    vec3 skyIrrBalanced = mix(vec3(skyL), skyIrr, 0.35);   // 0 = grey, 1 = full blue sky
    // RELIEF RECOVERY (Real-World Look): the bright flat sky fill washed N.sun ridge/valley contrast
    // to ~flat. CUT the fill (uSkyFill, was implicit 1.0) + cool-tint it so shadows read sky-blue, so
    // the direct sun becomes the dominant key and relief self-shading actually shows.
    skyIrrBalanced *= uSkyFill * vec3(0.85, 0.92, 1.10);
    // Lambert BRDF (albedo/PI) under sun + (balanced) sky irradiance. Keep an ambient
    // FLOOR so night/shadow faces are never pure black (PRD lit-terrain-dark-black).
    // SLOPE/CURVATURE AO REMOVED 2026-06-15 (user 'get rid of the AO code, its costing computation'): the
    // slope-keyed sky-occlusion (slopeAO/cliffAO) + the Sobel-slope fsShadeAO are gone; skyAO is a constant 1.0
    // so the sky ambient is uniform. Direct-sun N.L shading still drives all relief contrast.
    // STRONGER NORMAL-DRIVEN SHADING (user 2026-06-03: 'normals arent affecting the lit view properly').
    // The lit relief was too subtle (witnessed litON SD 6.4 vs flat 5.9 = only ~8% contrast) because
    // sunIrr (the N.sun direct term) was diluted by the flat sky ambient + the 0.06 albedo floor. Cut
    // the ambient floor (0.06->0.03) so shaded slopes go genuinely darker, and BOOST the directional
    // sun term (x1.6) so the N.sun slope contrast reads clearly. The (1/PI) Lambert norm + ACES tonemap
    // keep it from blowing out; a small floor still prevents pure-black shadow faces.
    // sunIrr boost 1.6 -> 1.25 + ambient floor 0.03 -> 0.04 (user 2026-06-03 screenshot: the 1.6 boost
    // BLEW OUT high/bright rock to flat white, losing relief detail). 1.25 keeps the slope contrast
    // strong (N.sun still drives the shading) without clipping the highlights to white on lit rock.
    // AMBIENT FLOOR lifted 0.025->0.05 (live-deck witness mut-1780681995401: with the analytic+fs normal ON
    // HALF the deck frame crushed to NEAR-BLACK -- mean 151->91, n898k->434k -- so relief read as black
    // HOLES not legible rugged texture). A genuine shadowed rock face is dark grey-blue (skylight), never
    // pure black; the higher floor keeps micro-relief readable as texture while the direct sun still drives
    // the ridge/valley key contrast. Tied to cliffAO so true contact-shadow concavities still darken.
    // PER-VERTEX SHADING (DEFECT 2): fold the interpolated vShadeAO crease/micro-relief occlusion into
    // the ambient term so geometry reads relief even where the FS detail-normal is faint. nearFade-gated
    // (full at the deck, ->1 i.e. no effect at orbit) so the macro/orbit look is unchanged. Combines
    // multiplicatively with cliffAO -- both are sky-occlusion factors that should compose.
    // W5: vShadeAO (per-vertex, from the deleted VS gradient) RECOMPUTED here from the Sobel slope (user
    // 2026-06-07 'recompute AO from Sobel'). creaseAO = slope*0.45 (steep landform -> valley/crease
    // occlusion); microAO from the fine per-pixel gslope. uVertexAO lever + the 0.45 floor preserved.
    float skyAO = 1.0;   // AO REMOVED (2026-06-15): sky ambient uniform; direct sun drives relief
    // FADE-IN FIX (user 'a layer fades in at close distance'): vAO was mix(1.0, fsShadeAO, nearFade) where
    // nearFade rises 0->1 as pxWorld shrinks 180->8m on approach -> the Sobel crease-AO darkening animated
    // IN as the camera neared = the visible 'layer fading in'. fsShadeAO is a per-pixel SOBEL-slope quantity
    // (not sub-pixel noise) so it does NOT alias and needs no distance gate -- present at all distances, no
    // pop. This is the nearFade gate the P5 unification missed on the shading-AO path. nearFade now unused.
    // SHADOW-FACE FILL (user 2026-06-09: 'shadows are still full black'). On a day-side face pointing AWAY
    // from the sun, sunIrr->0 so ONLY this floor lights it. The old floor (albedo*0.05*cliffAO*vAO) was
    // crushed to ~0 on dark-albedo rock AND on steep/concave faces (cliffAO*vAO -> 0 exactly where shadows
    // are) -> black shadows. FIX: (a) an ALBEDO-INDEPENDENT additive sky term so even dark rock never goes
    // black, (b) DROP the cliffAO/vAO multipliers from the floor (they belong on the sky KEY, not the
    // guaranteed floor), (c) lift the albedo-tinted part to 0.22. Result: shadowed faces settle to a dim
    // cool-grey, never black; the direct sun still drives the lit/shadow contrast above this floor.
    // The 0.22 flat lift (no AO) flooded shadowed ANGLED faces to a uniform cool-grey, washing out the
    // relief (user 2026-06-10: 'angled faces turned to rock/grey'). Restore directional shading: scale the
    // albedo-tinted part by a SOFTENED sky exposure (mix(0.45,1.0,skyAO) -- never crushes to 0 like the old
    // cliffAO*vAO did, but lets faces that see less sky read darker = the relief returns), and lower the lift
    // 0.22->0.14. The albedo-INDEPENDENT flat sky floor stays as the never-black guarantee (the 9cfa643 win).
    vec3 ambientFloor = albedo * (0.14 * mix(0.45, 1.0, skyAO)) + vec3(0.020, 0.026, 0.038);
    // sky AO no longer SQUARED (was cliffAO*cliffAO): the squared sky term over-crushed shadowed micro-
    // relief to black at the deck. Single cliffAO still darkens concavities for depth, but shadowed
    // faces retain sky fill so the analytic normal reads as rugged texture, not black blotches.
    // (the old vH<-2 ocean bypass is gone -- the seabed is land now, lit like land; the water
    // surface is its own pass.)
    vec3 lit = albedo * (sunIrr * 1.25 + skyIrrBalanced * skyAO) * (1.0/ATM_PI) + ambientFloor;

    // AERIAL PERSPECTIVE (analytic single-scatter, re-added 2026-06-05 for the space->ground depth
    // cue -- the single biggest missing realism term for the seamless descent; ref Hillaire-2020).
    // The OLD removed version was a flat 15km horizon haze band the user disliked; this is
    // physically-grounded instead: integrate Rayleigh+Mie in-scatter along the EXACT camera->
    // fragment segment and attenuate the lit color by the segment transmittance, so the haze is
    // PROPORTIONAL to how much atmosphere the view ray actually crossed. DISTANCE-GATED hard at
    // both ends: ~zero within a few km (FPS-ground stays crisp, no over-haze the user hated) and
    // ramping in only across tens-of-km+ (the depth cue that makes distant ridges recede and the
    // space->ground transition read as real). Routed through atm_marchRadiance (shared with the
    // sky pass, see the LUT INTEGRATION comment inline below) -- single draw, reuses atm_* -> zero
    // assets, and gets uUseScatteringLUT's precomputed fast path for free.
    float nwSun = dot(nWorld, sunDir);   // hoisted: reused for terminator graze/termDay (AP block) + macroMu (globe shading)
    vec3 color = lit;
    {
        highp vec3 camA  = atmPos(camWorld, terrainR);     // W7: km-scale -> highp
        highp vec3 segKm = pAtm - camA;                    // W7: camera->fragment in km (cancellation of two km-scale points)
        // gate: 0 below ~3km path, ramping to full by ~120km. keeps ground crisp, distance hazed.
        // T-7: defer the sqrt -- most close-up fragments have dKm<3km (dKm2<9) where apGate is 0.
        highp float dKm2 = dot(segKm, segKm);
        highp float dKm = dKm2 > 9.0 ? sqrt(dKm2) : 0.0;
        float apGate = smoothstep(3.0, 120.0, dKm);
        if (apGate > 0.002) {
            vec3 vRay = segKm / max(dKm, 1e-4);
            // LUT INTEGRATION (atmosphere-aerial-perspective-terrain-lut-integration, follow-up to
            // atmosphere-scattering-lut-bruneton-lite): this used to be a hand-rolled N=4 fixed-step
            // trapezoid march duplicating atm_marchRadiance's own loop body verbatim (camera->fragment
            // single-scatter Rayleigh+Mie integral + per-step camera->sample sun transmittance).
            // atm_marchRadiance IS that same generic march (camera,viewRay,sun,dEnd) -> (inscatter,
            // transmittance), already carrying the uUseScatteringLUT fast path (2 scattering-LUT taps
            // via the additive partial-path-subtraction trick, see its own comment above) as an
            // explicit A/B lever. Calling it here instead of re-deriving the loop makes the aerial-
            // perspective march benefit from the SAME LUT swap the sky pass already got, with zero
            // duplicated math and zero behavior change on the default (uUseScatteringLUT=0) runtime-
            // march path -- identical N=4-equivalent trapezoid integral, byte-for-byte same formula,
            // just factored through the shared function instead of re-inlined.
            vec3 apTrans;
            vec3 apInscat = atm_marchRadiance(camA, vRay, sunDir, dKm, 4, apTrans);
            // HORIZON HAZE FLOOR (Real-World Look): real aerial perspective fades distant terrain toward
            // a pale blue-grey sky, NEVER to black. When apTrans collapses (long limb path) the physical
            // single-scatter inscatter can dip in low-phase directions, leaving a black silhouette band.
            // Floor the fill with a multiple-scatter-style skylight ambient (1-apTrans) so the far ridge
            // dissolves into haze instead of going dark. Tied to uSkyFill so it's terraformable.
            vec3 skyHaze = uSkyFill * vec3(0.40, 0.55, 0.78) * (1.0 - apTrans);
            apInscat = max(apInscat, skyHaze);
            // attenuate the surface by transmittance and add the in-scatter, both faded by the gate
            // so the near field is untouched (apGate~0 -> mix back to the un-hazed lit color).
            vec3 hazed = lit * apTrans + apInscat;
            // TERMINATOR SUNSET REDDENING (Real-World Look): add a warm Rayleigh-out rim where the sun
            // GRAZES the limb (strictly gated on 1-|N.sun| near 0 so it never bleeds onto the full day
            // side). Rides the existing AP inscatter -- zero extra march. uTerminatorGlow lever.
            // peak at the terminator (N.sun~0), fall off toward both day-center and night-center, and
            // SQUARE it so the warm band is tight at the day/night line instead of a fat ring round the
            // whole limb. Warm amber (not pure red) so it reads as sunset haze, not a bruise.
            float gz = 1.0 - abs(nwSun);   // nwSun = dot(nWorld,sunDir) hoisted before AP block
            float graze = smoothstep(0.55, 1.0, gz); graze *= graze;
            // only on the LIT side of the terminator (mu>0) -- past the line the surface is night and
            // additive amber on near-black extinct land reads as a scorched maroon rim. Day-gate kills it.
            float termDay = smoothstep(-0.02, 0.18, nwSun);
            hazed += uTerminatorGlow * graze * termDay * vec3(1.0, 0.55, 0.34) * apGate;
            color = mix(lit, hazed, apGate * uHazeMul);   // uHazeMul lever (2026-06-10 'pale hazy': full-strength haze milked the midground)
        }
    }
    // UNDERWATER FOG (camera below sea level): replace the air-based Aerial Perspective with
    // absorption/scattering through water. Fog colour deepens with camera depth so the seabed
    // fades to blue-green with distance, red absorbed first. Applied only to terrain (uIsWater<0.5).
    if (uUnderwater > 0.5 && uIsWater < 0.5) {
        highp vec3 camA  = atmPos(camWorld, terrainR);
        highp vec3 segKm = pAtm - camA;
        highp float dKm  = length(segKm);
        float depth = max(0.0, terrainR - length(camWorld));
        // CLEARER WATER + LONG VISIBILITY (user 2026-06-14 'fix underwater visibility so we can explore
        // under the ocean'): the old absorb (4,0.8,0.3)/km + a 50->500m hard fog fade closed the view to
        // opaque blue within ~500m. Lower the coefficients (still red-first absorption) and push the hard
        // fade to ~3-15km so the seabed landscape is explorable; red still fades fast (realistic blue cast).
        // MUCH CLEARER (user 2026-06-14 'we cant see the ocean floor properly'): the deep-ocean floor is
        // km below, so even 'clear' (1.0/0.30/0.15) water + a 3-15km fade hid it. Drop the coefficients
        // hard and push the fade to ~10-50km so the ocean FLOOR reads as terrain from a long way off
        // (game-clarity over physical realism; red still absorbs first for a natural blue-green cast).
        // FOG 10x LESS (user 2026-06-14 'make the fog 10x less / doesnt look right under the water'):
        // extinction /10 and the hard fade pushed 10x out so the ocean floor reads clearly from a long
        // way off with only a faint blue tint, not a wash of fog.
        vec3 absorb = vec3(0.035, 0.010, 0.005) * (1.0 + depth * 0.0001);
        // PERSISTENT NEAR-SURFACE FOG (user 2026-06-24 'the blue fog disappears as soon as we get near
        // the water surface; its supposed to stick around'): uwTrans = exp(-absorb*dKm) -> ~1 (no fog)
        // whenever the camera is close to the fragment, so the blue cast evaporated in the shallows /
        // near the surface even though still underwater. Add a depth-INDEPENDENT minimum optical depth
        // (minTau, per-channel red-first) so being submerged AT ALL tints the whole view blue and the
        // fog never fully clears; real distance dKm still adds on top.
        vec3 minTau  = vec3(0.45, 0.30, 0.20);   // always-present blue cast while submerged
        vec3 uwTrans = exp(-(absorb * dKm + minTau));
        vec3 uwFog = vec3(0.004, 0.09, 0.18) + vec3(0.0, 0.015, 0.03) * depth / 1000.0;
        // SEABED LIGHTING (user 'floor too flat/dim'): the deep floor gets almost no direct sun, so it
        // read dim+flat. Lift the brightness and add an up-facing fill (brighter where the surface faces
        // up, darker on slopes -> 3D relief) + a touch of slope contrast keyed on the lit normal vNrm.
        float upFill = mix(0.75, 1.35, clamp(dot(vNrm, nWorld) * 0.5 + 0.5, 0.0, 1.0));
        color *= upFill * 1.5;
        color = mix(color * uwTrans + uwFog * (1.0 - uwTrans), uwFog, smoothstep(100000.0, 500000.0, dKm * 1000.0));
    }
    // RIVERS post-lighting (witnessed browser-2115/2118: the river-blue in ALBEDO is multiplied
    // by the warm sun irradiance (sunIrr.b is low) so land rivers lose their blue in the lit
    // result -- 15k blue albedo px -> 0 lit px, even with the sun HIGH (sunDotUp 0.85). Ocean
    // sidesteps this by bypassing the irradiance multiply (vH<0 branch). So rivers, like open
    // water, must be composited AFTER lighting: blend the post-lit color toward a sun-scaled
    // water-blue on the river line. ndlSun keeps the river shaded by the sun so it is not flat.
    // INLAND WATER = REAL WATER, SHADED LIKE THE OCEAN (user 2026-06-01i: 'it should use the same
    // content as the sealevel to draw because its also water'). Where vWaterDepth>0 (the flat water
    // plane sits above the carved floor -> genuinely submerged) we run the SAME water model as the
    // ocean branch: fresnel sky reflection + sun glint + shallow->deep depth tint, composited AFTER
    // lighting (the warm sun-irradiance multiply would otherwise kill the blue, the reason the ocean
    // bypasses it via vH<0). Gating on vWaterDepth (NOT the whole carve mask) makes the water LINE UP
    // with the flat carved surface -- the graded erosion banks above the waterline stay dry land.
    // WIREFRAME OVERLAY (uWireframe=1): draw the per-quad mesh-cell grid lines so the LOD
    // tessellation is visible. Uses the parametric vGrid coord (0..1 per tile, GRID cells) with an
    // fwidth-based anti-aliased line at each cell boundary -> crisp wireframe at any distance,
    // independent of the triangle topology (WebGL2 has no glPolygonMode). Drawn pre-tonemap so the
    // lines tonemap with the surface.
    if (uWireframe > 0.5) {
        vec2 g = vGrid * 16.0;                 // GRID cells per tile edge (gridMeshSize 16; was 24, FPS lever)
        vec2 gf = abs(fract(g) - 0.5);         // distance to nearest cell line in cell units
        vec2 gw = fwidth(g) * 1.2;             // line half-width in cell units (AA)
        float line = 1.0 - min(smoothstep(0.0, gw.x, gf.x), smoothstep(0.0, gw.y, gf.y));
        color = mix(color, vec3(0.05, 1.0, 0.4), clamp(line, 0.0, 1.0) * 0.85);
    }
    // WEATHER-DRIVEN WETNESS (wetness-material-modifier-weather-driven): darken albedo + add a
    // narrow specular sheen on LAND, driven by uWetness (0=dry..1=soaked, see the uniform decl
    // above for the full data-flow comment). GATED to uIsWater<0.5 (terrain pass only, not the
    // separate water-surface draw -- water is already "wet") && vH>0.0 (above sea level -- the
    // seabed/underwater branch already has its own tuned look, untouched) so at uWetness=0 (the
    // default) this is a dead branch with zero cost beyond the uniform compare, matching the same
    // "precondition-gated, cannot false-trigger" discipline as UnderwaterTint.js on the THREE side
    // (see AGENTS.md underwater-model-tint-shaderchunk) -- rain never touches the ocean/lake shading.
    if (uWetness > 0.001 && uIsWater < 0.5 && vH > 0.0) {
        // Darken albedo (wet ground absorbs more light -- real rained-on soil/asphalt/grass reads
        // visibly darker, not just shinier) up to ~35% at full soak, plus a narrow Blinn-Phong-style
        // specular sheen from the sun so puddled/soaked ground picks up a directional highlight a
        // dry diffuse surface never does. Both scale linearly with uWetness so a fresh drizzle
        // (uWetness near 0, see Weather.js's dry-out ramp) barely perturbs the look.
        color *= mix(1.0, 0.65, uWetness);
        // Local viewDir (NOT the macro-globe-shading block's `viewDir` below -- that is declared
        // later in this function; computed independently here rather than reordering unrelated code).
        vec3 wetViewDir = normalize(camWorld - vWorld);
        vec3 halfDir = normalize(sunDir + wetViewDir);
        float spec = pow(max(dot(n, halfDir), 0.0), 24.0);
        color += spec * uWetness * 0.5 * vec3(1.0, 1.0, 0.95);
    }
    // MACRO GLOBE SHADING (user 2026-06-03: at the DEFAULT ORBIT view the planet read as a FLAT MAP --
    // a luma scan across the disc was ~uniform, no terminator/limb darkening, because the OCEAN bypasses
    // the sun term and the high exposure pushed land into the tonemap's flat bright shoulder). Apply the
    // SPHERE sun angle to EVERY fragment (land + ocean) so the globe reads 3D: bright at the sub-solar
    // point, falling to dark across the day side into the terminator. dayShade = smoothstep over the
    // surface-normal . sun, with a small ambient floor (0.10) so the night/terminator isn't pure black.
    float macroMu = nwSun;   // nwSun hoisted before AP block
    // SOFT FLOORED TERMINATOR (Real-World Look): a wider, smoother twilight band (uTermWidth) with a
    // night floor (uNightFloor) so framed night longitudes keep faint detail instead of crushing to
    // black (defect #4). The old hard 0.10..-0.12,0.55 band was too steep + too dark.
    float dayShade = mix(uNightFloor, 1.0, smoothstep(-uTermWidth, uTermWidth, macroMu));
    // LIMB DARKENING: grazing-view fragments (the disc EDGE from orbit) darken, giving the globe its
    // rounded 3D form instead of a flat disc. viewGraze = surface-normal . view-dir, ->1 facing the
    // camera (disc centre), ->0 at the limb. Only bites near the limb so it does not dim the main face.
    vec3 viewDir = normalize(camWorld - vWorld);
    float viewGraze = max(dot(nWorld, viewDir), 0.0);
    float limb = 0.45 + 0.55 * smoothstep(0.0, 0.45, viewGraze);   // 0.45 at the limb -> 1.0 facing camera
    // NIGHT / SHADOW FILL (user 2026-06-09: 'we want night lights in the SHADOW areas, not city lights'):
    // a UNIFORM dim fill that lifts the unlit hemisphere out of pure black -- a cool ambient night light,
    // no clusters, no warm dots, no land gate (it lifts every dark fragment, ocean + land). uNightLights
    // is the live intensity dial (0 = off, back to near-black night). The day-lit side (dayShade->1) is
    // unaffected because the fill is weighted by (1-dayShade). Raised from the old earthshine 0.012/0.018/
    // 0.032 (still read as black) to a clearly-visible dim blue so framed night terrain stays legible.
    vec3 nightFill = vec3(0.06, 0.075, 0.11) * uNightLights;
    vec3 color2 = (color * dayShade + nightFill * (1.0 - dayShade));
    // HDR -> SDR: ACES tonemap. Exposure 1.7 -> 1.25 so the N.sun + dayShade gradient SPREADS across the
    // tonemap's linear range instead of clipping flat to the bright shoulder (the orbit-flatness root).
    vec3 c = color2 * uExposure;   // exposure 1.25->uExposure(1.0): stop the bright ACES-shoulder wash
    vec3 mapped = clamp((c*(2.51*c+0.03))/(c*(2.43*c+0.59)+0.14), 0.0, 1.0);
    // POST-ACES LOOK (Real-World Look): restore saturation + contrast DELIBERATELY in display-linear so
    // the result is darker-but-saturated, not bright-but-pastel. Pull saturation up (uLookSat) + an
    // S-curve contrast about mid-grey (uLookContrast), then gamma. Live-tunable.
    float lum = dot(mapped, vec3(0.2126, 0.7152, 0.0722));
    mapped = mix(vec3(lum), mapped, uLookSat);
    mapped = clamp((mapped - 0.5) * uLookContrast + 0.5, 0.0, 1.0);
    fragColor = vec4(pow(mapped, vec3(1.0/2.2)), 1.0);
}
#endif

// ---- HEIGHT PROBE (collision): compute the EXACT rendered terrain height for one world dir,
// reusing the same hpfSample + broadShapeM the mesh VS uses, so the free-fly collision floor
// can never diverge from the rendered surface (user-chosen: read px from the GPU, not a CPU
// mirror). Paired with a 1-point VS in gl-render.js; writes height (metres) to R32F.
#ifdef _PROBE_
uniform vec3 probeDir;     // world direction under the camera (normalized)
out vec4 probeOut;
void main(){
    vec3 dir0 = normalize(probeDir);
    // THC-Normal W1/W7: the collision height is now the SAME composeHeight() the geometry bake uses,
    // so sampleGroundM returns EXACTLY the rendered surface -- no parallel mirror to drift (was a
    // hand-copied carve sequence that OMITTED vtxDisplace = the camera-stops-short gap). Reconstruct
    // the face-local metres from the probe world dir (max-axis cube projection -> warped face metres)
    // so vtxDisplace samples the identical micro-relief field the VS does. tileM = a deck-leaf size so
    // the Nyquist fade keeps every octave the close-up geometry shows (collision == visible surface).
    int face; vec2 uv; hpfFaceUV(dir0, face, uv);
    // hpfFaceUV INVERTS the cube projection that built dir0, so (uv*2-1)*defRadius IS ALREADY the
    // warped face-local metres the mesh VS passes to composeHeight (terrain.glsl:667: faceWarp(...)).
    // The old line wrapped this in faceWarp() a SECOND time = a double-warp -> the probe sampled a
    // SHIFTED vtxDisplace noise-lattice position than the VS = a per-probe micro-relief height delta
    // (collision-elev-facelocal-parity, workflow wb4syopmo). Drop the extra warp: probe lattice == VS lattice.
    highp vec2 faceLocal = (uv * 2.0 - 1.0) * defRadius;             // W7: warped face-local metres ~6.4e6 -> highp (matches VS:667)
    // tileM is INERT in vtxDisplace (terrain.glsl:495-501 has no tileM term; PURE per-patch-step fix) so
    // composeHeight is bit-identical for any tileM -> the hardcoded value below is NOT a divergence (verified).
    highp float h = composeHeight(dir0, faceLocal, 64.0);            // W7: metres (tileM inert; collision == rendered surface)
    // RAW height out (2026-06-11): the old smoothstep(-60,60) flat-ocean clamp made the probe a
    // CLAMPED GAUGE -- sampleGroundM could never report real bathymetry (witnessed: a 2000-dir
    // sweep found 'no ocean below -100m' on a planet with km-deep basins), silently corrupting
    // every depth-based witness. Collision still floats on the water: BOTH movement consumers
    // clamp at use (planet.html Math.max(0, sampleGroundM(...)) at the move-step and ground-track
    // sites), which is where a USE-specific policy belongs -- the instrument now reports truth.
    probeOut = vec4(h, 0.0, 0.0, 1.0);
}
#endif

#ifdef _HEIGHTBAKE_
// THC HEIGHT-CACHE BAKE (2026-06-14): render ONE tile's composeHeight into a height-pool texel grid.
// Each fragment = one parametric (u,v) of the tile; the dir + faceLocal mapping is IDENTICAL to the
// mesh VS (faceWarp(vertex.xy*defOffset.z+defOffset.xy), normalize(frame*vec3(faceLocal,defRadius)))
// so the baked height matches the procedural geometry exactly. NON-DESTRUCTIVE: this is a separate
// program; the live VS still computes composeHeight until thc-vs-sample switches it to a pool sample.
uniform mat3 uBakeFrame;    // face-local -> world for this tile's face (== faceFrame(face))
uniform vec4 uBakeOffset;   // tile (ox, oy, l, level) face-local metres (== iOffset)
uniform float uBakeRes;     // bake grid resolution (texels per edge)
out vec4 bakeOut;
void main(){
    highp vec2 uv = (gl_FragCoord.xy - 0.5) / max(uBakeRes - 1.0, 1.0);   // texel -> parametric [0,1]
    highp vec2 faceLocal = faceWarp(uv * uBakeOffset.z + uBakeOffset.xy);
    highp vec3 dir0 = normalize(uBakeFrame * vec3(faceLocal, defRadius));
    highp float h = composeHeight(dir0, faceLocal, uBakeOffset.z);
    bakeOut = vec4(h, 0.0, 0.0, 1.0);
}
#endif
