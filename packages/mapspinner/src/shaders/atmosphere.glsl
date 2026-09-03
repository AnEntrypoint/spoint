// src/shaders/atmosphere.glsl  (#version 300 es is prepended by the JS loader)
// -----------------------------------------------------------------------------
// WebGL2 analytic Rayleigh/Mie single-scatter atmosphere for the planet.
//
// PORT NOTE — what this is vs. the WebGPU path:
//   planet.html runs the AUTHORITATIVE Bruneton model: it BAKES the transmittance/
//   scattering/irradiance LUTs at runtime with WebGPU COMPUTE shaders (3D textures,
//   multiple-scattering orders 2..4) and then samples them with a_GetSkyRadiance().
//   WebGL2 has NO compute shaders, and the baked LUTs live in a *separate* WebGPU
//   GPUDevice/context that cannot be shared into the WebGL2 context. Re-baking the
//   full 3D multiple-scattering LUTs with WebGL2 fragment passes is a large, fragile
//   undertaking. Per the task's explicit fallback, this file implements a FAITHFUL
//   analytic single-scatter atmosphere instead: same atmosphere geometry (bottom
//   6360 km, top 6420 km), the same Rayleigh/Mie scattering coefficients and phase
//   functions and solar irradiance Bruneton uses, and an analytic optical-depth
//   transmittance. It produces a real limb/halo, sky color gradient, a sun disc,
//   and sun+sky irradiance on the terrain. SIMPLIFIED vs. baked Bruneton:
//     - single scattering only (no orders 2..4 multiple scattering),
//     - analytic exponential optical depth (chapman-ish) instead of LUT transmittance,
//     - sky ambient from a hemispheric Rayleigh approximation instead of the irradiance LUT.
//
// Units: positions passed in are ATMOSPHERE-SPACE kilometres (surface at ATM_BOTTOM
// = 6360). atmPos() maps the meter-scale render world (R = 6360000 m) into this space.
// -----------------------------------------------------------------------------

const float ATM_PI = 3.14159265358979;

// Atmosphere geometry (km) — matches ATMO_DEF used to bake the WebGPU LUTs.
const float ATM_BOTTOM = 6360.0;
// Visible shell thickened to ~140 km (vs Bruneton's 60 km) so the limb/halo reads
// as a real atmosphere ring from orbit instead of a sub-pixel sliver. SIMPLIFICATION
// vs. the baked Bruneton LUTs (which use 6420). Scale heights raised to match so the
// density still falls off smoothly across the thicker shell.
const float ATM_TOP    = 6500.0;
const float ATM_RAYLEIGH_H = 18.0;   // Rayleigh scale height (km), inflated for the halo
const float ATM_MIE_H      = 4.0;    // Mie scale height (km)
const float ATM_MIE_G      = 0.8;

// Bruneton scattering coefficients (per-km) and solar irradiance (W/m^2/nm-ish).
const vec3  ATM_RAYLEIGH = vec3(0.005802, 0.013558, 0.0331);
const vec3  ATM_MIE      = vec3(0.003996, 0.003996, 0.003996);
const vec3  ATM_MIE_EXT  = vec3(0.003996) * (1.0 / 0.9); // Mie extinction = scat/ssa, ssa~0.9
const vec3  ATM_SOLAR_IRRADIANCE = vec3(1.474, 1.8504, 1.91198);
const float ATM_SUN_ANGULAR_RADIUS = 0.004675;
// A-6: squared shell radii (computed once at compile, not per ray).
const float ATM_BOTTOM2 = ATM_BOTTOM * ATM_BOTTOM;
const float ATM_TOP2    = ATM_TOP * ATM_TOP;
// A-6/A-8: Mie phase constants folded (g is always ATM_MIE_G) + Rayleigh phase constant.
const float ATM_MIE_G2 = ATM_MIE_G * ATM_MIE_G;
const float ATM_MIE_2G = 2.0 * ATM_MIE_G;
const float ATM_MIE_K  = (3.0 / (8.0 * ATM_PI)) * (1.0 - ATM_MIE_G2) / (2.0 + ATM_MIE_G2);
const float ATM_RAYLEIGH_PHASE_K = 3.0 / (16.0 * ATM_PI);

// Map a render-space world position (meters, surface radius R_m) into atmosphere
// space (km, surface at ATM_BOTTOM). Preserves altitude fractions across the shell.
// W7: worldMeters ~6.4e6 m + R_m ~6.4e6 m both overflow fp16 -> highp (terrain.glsl injects this file
// into the FS, whose global default precision is now mediump). The km-scale result narrows naturally.
vec3 atmPos(highp vec3 worldMeters, highp float R_m) {
    return worldMeters * (ATM_BOTTOM / R_m);
}

float atm_rayleighPhase(float nu) { return ATM_RAYLEIGH_PHASE_K * (1.0 + nu*nu); }
float atm_miePhase(float nu) {   // A-8: g folded to consts; A-7: pow(x,1.5) == x*sqrt(x) (1 sqrt vs 2 transcendentals)
    float base = max(1.0 + ATM_MIE_G2 - ATM_MIE_2G*nu, 1e-4);
    return ATM_MIE_K * (1.0+nu*nu) / (base * sqrt(base));
}

// Distance from a point at radius r along direction with cosine mu to the top shell.
// Returns -1 if the ray escapes without entering the atmosphere from outside.
// W7: r ~6360 km so r*r ~4e7 OVERFLOWS fp16 (max 65504) -> r + the disc quadratic MUST be highp.
float atm_distToTop(highp float r, float mu) {
    highp float disc = r*r*(mu*mu - 1.0) + ATM_TOP2;
    if (disc < 0.0) return -1.0;
    return max(-r*mu + sqrt(disc), 0.0);
}
// Distance to ground sphere (ATM_BOTTOM), or -1 if no hit ahead.
float atm_distToGround(highp float r, float mu) {
    highp float disc = r*r*(mu*mu - 1.0) + ATM_BOTTOM2;
    if (disc < 0.0) return -1.0;
    highp float d = -r*mu - sqrt(disc);
    return d >= 0.0 ? d : -1.0;
}
// ANALYTIC-CONTINUATION ground distance for the atm_skyRadiance horizon blend: clamps the
// discriminant to >=0 instead of early-returning a -1 sentinel, so the result varies smoothly
// THROUGH the geometric tangent (matches the true atm_distToGround from both sides at disc==0,
// peaking at the tangent's horizon distance) rather than jumping to unrelated sentinel handling.
// Only meaningful/used within the small horizon blend band in atm_skyRadiance -- NOT a general
// replacement for atm_distToGround (which every other call site keeps using unchanged).
float atm_distToGround_continuous(highp float r, float mu) {
    highp float disc = max(r*r*(mu*mu - 1.0) + ATM_BOTTOM2, 0.0);
    return -r*mu - sqrt(disc);
}

// Analytic densities at radius r (altitude above ATM_BOTTOM).
// W7: r ~6360 (km-scale planet radius) and the (r - ATM_BOTTOM) altitude cancellation are highp -- at
// mediump fp16 the ~6360 radius resolves to ~4 km steps and the density profile (scale-height tens of
// km) would band/collapse. The exp() RESULT narrows to the mediump default.
// A-6: precomputed constants (mul instead of div; squared radii once).
const float ATM_INV_RAYLEIGH_H = 1.0 / ATM_RAYLEIGH_H;
const float ATM_INV_MIE_H      = 1.0 / ATM_MIE_H;
// dead-code (2026-06-15): atm_rayleighDensity/atm_mieDensity removed -- all call sites use atm_densities.
// A-5: merged densities -- compute the altitude (r - ATM_BOTTOM) ONCE for both species (called
// hundreds of times per sky pixel + per AP march step). Mathematically identical to the pair above.
void atm_densities(highp float r, out float dR, out float dM) {
    highp float alt = r - ATM_BOTTOM;
    dR = exp(-alt * ATM_INV_RAYLEIGH_H);
    dM = exp(-alt * ATM_INV_MIE_H);
}

// Optical depth (Rayleigh,Mie line integral) from point p0 along dir for distance d.
// Cheap fixed-step trapezoid; cheap enough for a fullscreen pass.
void atm_opticalDepth(highp vec3 p0, vec3 dir, float d, out float odR, out float odM) {   // W7: km-scale p0 -> highp
    const int N = 4;   // FPS: 8->4 trapezoid steps (2026-06-15). optical depth of a smooth exp density integral -- halving steps shifts the result <1% (witnessed visual-neutral); cuts the nested sky+AP cost.
    float dt = d / float(N);
    odR = 0.0; odM = 0.0;
    for (int i = 0; i < N; i++) {
        highp vec3 p = p0 + dir * (dt * (float(i) + 0.5));   // W7: km-scale march point
        float dRd, dMd; atm_densities(length(p), dRd, dMd);  // A-5: shared altitude once
        odR += dRd * dt;
        odM += dMd * dt;
    }
}

// Transmittance over a segment of length d from p0 along dir.
vec3 atm_transmittanceSeg(highp vec3 p0, vec3 dir, float d) {   // W7: km-scale p0 -> highp
    float odR, odM;
    atm_opticalDepth(p0, dir, d, odR, odM);
    return exp(-(ATM_RAYLEIGH * odR + ATM_MIE_EXT * odM));
}

// ===== PRECOMPUTED TRANSMITTANCE LUT (Bruneton-lite) =====
// Baked once (CPU, src/atmosphere-transmittance-lut.js) and uploaded as an RGB32F texture:
// texel (u,v) encodes transmittance(r,mu) from a point at radius r looking along view-angle
// cosine mu OUT to the top of the atmosphere. Replaces the runtime N=4 fixed-step trapezoid
// march atm_transmittanceToSun previously ran on every call (itself called up to 8x per sky
// pixel from atm_marchRadiance's own per-sample loop, plus once per aerial-perspective march
// step) with a single texture sample. atm_transmittanceSeg/atm_opticalDepth stay UNCHANGED
// below -- atm_marchRadiance's camera-to-SAMPLE transmittance is a different, shorter-segment
// quantity this top-of-atmosphere LUT does not directly encode. (The scattering LUT below +
// terrain.glsl's aerial-perspective integration, both routed through atm_marchRadiance, landed
// as the follow-up this comment used to point at -- see atm_scatteringLUTSample /
// uUseScatteringLUT and terrain.glsl's AERIAL PERSPECTIVE block.)
uniform sampler2D uTransmittanceLUT;
const float ATM_RHO_MAX = sqrt(ATM_TOP2 - ATM_BOTTOM2);   // horizon distance at the top shell
// (r,mu) -> LUT uv. MUST mirror atmosphere-transmittance-lut.js's rFromU/uFromR/muFromV exactly
// (both directions -- bake writes with this parameterization, shader reads must invert it the
// same way) or the LUT samples the wrong texel for a given (r,mu).
vec2 atm_lutUV(highp float r, float mu) {
    highp float rho = sqrt(max(r * r - ATM_BOTTOM2, 0.0));
    float u = clamp(rho / ATM_RHO_MAX, 0.0, 1.0);
    highp float dMin = ATM_TOP - r;                 // distance to top at mu=1 (zenith)
    highp float dMax = rho + ATM_RHO_MAX;           // distance to top at the horizon-grazing mu
    highp float d = atm_distToTop(r, mu);
    float v = (dMax > dMin) ? clamp((d - dMin) / (dMax - dMin), 0.0, 1.0) : 0.0;
    return vec2(u, v);
}
// Sample the LUT directly (r,mu) -> transmittance, no horizon soft-attenuation applied (that's
// a property of the SUN's dip below the horizon at the query point, not of the atmosphere's
// optical depth -- stays a post-multiply in atm_transmittanceToSun below, unchanged from before).
vec3 atm_transmittanceLUTSample(highp float r, float mu) {
    return texture(uTransmittanceLUT, atm_lutUV(r, mu)).rgb;
}

// Transmittance from point p to the top of the atmosphere along sun direction.
vec3 atm_transmittanceToSun(highp vec3 p, vec3 sun) {   // W7: km-scale p -> highp
    highp float r = length(p);
    float mu = dot(p, sun) / r;
    // SOFT sea-level horizon (user 2026-06-11 'shading indicates depth not slope' -- THE math bug):
    // the old branch returned a BINARY vec3(0) whenever the sun ray intersected the ATM_BOTTOM
    // sphere. ATM_BOTTOM is SEA LEVEL, so at low sun the direct light became a hard step function
    // of ELEVATION (every point below a sun-dependent altitude got zero sun, every point above got
    // full sun) -- slope-blind, elevation-keyed dark patches that read as 'depth shading' + dark
    // rocky blobs. Replace with a smooth attenuation over ~2 deg of sun dip below the sea horizon:
    // night stays dark, the elevation step is gone, slopes drive the shading again.
    float muHoriz = -sqrt(max(0.0, 1.0 - ATM_BOTTOM2 / (r * r)));
    float soft = smoothstep(muHoriz - 0.035, muHoriz + 0.005, mu);
    if (soft <= 0.0) return vec3(0.0);          // A-3: night-side returns BEFORE the optical-depth march
    // LUT REPLACES the runtime atm_transmittanceSeg march here (was: atm_distToTop + atm_transmittanceSeg
    // -- an N=4 trapezoid optical-depth integral run fresh on every call). The LUT already encodes
    // transmittance to the top-of-atmosphere boundary for exactly this (r,mu) pair at far higher
    // (500-step offline) precision than the runtime march ever used.
    return atm_transmittanceLUTSample(r, mu) * soft;
}

// ===== PRECOMPUTED SCATTERING LUT (Bruneton-lite, single-scatter in-scattered radiance) =====
// Baked once (CPU, src/atmosphere-scattering-lut.js) and uploaded as an RGBA32F sampler2DArray:
// texel (u,v,layer) encodes (rgb=Rayleigh inscatter density, a=Mie inscatter density) from a point
// at radius r looking along view-angle cosine mu with sun-angle cosine muS, out to the top of the
// atmosphere. Replaces atm_marchRadiance's own runtime N=8 per-sample Rayleigh/Mie accumulation
// loop with a single texture-array sample (u,v identical parameterization to the transmittance
// LUT's own atm_lutUV; the 3rd axis muS maps to an ARRAY LAYER via atm_scatMuSToLayer, mirroring
// atmosphere-scattering-lut.js's muSFromLayer/layerFromMuS -- both directions must invert exactly
// or the LUT samples the wrong texel/layer). Gated behind uUseScatteringLUT (default OFF, an
// explicit A/B lever) so the existing runtime march stays available as a fallback/comparison path,
// matching this codebase's own house style for analytic-vs-LUT levers (uUseScatteringLUT mirrors
// the existing aerialAmt-style debug-lever discipline).
uniform sampler2DArray uScatteringLUT;
uniform float uUseScatteringLUT;   // 0 = runtime march (default, unchanged behavior), 1 = LUT fast path
const float ATM_SCAT_LAYERS = 24.0;   // MUST mirror atmosphere-scattering-lut.js's SCAT_LUT_LAYERS
// muS (sun-angle cosine, [-1,1]) -> array layer (float, for a manual 2-layer lerp -- textureArray
// sampling does NOT interpolate across the layer/w axis in WebGL2, only within a layer's u/v, so a
// smooth cross-layer blend needs an explicit 2-tap lerp here). Inverse of muSFromLayer's tanh warp:
// muSFromLayer(l) = tanh(k*(2*(l+0.5)/layers - 1)) / tanh(k)  =>  invert for a continuous layer coord.
const float ATM_SCAT_K = 1.4;   // MUST mirror atmosphere-scattering-lut.js's muSFromLayer warp strength
float atm_scatMuSToLayerF(float muS) {
    float th = tanh(ATM_SCAT_K);
    float t = atanh(clamp(muS * th, -0.999999, 0.999999)) / ATM_SCAT_K;   // inverse tanh warp -> t in [-1,1]
    float w = clamp((t + 1.0) * 0.5, 0.0, 1.0);
    return clamp(w * ATM_SCAT_LAYERS - 0.5, 0.0, ATM_SCAT_LAYERS - 1.0);   // continuous layer coordinate
}
// Sample the scattering LUT at (r,mu,muS) -> {inscatR (rgb), inscatM (scalar)}, packed vec4(rgb,a).
// Manual bilinear-across-layers (texture() on a sampler2DArray only interpolates u/v within one
// layer, never across the layer index) -- two texture() taps + a lerp, matching how a real 3D
// texture's built-in trilinear would blend the 3rd axis, at the cost of one extra tap.
vec4 atm_scatteringLUTSample(highp float r, float mu, float muS) {
    vec2 uv = atm_lutUV(r, mu);   // identical (u,v) parameterization to the transmittance LUT
    float lf = atm_scatMuSToLayerF(muS);
    float l0 = floor(lf);
    float l1 = min(l0 + 1.0, ATM_SCAT_LAYERS - 1.0);
    float lt = lf - l0;
    vec4 s0 = texture(uScatteringLUT, vec3(uv, l0));
    vec4 s1 = texture(uScatteringLUT, vec3(uv, l1));
    return mix(s0, s1, lt);
}

// Single-scatter Rayleigh+Mie march from `camera` along `viewRay` out to distance `dEnd`.
// Factored out of atm_skyRadiance so the ground-hit and sky-miss cases can be marched
// separately and blended (see atm_skyRadiance below) instead of hard-branching on which
// endpoint to use -- extracting this avoids duplicating the march loop for the blend.
// `steps` parameterizes the runtime-march-fallback iteration count (the LUT fast path above
// ignores it entirely -- 2-4 texture taps regardless of steps). GLSL ES 3.00 has no default
// arguments, so every call site passes it explicitly; atm_skyRadiance's own call keeps its
// original N=8, while terrain.glsl's aerial-perspective call passes 4 to preserve its own
// distinct FPS-tuned step count (see the AERIAL PERSPECTIVE block: this march runs on every
// hazed terrain fragment, sky's runs once per sky pixel -- deliberately kept cheaper, matching
// the pre-LUT-integration inline march's own `const int APN = 4` budget exactly).
vec3 atm_marchRadiance(highp vec3 camera, vec3 viewRay, vec3 sun, float dEnd, int steps, out vec3 transmittance) {
    highp float r = length(camera);
    float mu = dot(camera, viewRay) / r;
    float muS = dot(camera, sun) / r;   // camera-local sun-angle cosine, the scattering LUT's 3rd axis
    float nu = dot(viewRay, sun);
    highp float dTop = atm_distToTop(r, mu);

    // LUT FAST PATH (explicit A/B lever, default off -- uUseScatteringLUT): the LUT was baked for
    // the FULL march from camera to the top of the atmosphere (matches atm_marchRadiance's sky-miss
    // call shape exactly). When dEnd is shorter (the ground-hit case, dEnd=dGround < dTop), the
    // baked full-path in-scatter is NOT directly usable as-is -- but the analytic single-scatter
    // integral is additive along the ray: inscatter(camera->dTop) = inscatter(camera->dEnd) +
    // transmittance(camera->dEnd) * inscatter(atEnd->dTop). Since this codebase's single-scatter
    // model has no ground-albedo bounce term feeding back into inscatter (the ground-hit case's
    // OWN march already stops at the ground and does not add a reflected contribution), the correct
    // partial-path recovery is: inscatter(camera->dEnd) = inscatter(camera->dTop) - transmittance
    // (camera->dEnd) * inscatter(atEnd->dTop). The second term needs a SECOND LUT sample at the
    // ground-hit point (atEnd's own r/mu/muS) -- still just 2 texture-array taps (4 with the
    // cross-layer lerp) total, far cheaper than the N=8 runtime march it replaces.
    if (uUseScatteringLUT > 0.5 && dTop > 0.0) {
        vec4 fullScat = atm_scatteringLUTSample(r, mu, muS);
        vec3 inscatR = fullScat.rgb;
        float inscatM = fullScat.a;
        vec3 tFull = atm_transmittanceLUTSample(r, mu);   // camera -> top-of-atmosphere transmittance (unclamped, no horizon soft-attenuation -- that's a SUN-visibility concept, not a view-ray transmittance one)
        if (dEnd < dTop - 1e-4) {
            // Partial-path (ground-hit) case: subtract the tail beyond dEnd.
            highp vec3 pEnd = camera + viewRay * dEnd;
            highp float rEnd = length(pEnd);
            float muEnd = dot(pEnd, viewRay) / rEnd;   // view-ray cosine AT the end point (same ray direction, new local radius)
            float muSEnd = dot(pEnd, sun) / rEnd;
            vec4 tailScat = atm_scatteringLUTSample(rEnd, muEnd, muSEnd);
            vec3 tToEnd = atm_transmittanceLUTSample(r, mu) / max(atm_transmittanceLUTSample(rEnd, muEnd), vec3(1e-6));   // camera->end = (camera->top) / (end->top), both already LUT-backed
            inscatR = max(inscatR - tToEnd * tailScat.rgb, vec3(0.0));
            inscatM = max(inscatM - dot(tToEnd, vec3(1.0/3.0)) * tailScat.a, 0.0);
            transmittance = tToEnd;
        } else {
            transmittance = tFull;
        }
        return ATM_SOLAR_IRRADIANCE * (
            inscatR * ATM_RAYLEIGH * atm_rayleighPhase(nu) +
            inscatM * ATM_MIE      * atm_miePhase(nu));
    }

    // FPS: 16->8 single-scatter march steps (2026-06-15) for the sky-pass call (steps=8 passed
    // in by atm_skyRadiance). With opticalDepth at 4 the inner cost is 4x lower per step; the sky
    // gradient is a smooth analytic integral so 8 steps is visually negligible (witnessed). Nested
    // cost 16*8=128 -> 8*4=32 (-75%). `steps` is a RUNTIME value here (not `const int`), same
    // runtime-bound discipline as fractalTerrainH's uOctMax (AGENTS.md FXC unroll caveat) -- a
    // constant-bound loop risks the same ANGLE/D3D11 FXC full-unroll mis-translation class.
    float dt = dEnd / float(steps);
    vec3 inscatR = vec3(0.0);
    vec3 inscatM = vec3(0.0);
    float odR = 0.0, odM = 0.0; // accumulated optical depth from camera to sample

    vec3 tView = vec3(1.0);   // A-4: hoisted; the last iteration's value IS the view transmittance
    for (int i = 0; i < steps; i++) {
        highp vec3 p = camera + viewRay * (dt * (float(i) + 0.5));   // W7: km-scale march point -> highp
        float dRd, dMd; atm_densities(length(p), dRd, dMd);          // A-5: shared altitude once
        float dR = dRd * dt;
        float dM = dMd * dt;
        odR += dR; odM += dM;
        // transmittance camera->sample
        tView = exp(-(ATM_RAYLEIGH * odR + ATM_MIE_EXT * odM));
        // transmittance sample->sun
        vec3 tSun = atm_transmittanceToSun(p, sun);
        vec3 t = tView * tSun;
        inscatR += t * dR;
        inscatM += t * dM;
    }
    transmittance = tView;   // A-4: == exp(-(tau)) of the last sample, no recompute
    return ATM_SOLAR_IRRADIANCE * (
        inscatR * ATM_RAYLEIGH * atm_rayleighPhase(nu) +
        inscatM * ATM_MIE      * atm_miePhase(nu));
}

// Sky in-scatter radiance + view transmittance along a view ray from cameraIn.
// camera/view in atmosphere-space km. Single-scatter Rayleigh+Mie integration.
//
// GROUND/SKY HORIZON SEAM FIX (consumer report: a bright ~1px-wide horizontal streak at the
// water/terrain horizon line at grazing view angles). Root cause: the old code hard-branched
// march distance on `ground = dGround > 0.0` -- a ray a fraction of a degree from the exact
// geometric tangent that still (barely) hits the ATM_BOTTOM sphere marched only ~dGround (a
// few km, since a near-tangent ground hit is close by construction: d -> sqrt(2*ATM_BOTTOM*alt)
// at the tangent), while the immediately adjacent ray that (barely) MISSES marched all the way
// to dTop (~1000+ km, the far side of the shell) -- a >100x jump in path length one ray-step
// apart, and thus in accumulated in-scatter radiance (witnessed numerically: >2x luminance
// jump within 0.005 degrees of view angle, collapsing to a single screen row at typical FOV).
// Fix: (1) atm_distToGround now clamps its discriminant to >=0 instead of returning a sentinel
// -1, so the ground distance itself is an ANALYTIC CONTINUATION that varies smoothly through
// the tangent (matches from both sides at disc=0, peaking at the true horizon distance) rather
// than jumping to unrelated sentinel handling; (2) blend the ground-path and sky-path radiance
// with a smoothstep window in mu centered on the analytic tangent mu, the same horizon-softening
// pattern atm_transmittanceToSun already uses a few lines up for the sun-visibility test. Window
// width is a fixed small band in mu-space (not tied to display resolution) so the blend is
// physically continuous everywhere, not just less-visibly-discontinuous.
const float ATM_HORIZON_BLEND_MU = 0.006;
vec3 atm_skyRadiance(highp vec3 cameraIn, vec3 viewRay, vec3 sun, out vec3 transmittance) {   // W7: km-scale camera -> highp
    highp vec3 camera = cameraIn;
    highp float r = length(camera);
    float mu = dot(camera, viewRay) / r;

    // March-start: if outside the atmosphere, advance to the top shell.
    if (r > ATM_TOP) {
        float dt = atm_distToTop(r, mu);
        if (dt < 0.0) { transmittance = vec3(1.0); return vec3(0.0); } // misses atmosphere
        camera = camera + viewRay * dt;
        r = length(camera);
        mu = dot(camera, viewRay) / r;
    }

    float dTop = atm_distToTop(r, mu);
    if (dTop <= 0.0) { transmittance = vec3(1.0); return vec3(0.0); }

    // Analytic tangent mu (disc==0 for the ground sphere) -- the exact geometric horizon.
    float muTangent = -sqrt(max(0.0, 1.0 - ATM_BOTTOM2 / (r * r)));
    float wSky = smoothstep(muTangent - ATM_HORIZON_BLEND_MU, muTangent + ATM_HORIZON_BLEND_MU, mu);

    vec3 transSky;
    vec3 radSky = atm_marchRadiance(camera, viewRay, sun, dTop, 8, transSky);
    if (wSky >= 1.0) { transmittance = transSky; return radSky; }   // well clear of the horizon: sky-only, no extra march cost

    float dGround = max(atm_distToGround_continuous(r, mu), 1e-3);
    vec3 transGround;
    vec3 radGround = atm_marchRadiance(camera, viewRay, sun, dGround, 8, transGround);
    if (wSky <= 0.0) { transmittance = vec3(0.0); return radGround; }   // well inside the ground hit: fully occluded, as before

    transmittance = mix(vec3(0.0), transSky, wSky);
    return mix(radGround, radSky, wSky);
}

// Sun + sky irradiance reaching a surface point with given normal.
// Returns DIRECT sun irradiance (already * N.L); sky_irradiance is the ambient term.
// DIFFUSE WRAP (user 2026-06-10 'looking down the horizon at grass it gets darker'): pure Lambert
// kills slopes tilted a few degrees off the sun, so a downward view (which preferentially shows
// ripple backsides) reads darker than the grazing view of the same field. Wrap lifts away-facing
// gentle slopes (N.L -> (N.L+w)/(1+w)) -- soft-knee terrain diffuse, view-angle gradient gone.
// Unset by programs that do not bind it (GL zero-default) -> plain Lambert there (sky pass).
vec3 atm_sunSkyIrradiance(highp vec3 point, vec3 normal, vec3 sun, out vec3 sky_irradiance) {   // W7: km-scale point -> highp
    highp float r = length(point);
    vec3 up = point / r;
    float muS = dot(up, sun);
    // ELEVATION-INDEPENDENT direct sun (user 2026-06-11 'normals appear elevation based again' --
    // the recurring class, previously narrowed by 1263c51 but not killed): BOTH the sea-horizon cut
    // (muHoriz is a function of r) and the sun-path optical depth key on the POINT'S RADIUS, so at
    // low sun the direct light is a smooth function of terrain ELEVATION -- slope-blind brightness
    // gradients across whole regions that read as 'height-based normals'. Evaluate the sun
    // transmittance on a FIXED shell (sea level + 0.5 km): day/night and sunset reddening still
    // follow the sun's local altitude (mu via `up`), but terrain elevation can no longer modulate
    // direct light -- slope (N.sun) owns the shading. The sky/AP marches keep their per-point
    // physics (airborne sample points genuinely differ); only the SURFACE direct term is pinned.
    vec3 tSun = atm_transmittanceToSun(up * (ATM_BOTTOM + 0.5), sun);
    vec3 direct = ATM_SOLAR_IRRADIANCE * tSun * clamp(dot(normal, sun), 0.0, 1.0);
    // Sky (ambient) dome: Rayleigh-tinted, scaled by how much sky the surface sees
    // and by daylight (smoothstep over the terminator). Hemispheric weight (1+N.up)/2.
    float day = smoothstep(-0.10, 0.25, muS);
    // Desaturate the sky-ambient tint toward white: raw Rayleigh (b~4x r) washed lit land
    // fully blue. mostly-white ambient lights terrain without recoloring it blue.
    vec3 rayTint = ATM_RAYLEIGH / (ATM_RAYLEIGH.x);
    vec3 skyTint = mix(vec3(1.0), rayTint, 0.4);
    // SUN-vs-SKY BALANCE (user 2026-06-02: 'normals arent affecting the lit view properly'). The
    // sky ambient is weighted by N.up (near-directionless), so a too-large ambient washes out the
    // directional N.sun sun term and opposing slopes barely differ -> normals look like they dont
    // shade. Cut the ambient coefficient (0.14 -> 0.075) so the DIRECT sun (which carries the normal
    // via N.sun) dominates and slopes self-shade; the (1+N.up)/2 dome weight stays so it still fills
    // shadowed faces without flattening them. An ambient floor downstream keeps shadows non-black.
    sky_irradiance = ATM_SOLAR_IRRADIANCE * 0.075 * day * skyTint
                     * (0.5 * (1.0 + dot(normal, up)));
    return direct;
}
