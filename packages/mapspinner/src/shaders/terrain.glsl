
uniform highp float defRadius;
uniform highp mat4 defViewProjNoEye;
uniform highp vec3 defCamDir;
uniform highp float defCamAlt;

uniform sampler2DArray hpfPool;
uniform sampler2DArray hpfPool2;
uniform int hasHpf;
uniform float uHpfInset;
uniform int uFloatLinearOK;
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
highp vec4 hpfSample(vec3 dir) {
    if (hasHpf == 0) return vec4(0.0, 1.0, 0.5, 0.5);
    int face; vec2 uv; hpfFaceUV(normalize(dir), face, uv);
    vec2 sz = vec2(textureSize(hpfPool, 0).xy);
    bool inset = uHpfInset > 0.5;
    vec2 denom = inset ? (sz - 1.0) : sz;
    vec2 t  = inset ? (uv * denom) : (uv * sz - 0.5);
    vec2 t0 = floor(t);
    vec2 f  = t - t0;
    vec2 hb = 0.5 / sz;
    vec2 c0 = inset ? (t0)              / denom : clamp((t0 + 0.5)        / sz, hb, 1.0 - hb);
    vec2 c1 = inset ? (t0 + vec2(1.0, 0.0)) / denom : clamp((t0 + vec2(1.5, 0.5)) / sz, hb, 1.0 - hb);
    vec2 c2 = inset ? (t0 + vec2(0.0, 1.0)) / denom : clamp((t0 + vec2(0.5, 1.5)) / sz, hb, 1.0 - hb);
    vec2 c3 = inset ? (t0 + vec2(1.0, 1.0)) / denom : clamp((t0 + 1.5)        / sz, hb, 1.0 - hb);
    vec2 uv00 = clamp(c0, vec2(0.0), vec2(1.0));
    vec2 uv10 = clamp(c1, vec2(0.0), vec2(1.0));
    vec2 uv01 = clamp(c2, vec2(0.0), vec2(1.0));
    vec2 uv11 = clamp(c3, vec2(0.0), vec2(1.0));
    float ff = float(face);
    vec2 s00 = texture(hpfPool,  vec3(uv00, ff)).rg;
    vec2 s10 = texture(hpfPool,  vec3(uv10, ff)).rg;
    vec2 s01 = texture(hpfPool,  vec3(uv01, ff)).rg;
    vec2 s11 = texture(hpfPool,  vec3(uv11, ff)).rg;
    vec2 w = f*f*f*(f*(f*6.0-15.0)+10.0);
    vec2 se  = mix(mix(s00, s10, w.x), mix(s01, s11, w.x), w.y);
    vec2 t00 = texture(hpfPool2, vec3(uv00, ff)).rg;
    vec2 t10 = texture(hpfPool2, vec3(uv10, ff)).rg;
    vec2 t01 = texture(hpfPool2, vec3(uv01, ff)).rg;
    vec2 t11 = texture(hpfPool2, vec3(uv11, ff)).rg;
    vec2 th  = mix(mix(t00, t10, w.x), mix(t01, t11, w.x), w.y);
    return vec4(se.x, se.y, th.x, th.y);
}

highp float h3(highp vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z) * 2.0 - 1.0;
}
float snoise3(highp vec3 P) {
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
    return mix(mix(x00,x10,u.y), mix(x01,x11,u.y), u.z);
}
uniform int uNoUnroll;
float value_fbm(highp vec3 x, float gain, int numOctaves) {
    float v=0.0, a=1.0, norm=0.0;
    highp vec3 p=x;
    int nb = numOctaves + ((uNoUnroll > 0) ? (uNoUnroll - 64) : 0);
    for(int i=0;i<nb;i++){ v+=a*snoise3(p); norm+=a; a*=gain; p*=2.0; }
    return v/norm;
}
float value_fbm_scaled(highp vec3 x, float gain, int numOctaves, float lo, float hi) {
    return lo + (hi-lo) * (value_fbm(x,gain,numOctaves)*0.5+0.5);
}
highp vec3 rotate_domain(highp vec3 pos, float angle) {
    float c=cos(angle), s=sin(angle);
    return vec3(c*pos.x-s*pos.z, pos.y, s*pos.x+c*pos.z);
}
float value_ridged_fbm_rot(highp vec3 x_in, float gain, int numOctaves, float offset, float exponent) {
    float v=0.0, w=1.0, norm=0.0, a=1.0;
    highp vec3 p=x_in;
    int nb = numOctaves + ((uNoUnroll > 0) ? (uNoUnroll - 64) : 0);
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
const int LTYPE_FBM = 0;
const int LTYPE_RIDGED = 1;
struct NoiseLayer { int ltype; int numOct; float gain; float ridgeOffset; float ridgeExp; float warpStr; float hmin; float hmax; };
const NoiseLayer noiseLayerBase = NoiseLayer(LTYPE_RIDGED, 23, 0.5, 1.064, 1.665, 0.45, 0.0, 1.0);
const NoiseLayer noiseLayer0 = NoiseLayer(LTYPE_RIDGED, 10, 0.5, 1.064, 1.005, 1.6, 0.0, 1.0);
const NoiseLayer noiseLayer1 = NoiseLayer(LTYPE_FBM,    18, 0.5, 1.064, 1.665, 2.6, -2.0, 2.0);
const NoiseLayer noiseLayer2 = NoiseLayer(LTYPE_RIDGED, 18, 0.5, 1.064, 1.1,   0.9, -2.0, 2.0);
float eval_layer(highp vec3 pos, NoiseLayer L) {
    float raw;
    float t;
    if (L.ltype == LTYPE_FBM) {
        raw = value_fbm(pos, L.gain, L.numOct);
        t = raw * 0.5 + 0.5;
    } else {
        raw = value_ridged_fbm_rot(pos, L.gain, L.numOct, L.ridgeOffset, L.ridgeExp);
        t = raw;
    }
    return L.hmin + (L.hmax - L.hmin) * t;
}
float sample_fractal_terrain(highp vec3 pCoords) {
    float h0 = eval_layer(pCoords, noiseLayer0);
    highp vec3 warpOff = pCoords * noiseLayer0.warpStr * h0;
    highp vec3 warped  = pCoords + warpOff;
    float h1 = eval_layer(warped,   noiseLayer1);
    float h2 = eval_layer(warped,   noiseLayer2);
    return (h0 + h1 + h2) / 3.0;
}
const float PI = 3.14159265;
highp float fractalTerrainH(vec3 dir0) {
    highp vec3 dirN = normalize(dir0);
    highp vec3 p = dirN * 3.0;

    float raw = sample_fractal_terrain(p);
    float h = (raw - 0.17) * 0.6;

    float pmix = snoise3(p * 0.53 + vec3(123.0, 456.0, 789.0)) * 0.5 + 0.5;
    float vPower = mix(0.95, 1.3, pmix);

    if (h > 0.0) h = pow(h, 0.8 * vPower);
    else h = -pow(-h, 0.8 * vPower);

    float cRatio = clamp(snoise3(dirN * 4.0) * 0.5 + 0.7, 0.3, 1.0);
    h *= cRatio;

    return h;
}

highp float vhash(highp vec2 p){
  uvec2 q = uvec2(ivec2(p));
  uint h = q.x * 1597334677u + q.y * 3812015801u;
  h ^= h >> 16; h *= 2654435769u; h ^= h >> 15; h *= 2246822519u; h ^= h >> 13;
  return float(h) * (1.0 / 4294967296.0);
}
float vnoise2(highp vec2 p){ highp vec2 i=floor(p),f=p-i; vec2 u=f*f*f*(f*(f*6.0-15.0)+10.0);
  float a=vhash(i),b=vhash(i+vec2(1,0)),c=vhash(i+vec2(0,1)),d=vhash(i+vec2(1,1));
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y)*2.0-1.0; }
highp vec2 faceWarp(highp vec2 p){ return defRadius * tan((p / defRadius) * 0.7853981634); }
uniform float uReliefScale;
uniform float uGrid;
uniform float uNrmStepM;
uniform float uLandBias;
uniform float uBeachShelfM;

uniform float uSculptActive;
uniform highp vec3 uSculptUp;
uniform highp vec3 uSculptEast;
uniform highp vec3 uSculptNorth;
uniform highp vec2 uSculptCenter;
uniform float uSculptExtent;
uniform sampler2D uSculptOverride;

#if defined(_VERTEX_) || defined(_PROBE_) || defined(_HEIGHTBAKE_)
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

highp float composeHeight(vec3 dir0, highp vec2 faceLocal, float tileM){
    highp float frac = fractalTerrainH(dir0);
    highp float h = frac * 750000.0 + uLandBias;
    if (h < 0.0) {
        h = max(h * 1.25, -350000.0);
    } else {
        highp float bShelf = uBeachShelfM > 1.0 ? uBeachShelfM : 150.0;
        if (h < bShelf) h = (h * h / bShelf) * (2.0 - h / bShelf);
    }
    h = h * (uReliefScale > 0.0 ? uReliefScale : 1.0);
    h += sculptOverrideAt(dir0);
    return h;
}
#endif

uniform float uIsWater;
uniform float uUnderwater;
uniform float uBeachTopM;

uniform float uWetness;

uniform highp float oceanTime;
uniform float oceanAmp;
uniform float oceanChoppy;
uniform float oceanFoam;

float seaHash(vec2 p) {
    uvec2 q = uvec2(ivec2(p)) * uvec2(1597334673u, 3812015801u);
    uint  n = (q.x ^ q.y) * 1597334673u;
    return float(n) * (1.0 / 4294967296.0);
}
float seaNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = p - i;
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
layout(location=0) in vec3 vertex;
layout(location=1) in highp vec4 iOffset;
layout(location=2) in float iFace;
layout(location=3) in float iLayer;
uniform float uMorphSplitDist;
uniform float uMorphDistFactor;
uniform float uMorphMaxLevel;
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
out highp vec3 vWorld;
out highp float vH;
out highp vec3 vNrm;
out vec3 vTexWarp;

out highp vec3 vTexRel;
out float vLevel;
out vec2  vGrid;
out vec4 vClimate;

mat3 faceFrame(float f){
    int i = int(f + 0.5);
    if (i==0) return mat3( 0.0,0.0,-1.0,  0.0,1.0,0.0,   1.0,0.0,0.0);
    if (i==1) return mat3( 0.0,0.0, 1.0,  0.0,1.0,0.0,  -1.0,0.0,0.0);
    if (i==2) return mat3( 1.0,0.0,0.0,   0.0,0.0,-1.0,  0.0,1.0,0.0);
    if (i==3) return mat3( 1.0,0.0,0.0,   0.0,0.0, 1.0,  0.0,-1.0,0.0);
    if (i==4) return mat3( 1.0,0.0,0.0,   0.0,1.0,0.0,   0.0,0.0,1.0);
    return            mat3(-1.0,0.0,0.0,  0.0,1.0,0.0,   0.0,0.0,-1.0);
}

highp float continentalBias(vec3 dir) { return hpfSample(dir).r; }


void main() {
    highp vec4 defOffset = iOffset;
    mat3 defLocalToWorld = faceFrame(iFace);

    highp vec2 absLocal = defOffset.xy + vertex.xy * defOffset.z;
    highp float vMorph = 0.0;
    if (vertex.z < 0.5 && uIsWater < 0.5 && uGrid > 0.0 && uMorphSplitDist > 0.0 && defOffset.w >= 1.0 && defOffset.w < uMorphMaxLevel) {
        highp vec3 campWorld = defCamDir * (defRadius + defCamAlt);
        highp vec3 vtxDir0 = normalize(defLocalToWorld * vec3(faceWarp(absLocal), defRadius));
        highp float distToCam = distance(vtxDir0 * defRadius, campWorld);
        highp float threshold = defOffset.z * uMorphSplitDist * uMorphDistFactor;
        highp float morphEnd = threshold * 2.0;
        highp float m = (morphEnd - distToCam) / (morphEnd - threshold);
        vMorph = clamp(m, 0.0, 1.0);
        vMorph = vMorph * vMorph * (3.0 - 2.0 * vMorph);
    }
    if (vMorph > 0.0) {
        highp float parentCell = (2.0 * defOffset.z) / uGrid;
        highp vec2 coarseAbs = round(absLocal / parentCell) * parentCell;
        absLocal = mix(absLocal, coarseAbs, vMorph);
    }
    highp vec2 vxy = (absLocal - defOffset.xy) / defOffset.z;
    highp vec2 faceLocal = faceWarp(absLocal);
    vec3 dir0 = normalize(defLocalToWorld * vec3(faceLocal, defRadius));
    highp vec4 hpf0 = hpfSample(dir0);

    highp float hN0 = 0.0;
    highp vec3 vN = dir0;
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
in highp vec3 vWorld;
in vec3 vTexWarp;
in highp float vH;
in highp vec3 vNrm;

in float vLevel;
in vec2  vGrid;
in highp vec3 vTexRel;
uniform highp vec3 uTexCamFrac;
uniform float uWireframe;
uniform float uFsCheap;
uniform highp sampler2D uSceneDepth;
uniform float uOccludeDepth;
uniform float uDepthOnly;
uniform float uWaterVisProbe;
in vec4 vClimate;
layout(location=0) out vec4 fragColor;

uniform vec3 sunDir;
uniform int displayMode;
uniform highp vec3 camWorld;
uniform highp float terrainR;
uniform sampler2D uSceneTex;
uniform vec2 uResolution;

uniform highp float uHasShadow;
uniform highp mat4  uShadowMatrix;
uniform highp sampler2DShadow uShadowMap;
uniform highp float uShadowBias;
uniform highp float uShadowTexelSize;

highp float sampleHostShadow(highp vec3 worldPos) {
    if (uHasShadow < 0.5) return 1.0;
    highp vec4 sc = uShadowMatrix * vec4(worldPos, 1.0);
    if (sc.w <= 0.0) return 1.0;
    highp vec3 proj = sc.xyz / sc.w;
    if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z < 0.0 || proj.z > 1.0) return 1.0;
    highp float sum = 0.0;
    sum += texture(uShadowMap, vec3(proj.xy + vec2(-1.5, -0.5) * uShadowTexelSize, proj.z));
    sum += texture(uShadowMap, vec3(proj.xy + vec2( 0.5, -1.5) * uShadowTexelSize, proj.z));
    sum += texture(uShadowMap, vec3(proj.xy + vec2( 1.5,  0.5) * uShadowTexelSize, proj.z));
    sum += texture(uShadowMap, vec3(proj.xy + vec2(-0.5,  1.5) * uShadowTexelSize, proj.z));
    return sum * 0.25;
}
float seaHeight(highp vec2 p, highp float t, int oStart, int oEnd) {
    const float SEA_FREQ  = 0.2;
    const float SEA_SPEED = 2.4;
    const float SEA_AMP_M = 0.6;
    float freq    = SEA_FREQ;
    float amp     = oceanAmp * SEA_AMP_M;
    float choppy  = oceanChoppy;
    vec2 seaTime  = vec2(t * SEA_SPEED * 0.6, t * SEA_SPEED * 0.4);
    float h = 0.0;
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
vec2 oceanWaveSlope(highp vec2 p, highp float t, int oStart, int oEnd) {
    const float eps = 0.25;
    float h  = seaHeight(p,            t, oStart, oEnd);
    float hx = seaHeight(p + vec2(eps, 0.0), t, oStart, oEnd);
    float hy = seaHeight(p + vec2(0.0, eps), t, oStart, oEnd);
    return vec2(hx - h, hy - h) / eps;
}
vec2 oceanWaveSlopeLF(highp vec2 p, highp float t) {
    const float SEA_FREQ_LF = 0.16;
    const float SEA_SPEED   = 2.4;
    const float SEA_AMP_M   = 0.6;
    const float eps = 1.25;
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

uniform vec3 bcDeepSea, bcSea, bcShore, bcLowland, bcGrass, bcRock, bcSnow;
uniform vec2 bandEdgesLo;
uniform vec2 bandEdgesHi;
uniform vec2 snowEdges;
uniform float seaDepthM;
uniform vec2 slopeRock;
uniform float uAoAmt;
uniform vec3  uOceanDeep;
uniform vec3  uOceanShallow;
uniform vec3  uOceanK;
uniform float uVariationAmt;
uniform float uHazeMul;
uniform float uFlatNormal;
uniform float uSkyFill;
uniform float uTerminatorGlow;
uniform float uNightLights;
uniform float uNightFloor;
uniform float uTermWidth;
uniform float uExposure;
uniform float uLookSat;
uniform float uLookContrast;
uniform sampler2DArray uSurfAlb;
uniform sampler2DArray uSurfNrm;
uniform float uHasSurfTex;
uniform float uTexTileM;
uniform float uTexNrmK;
uniform float uTexMix;
uniform float uTexWarp;
uniform float uReliefShade;
uniform float uTexPhoto;
uniform float uTexPhotoNear;
uniform vec4 uSurfMeanL;
uniform float uBiomeTint;
uniform float uTexBright;
uniform float uTexSat;
uniform float uXSoft;
uniform float uXFinger;
uniform float uOrdPush;
uniform float uBiomeWarp;
uniform float uNrmLow;
uniform float uXFade0;
uniform float uXFade1;
uniform float uTriSharp;
uniform float uNrmFade0;
uniform float uNrmFade1;
uniform float uBandWarp;
uniform float uBeachWidth;
uniform float uTexFar0;
uniform float uTexFar1;
uniform float uOctFar0;
uniform float uOctFar1;
vec3 terrainAlbedo(float h, float slope, float rockSlope, highp vec3 worldPos, highp vec3 nwp, float pxW) {
    float rockWiden = smoothstep(20.0, 500.0, pxW) * 0.20;
    vec3 c;
    if (h < 0.0) {
        float depthT = clamp(-h / 300.0, 0.0, 1.0);
        vec3 bcShelf  = bcShore;
        vec3 bcSilt   = vec3(0.12, 0.11, 0.09);
        vec3 bcBasalt = vec3(0.06, 0.06, 0.07);
        vec3 bedBase  = mix(bcShelf, bcSilt,   smoothstep(0.0, 0.5, depthT));
        bedBase       = mix(bedBase, bcBasalt, smoothstep(0.5, 1.0, depthT));
        c = mix(bedBase, bcRock, smoothstep(slopeRock.x, slopeRock.y, rockSlope));
    } else {
        c = mix(bcShore, bcLowland, smoothstep(0.0, bandEdgesLo.x, h));
        c = mix(c, bcGrass, smoothstep(bandEdgesLo.x, bandEdgesLo.y, h));
        highp vec3 bww = nwp + vec3(snoise3(nwp * 130.0)) * 0.004;
        float bandWarp = (snoise3(bww * 210.0) * 1.0 + snoise3(bww * 560.0) * 0.5 + snoise3(bww * 1450.0) * 0.25) * uBandWarp;
        c = mix(c, bcRock, smoothstep(bandEdgesHi.x + bandWarp, bandEdgesHi.y + bandWarp, h));
        c = mix(c, bcSnow, smoothstep(snowEdges.x + bandWarp, snowEdges.y + bandWarp, h));
        c = mix(c, bcRock, smoothstep(slopeRock.x, slopeRock.y + rockWiden, rockSlope) * step(0.0, h));
    }
    return c;
}
#ifdef _DEBUGVIEW_
vec3 biomeClassColor(float temp, float humid, float h) {
    if (h < 0.0) return vec3(0.10, 0.30, 0.75);
    if (temp < 0.30) return vec3(0.55, 0.60, 0.55);
    if (temp > 0.50 && humid > 0.66 && h >= 0.0 && h < 120.0) return vec3(0.20, 0.40, 0.30);
    bool warm = temp > 0.52;
    if (warm && humid < 0.22) return vec3(0.95, 0.80, 0.30);
    if (warm && humid < 0.42) return vec3(0.80, 0.70, 0.20);
    if (humid > 0.66) return warm ? vec3(0.00,0.55,0.10)
                                  : vec3(0.05,0.25,0.12);
    if (humid > 0.45) return vec3(0.20, 0.65, 0.25);
    return vec3(0.55, 0.70, 0.30);
}
float riverMask(vec3 worldPos, float h, float temp, float humid, float px) {
    if (h <= 0.0) return 0.0;
    highp vec3 rdir = normalize(worldPos);
    float ridge = value_ridged_fbm_rot(rdir * 280.0, 0.55, 6, 1.0, 1.5) * 0.5 + 0.5;
    float wid = clamp(px * 0.0008, 0.0, 0.04);
    float line = smoothstep(0.875 - wid, 0.935, ridge);
    float wetGate = smoothstep(0.30, 0.55, humid);
    float notFrozen = smoothstep(0.20, 0.34, temp);
    return line * wetGate * notFrozen;
}

float canyonMask(vec3 worldPos, float h, float temp, float humid, float px, out float depth) {
    depth = 0.0;
    highp vec3 cdir = normalize(worldPos);
    float ridge = value_ridged_fbm_rot(cdir * 310.0 + vec3(47.3, 81.1, 23.7), 0.55, 6, 1.0, 1.5) * 0.5 + 0.5;
    float wid = clamp(px * 0.0006, 0.0, 0.03);
    float line = smoothstep(0.875 - wid, 0.94, ridge);
    depth = smoothstep(0.875, 0.95, ridge);
    return line * step(0.0, h);
}
#endif

vec3 terrainAlbedoClimate(float h, float slope, float rockSlope, float temp, float humid, highp vec3 worldPos, float pxWorld) {
    highp vec3 nwp = normalize(worldPos);
    vec3 c = terrainAlbedo(h, slope, rockSlope, worldPos, nwp, pxWorld);
    if (h < 0.0) {
        float seaIce = 1.0 - smoothstep(0.12, 0.22, temp);
        return mix(c, vec3(0.82, 0.88, 0.94), seaIce * 0.9);
    }
    float mot = snoise3(nwp * 120.0);
    c *= (1.0 + uVariationAmt * mot);
    float beachM = (1.0 - smoothstep(uBeachTopM * 0.3, uBeachTopM, h))
                 * (1.0 - smoothstep(slopeRock.x, slopeRock.y, rockSlope));
    c = mix(c, bcShore, beachM);
    float warmth = smoothstep(0.48, 0.62, temp);
    {
        highp vec3 od = nwp;
        float ov = 0.0, oa = 0.0;
        float fq = 75.0, am = 1.0;
        int fdOcts = 2;
        for (int o = 0; o < fdOcts; o++) {
            float wl = 40000000.0 * uReliefScale / fq;
            float nyq = 1.0 - smoothstep(wl * 0.03, wl * 0.12, pxWorld);
            ov += am * nyq * snoise3(od * fq + vec3(float(o) * 7.3));
            oa += am;
            fq *= 5.0; am *= 0.6;
        }
        c *= 1.0 + 0.02 * (ov / max(oa, 1e-3));
    }
    return c;
}


const float TEX_LOD_BIAS = 0.0;
vec4 surfTriTap(sampler2DArray sm, highp vec3 wt, vec3 bw, float layer) {
    return texture(sm, vec3(wt.y, wt.z, layer), TEX_LOD_BIAS) * bw.x
         + texture(sm, vec3(wt.x, wt.z, layer), TEX_LOD_BIAS) * bw.y
         + texture(sm, vec3(wt.x, wt.y, layer), TEX_LOD_BIAS) * bw.z;
}
vec3 surfTriNrm(sampler2DArray sm, highp vec3 wt, vec3 bw, float layer, vec3 sn) {
    vec2 px = texture(sm, vec3(wt.y, wt.z, layer), TEX_LOD_BIAS).rg * 2.0 - 1.0;
    vec2 py = texture(sm, vec3(wt.x, wt.z, layer), TEX_LOD_BIAS).rg * 2.0 - 1.0;
    vec2 pz = texture(sm, vec3(wt.x, wt.y, layer), TEX_LOD_BIAS).rg * 2.0 - 1.0;
    return vec3(0.0, px.x, px.y) * (bw.x * sign(sn.x))
         + vec3(py.x, 0.0, py.y) * (bw.y * sign(sn.y))
         + vec3(pz.x, pz.y, 0.0) * (bw.z * sign(sn.z));
}

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
    highp vec3 nWorld = normalize(vWorld);
    vec3 uz = nWorld;
    vec3 refAxis = (abs(uz.y) < 0.99) ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 ux = normalize(cross(refAxis, uz));
    vec3 uy = cross(uz, ux);
#ifdef _WATERPASS_
    if (uIsWater > 0.5) {
        if (vH > 1.0 && uWaterVisProbe < 0.5) discard;
        if (uDepthOnly > 0.5) { fragColor = vec4(0.0); return; }
        if (uOccludeDepth > 0.5) {
            float sceneZ = texture(uSceneDepth, gl_FragCoord.xy / uResolution).r;
            if (gl_FragCoord.z > sceneZ + 0.00003) discard;
        }
        if (uUnderwater > 0.5) {
            highp vec3 wOriginW = floor(camWorld / 1024.0) * 1024.0;
            highp vec2 wpW = vec2(dot(vWorld - wOriginW, ux), dot(vWorld - wOriginW, uy));
            vec2 slopeW = oceanWaveSlope(wpW, oceanTime, 0, 8);
            highp float wDistW = length(camWorld - vWorld);
            vec3 wn = normalize(uz - ux * slopeW.x - uy * slopeW.y);
            vec3 viewW = normalize(camWorld - vWorld);
            float ndl = max(dot(wn, sunDir), 0.0);
            float depthAtten = exp(-max(0.0, terrainR - length(camWorld)) * 0.0005);
            vec3 sunUnder = vec3(1.0, 0.6, 0.3) * depthAtten * ndl;
            vec3 deepBlue = vec3(0.005, 0.06, 0.18);
            vec3 waveBright = vec3(0.0, 0.02, 0.06) * length(slopeW);
            vec3 wcol = deepBlue + sunUnder * 0.4 + waveBright;
            float upness = abs(dot(viewW, wn));
            float snell = smoothstep(0.50, 0.82, upness);
            vec3 skyWindow = vec3(0.40, 0.60, 0.85) * (0.5 + 0.9 * ndl);
            wcol = mix(wcol, skyWindow, snell * 0.85);
            float sunw = pow(max(dot(viewW, sunDir), 0.0), 180.0);
            wcol += vec3(1.0, 0.92, 0.70) * sunw * (0.4 + 0.6 * snell);
            vec3 mappedW = clamp((wcol * (2.51 * wcol + 0.03)) / (wcol * (2.43 * wcol + 0.59) + 0.14), 0.0, 1.0);
            fragColor = vec4(pow(mappedW, vec3(1.0 / 2.2)), 1.0);
            return;
        }
        vec3 rayDir = normalize(vWorld - camWorld);
        highp vec3 wOriginW = floor(camWorld / 1024.0) * 1024.0;
        highp float flatDist = length(vWorld - camWorld);
        highp vec2 wpFlat = vec2(dot(vWorld - wOriginW, ux), dot(vWorld - wOriginW, uy));

        highp float tHit;
        highp vec2 wpW;
        if (flatDist > 140.0) {
            tHit = flatDist;
            wpW  = wpFlat;
        } else {
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
                if (i >= bisectN) break;
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
        float nearFade = clamp(1.0 - wDistW / 120.0, 0.0, 1.0);
        float farFade  = clamp((wDistW - 30.0) / 60.0, 0.0, 1.0) * clamp(1.0 - wDistW / 300.0, 0.0, 1.0);
        int nearOStart = int(clamp(2.0 - wDistW / 40.0, 0.0, 2.0));
        int nearOEnd = int(clamp(8.0 - wDistW / 60.0, 6.0, 8.0));
        vec2 slopeNear = oceanWaveSlope(wpW, oceanTime, nearOStart, nearOEnd) * nearFade;
        vec2 slopeFar  = oceanWaveSlopeLF(wpFlat, oceanTime) * farFade;
        float depthAmp = clamp(-vH / 6.0, 0.0, 1.0);
        vec2 slopeW = slopeNear * depthAmp + slopeFar;
        vec3 wn = normalize(uz - ux * slopeW.x - uy * slopeW.y);

        vec3  viewW   = -rayDir;

        vec3 skyZenith  = vec3(0.15, 0.45, 0.95);
        vec3 skyHorizon = vec3(0.55, 0.75, 1.00);

        vec3 reflDir = reflect(-viewW, wn);
        float reflY  = dot(reflDir, uz);
        float reflSun = max(dot(reflDir, sunDir), 0.0);
        float hh = pow(1.0 - max(reflY, 0.0), 3.0);
        vec3 skyRefl = mix(skyZenith, skyHorizon, hh)
                     + vec3(1.0, 0.9, 0.7) * pow(reflSun, 8.0) * 0.8
                     + vec3(1.0, 0.85, 0.55) * pow(reflSun, 16.0) * 0.4;
        vec3 refl = skyRefl;

        float NoV  = max(dot(wn, viewW), 0.0);
        float NoL  = max(dot(wn, sunDir), 0.0);

        vec3  sigma      = vec3(0.09, 0.028, 0.012);
        vec3  deepColor  = vec3(0.04, 0.34, 0.52);
        vec3  scatterCol = deepColor;
        vec2  screenUV  = gl_FragCoord.xy / uResolution;
        float refrW   = 1.0 - smoothstep(250.0, 350.0, wDistW);
        vec2  refrUV  = clamp(screenUV + slopeW * (0.36 * refrW * NoV), vec2(0.001), vec2(0.999));
        vec3  refrCol = texture(uSceneTex, refrUV).rgb;
        float isEmpty = step(dot(refrCol, vec3(1.0)), 0.01);
        refrCol       = mix(refrCol, scatterCol, isEmpty);
        float depthW     = max(-vH, 0.0);
        float pathM      = depthW / max(NoV, 0.10);
        vec3  absorb     = exp(-sigma * pathM);
        vec3  waterBody  = refrCol * 0.40 * absorb + deepColor * (1.0 - absorb);
        float fogT       = 1.0 - dot(absorb, vec3(0.333));
        float fresnel    = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
        float reflW      = fresnel * fogT;
        vec3  reflTinted = mix(scatterCol, refl, 0.7);
        vec3  base       = mix(waterBody, reflTinted, reflW);
        float glint = pow(reflSun, 64.0) * 0.5;
        vec3  wcol  = base + vec3(glint);

        float foamNoise = seaNoise(wpW * 0.7 + vec2(oceanTime * 0.02, -oceanTime * 0.03));
        vec2  foamUV    = wpW * 4.0 + vec2(oceanTime * 1.4, oceanTime * 0.9);
        float patchMask = mix(foamNoise,
            mix(seaOctave(foamUV, oceanChoppy),
                seaOctave(foamUV * 0.5 + vec2(1.3, 2.7), oceanChoppy * 0.7), 0.4), 0.6);
        float crest     = clamp((length(slopeW) - 0.45) * 2.0, 0.0, 1.0);
        float foamAmt   = clamp(crest * (0.4 + 0.6 * patchMask) * oceanFoam, 0.0, 1.0);
        wcol = mix(wcol, vec3(0.95, 0.98, 1.0), foamAmt * (0.15 + 0.35 * NoL));

        float fogScale = max(terrainR * 1.0, 1.0);
        float fogW     = wDistW / (wDistW + fogScale);
        float viewY = max(dot(viewW, uz), 0.0);
        wcol = mix(wcol, mix(skyHorizon, skyZenith, viewY) * 0.5, fogW * uHazeMul);

        vec3 mappedW = clamp((wcol * (2.51 * wcol + 0.03)) / (wcol * (2.43 * wcol + 0.59) + 0.14), 0.0, 1.0);
        fragColor = vec4(pow(mappedW, vec3(1.0 / 2.2)), 1.0);
        return;
    }
    fragColor = vec4(0.0);
#else
    vec3 n = (uFlatNormal > 0.5) ? uz : normalize(mix(vNrm, uz, 0.05));

    if (uFsCheap > 0.5) { fragColor = vec4(n * 0.5 + 0.5, 1.0); return; }


#ifdef _DEBUGVIEW_
    if (displayMode == 5) { fragColor = (vH < 0.0) ? vec4(0.1,0.2,0.9,1.0) : vec4(0.9,0.3,0.1,1.0); return; }
    if (displayMode == 6) {
        if (vH < 0.0) {
            float dep = clamp(-vH / 6000.0, 0.0, 1.0);
            fragColor = vec4(mix(vec3(0.10,0.55,0.85), vec3(0.0,0.05,0.30), dep), 1.0); return;
        }
        float t = clamp(vH / 11000.0, 0.0, 1.0);
        vec3 ec = mix(vec3(0.0,0.80,0.85), vec3(0.10,0.85,0.20), smoothstep(0.0, 0.18, t));
        ec = mix(ec, vec3(0.95,0.95,0.10), smoothstep(0.18, 0.38, t));
        ec = mix(ec, vec3(0.95,0.50,0.05), smoothstep(0.38, 0.58, t));
        ec = mix(ec, vec3(0.80,0.10,0.10), smoothstep(0.58, 0.78, t));
        ec = mix(ec, vec3(0.55,0.10,0.40), smoothstep(0.78, 0.93, t));
        ec = mix(ec, vec3(1.0,1.0,1.0),    smoothstep(0.95, 1.0,  t));
        fragColor = vec4(ec, 1.0); return;
    }
#endif

    float slope = 1.0 - max(0.0, dot(n, uz));
    float rockSlope = clamp(slope, 0.0, 1.0);
    float pxWorld  = max(length(fwidth(vWorld)), 0.001);
    vec3 nLit = n;
    float microSlope = rockSlope;
    vec4 climate = vClimate;
    vec3 albedo = terrainAlbedoClimate(vH, slope, microSlope, climate.z, climate.w, vWorld, pxWorld);
    vec3 texDn = vec3(0.0);
    highp float camDist = length(camWorld - vWorld);
    float texFarFade = 1.0 - smoothstep(uTexFar0 * uReliefScale, uTexFar1 * uReliefScale, pxWorld);
    if (uHasSurfTex > 0.5 && uTexMix > 0.001 && texFarFade > 0.001) {
        vec3 biomeC = albedo;
        float dryHot = smoothstep(0.60, 0.85, 1.0 - climate.w) * smoothstep(0.42, 0.62, climate.z);
        highp vec3 bwDir = nWorld;
        float bandWarpN = snoise3(bwDir * 1100.0) + 0.5 * snoise3(bwDir * 2580.0);
        float bandWarp  = bandWarpN * uBandWarp * 0.25;
        float beach = (1.0 - smoothstep(max(0.0, bandWarp), uBeachTopM * uBeachWidth + max(0.0, bandWarp), vH))
                    * (1.0 - smoothstep(0.18, 0.55, slope));
        float sandRegion = clamp(max(dryHot, beach), 0.0, 1.0);
        float srLo = max(slopeRock.x, 0.05), srHi = max(slopeRock.y, srLo + 0.25);
        float wRockSlope = smoothstep(mix(srLo, 0.50, sandRegion), mix(srHi, 0.70, sandRegion), rockSlope);
        float snowHi   = smoothstep(snowEdges.x + bandWarp, snowEdges.y + bandWarp, vH);
        float rockBand = smoothstep(snowEdges.x * 0.7 + bandWarp, snowEdges.x * 0.9 + bandWarp, vH) * (1.0 - snowHi);
        float wRock = max(wRockSlope, rockBand);
        float wSnow = clamp(snowHi, 0.0, 1.0) * (1.0 - 0.6 * wRock);
        float wSand = sandRegion * (1.0 - wRock) * (1.0 - wSnow) * (1.0 - smoothstep(0.30, 0.70, slope));
        float wGrass = max(1.0 - wRock - wSnow - wSand, 0.0);
        vec4 w4 = vec4(wGrass, wRock, wSand, wSnow);
        float uwM = 1.0 - smoothstep(uBeachTopM * 0.3, uBeachTopM, vH);
        w4.z += (w4.x + w4.w) * uwM; w4.x *= 1.0 - uwM; w4.w *= 1.0 - uwM;
        w4 /= (w4.x + w4.y + w4.z + w4.w + 1e-4);
        float lA = 0.0, wA = w4.x, lB = 0.0, wB = -1.0;
        if (w4.y > wA) { lB = lA; wB = wA; lA = 1.0; wA = w4.y; } else if (w4.y > wB) { lB = 1.0; wB = w4.y; }
        if (w4.z > wA) { lB = lA; wB = wA; lA = 2.0; wA = w4.z; } else if (w4.z > wB) { lB = 2.0; wB = w4.z; }
        if (w4.w > wA) { lB = lA; wB = wA; lA = 3.0; wA = w4.w; } else if (w4.w > wB) { lB = 3.0; wB = w4.w; }
        highp vec3 wt = (vTexRel + uTexCamFrac) / uTexTileM;
        wt += vTexWarp * uTexWarp;
        vec3 tw = pow(abs(n), vec3(uTriSharp)); tw /= (tw.x + tw.y + tw.z + 1e-4);
        const vec3 LUMA = vec3(0.299, 0.587, 0.114);
        float bAB = clamp(wA / max(wA + wB, 1e-4), 0.0, 1.0);
        highp vec3 wt4 = wt * 4.0;
        float octFarFade = smoothstep(uOctFar0 * uReliefScale, uOctFar1 * uReliefScale, pxWorld);
        float texFade   = 1.0 - smoothstep(uNrmFade0, uNrmFade1, camDist);
        vec4 albA = surfTriTap(uSurfAlb, wt4, tw, lA);
        vec3 cA = albA.rgb;
        if (octFarFade != 0.0) cA = mix(albA.rgb, surfTriTap(uSurfAlb, wt, tw, lA).rgb, octFarFade);
        vec3 nA = vec3(0.0);
        if (texFade != 0.0) {
            if (uNrmLow != 0.0) nA = surfTriNrm(uSurfNrm, wt4, tw, lA, n) * 1.0
                                   + surfTriNrm(uSurfNrm, wt,  tw, lA, n) * (1.7 * uNrmLow);
            else                nA = surfTriNrm(uSurfNrm, wt4, tw, lA, n) * 1.0;
        }
        float dispA = albA.a;
        vec3 mcA = lA < 0.5 ? bcGrass : (lA < 1.5 ? bcRock : (lA < 2.5 ? bcShore : bcSnow));
        vec3 texMatColor = mcA;
        vec3 texNrm = nA;
        float crossFade = 1.0 - smoothstep(uXFade0, uXFade1, camDist);
        float ordA = lA < 0.5 ? 0.6 : (lA < 1.5 ? 0.3 : (lA < 2.5 ? 0.0 : 1.0));
        float mA = uSurfMeanL[int(lA + 0.5)];
        vec3 satA = max(mix(vec3(dot(cA, LUMA)), cA, uTexSat), 0.0);
        vec3 detailA = satA * (dot(mcA, LUMA) / max(mA, 0.02));
        vec3 detail = detailA;
        float bSharp = 1.0;
        if (wB > 0.02) {
            vec4 albB = surfTriTap(uSurfAlb, wt4, tw, lB);
            vec3 cB = albB.rgb;
            if (octFarFade != 0.0) cB = mix(albB.rgb, surfTriTap(uSurfAlb, wt, tw, lB).rgb, octFarFade);
            vec3 nB = vec3(0.0);
            if (texFade != 0.0) {
                if (uNrmLow != 0.0) nB = surfTriNrm(uSurfNrm, wt4,      tw, lB, n) * 1.0
                                       + surfTriNrm(uSurfNrm, wt, tw, lB, n) * (1.7 * uNrmLow);
                else                nB = surfTriNrm(uSurfNrm, wt4,      tw, lB, n) * 1.0;
            }
            float dispB = albB.a;
            float ordB = lB < 0.5 ? 0.6 : (lB < 1.5 ? 0.3 : (lB < 2.5 ? 0.0 : 1.0));
            vec3 mcB = lB < 0.5 ? bcGrass : (lB < 1.5 ? bcRock : (lB < 2.5 ? bcShore : bcSnow));
            float finger = (dispA - dispB) * uXFinger * crossFade;
            float s = (bAB - 0.5) * 2.0 + (ordA - ordB) * uOrdPush + finger;
            bSharp = smoothstep(-uXSoft, uXSoft, s);
            float mB = uSurfMeanL[int(lB + 0.5)];
            vec3 satB = max(mix(vec3(dot(cB, LUMA)), cB, uTexSat), 0.0);
            vec3 detailB = satB * (dot(mcB, LUMA) / max(mB, 0.02));
            detail = mix(detailB, detailA, bSharp);
            texMatColor = mix(mcB, mcA, bSharp);
            texNrm = mix(nB, nA, bSharp);
        }
        float k = uTexMix * texFarFade;
        albedo = clamp(mix(texMatColor, detail, k), 0.0, 1.0);
        float biomeTintHere = uBiomeTint * (1.0 - 0.85 * clamp(w4.z, 0.0, 1.0));
        albedo = mix(albedo, biomeC, biomeTintHere);
        albedo *= uTexBright;
        albedo = mix(biomeC, albedo, texFarFade);
        if (texFade != 0.0) texDn = normalize(texNrm) * (uTexNrmK * k) * texFade;
    }
#ifdef _DEBUGVIEW_
    if (displayMode == 7) {
        float rv = riverMask(vWorld, vH, climate.z, climate.w, pxWorld);
        fragColor = vec4(mix(vec3(0.15), vec3(0.1,0.4,0.9), rv), 1.0); return;
    }
    if (displayMode == 9) {
        highp vec3 bwN = normalize(vWorld);
        float bwT = snoise3(bwN * 230.0 + vec3(3.7, 9.1, 1.3)) * 0.65;
        float bwH = snoise3(bwN * 230.0 + vec3(21.3, 4.7, 17.9)) * 0.65;
        fragColor = vec4(biomeClassColor(clamp(climate.z + bwT * 0.13 * uBiomeWarp, 0.0, 1.0), clamp(climate.w + bwH * 0.16 * uBiomeWarp, 0.0, 1.0), vH), 1.0); return;
    }
    if (displayMode == 12) {
        float h = fract(vLevel * 0.61803398875);
        vec3 rgb = clamp(abs(fract(h + vec3(0.0, 0.6666667, 0.3333333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
        vec3 col = rgb * 0.85 + 0.1;
        vec2 g = vGrid * 24.0; vec2 gf = abs(fract(g) - 0.5); vec2 gw = fwidth(g) * 1.2;
        float line = 1.0 - min(smoothstep(0.0, gw.x, gf.x), smoothstep(0.0, gw.y, gf.y));
        col = mix(col, vec3(0.0), clamp(line, 0.0, 1.0) * 0.55);
        fragColor = vec4(col, 1.0); return;
    }
#endif
    if (displayMode == 4) { fragColor = vec4(albedo, 1.0); return; }
    if (displayMode == 2) { fragColor = vec4(albedo, 1.0); return; }

    highp vec3 pAtm   = atmPos(vWorld, terrainR);
    highp vec3 camAtm = atmPos(camWorld, terrainR);
    if (uReliefShade > 1.0) {
      nLit = normalize(uz + (nLit - uz) * uReliefShade);
    }
    nLit = normalize(nLit + texDn);
    vec3 nAtm   = nLit;
#ifdef _DEBUGVIEW_
    if (displayMode == 1) { fragColor = vec4(nAtm * 0.5 + 0.5, 1.0); return; }
#endif


    vec3 skyIrr;
    vec3 sunIrr;
    if (uUnderwater > 0.5) {
        float depth = max(0.0, terrainR - length(camWorld));
        float atten = exp(-depth * 0.0004);
        float ndl = max(dot(nAtm, sunDir), 0.0);
        sunIrr = vec3(1.0, 0.65, 0.35) * atten * ndl * 0.7;
        skyIrr = vec3(0.02, 0.07, 0.18);
    } else {
        sunIrr = atm_sunSkyIrradiance(pAtm, nAtm, sunDir, skyIrr);
    }
    sunIrr *= sampleHostShadow(vWorld);
    float skyL = dot(skyIrr, vec3(0.2126, 0.7152, 0.0722));
    vec3 skyIrrBalanced = mix(vec3(skyL), skyIrr, 0.35);
    skyIrrBalanced *= uSkyFill * vec3(0.85, 0.92, 1.10);
    float skyAO = 1.0;
    vec3 ambientFloor = albedo * (0.14 * mix(0.45, 1.0, skyAO)) + vec3(0.020, 0.026, 0.038);
    vec3 lit = albedo * (sunIrr * 1.25 + skyIrrBalanced * skyAO) * (1.0/ATM_PI) + ambientFloor;

    float nwSun = dot(nWorld, sunDir);
    vec3 color = lit;
    {
        highp vec3 camA  = atmPos(camWorld, terrainR);
        highp vec3 segKm = pAtm - camA;
        highp float dKm2 = dot(segKm, segKm);
        highp float dKm = dKm2 > 9.0 ? sqrt(dKm2) : 0.0;
        float apGate = smoothstep(3.0, 120.0, dKm);
        if (apGate > 0.002) {
            vec3 vRay = segKm / max(dKm, 1e-4);
            vec3 apTrans;
            vec3 apInscat = atm_marchRadiance(camA, vRay, sunDir, dKm, 4, apTrans);
            vec3 skyHaze = uSkyFill * vec3(0.40, 0.55, 0.78) * (1.0 - apTrans);
            apInscat = max(apInscat, skyHaze);
            vec3 hazed = lit * apTrans + apInscat;
            float gz = 1.0 - abs(nwSun);
            float graze = smoothstep(0.55, 1.0, gz); graze *= graze;
            float termDay = smoothstep(-0.02, 0.18, nwSun);
            hazed += uTerminatorGlow * graze * termDay * vec3(1.0, 0.55, 0.34) * apGate;
            color = mix(lit, hazed, apGate * uHazeMul);
        }
    }
    if (uUnderwater > 0.5 && uIsWater < 0.5) {
        highp vec3 camA  = atmPos(camWorld, terrainR);
        highp vec3 segKm = pAtm - camA;
        highp float dKm  = length(segKm);
        float depth = max(0.0, terrainR - length(camWorld));
        vec3 absorb = vec3(0.035, 0.010, 0.005) * (1.0 + depth * 0.0001);
        vec3 minTau  = vec3(0.45, 0.30, 0.20);
        vec3 uwTrans = exp(-(absorb * dKm + minTau));
        vec3 uwFog = vec3(0.004, 0.09, 0.18) + vec3(0.0, 0.015, 0.03) * depth / 1000.0;
        float upFill = mix(0.75, 1.35, clamp(dot(vNrm, nWorld) * 0.5 + 0.5, 0.0, 1.0));
        color *= upFill * 1.5;
        color = mix(color * uwTrans + uwFog * (1.0 - uwTrans), uwFog, smoothstep(100000.0, 500000.0, dKm * 1000.0));
    }
    if (uWireframe > 0.5) {
        vec2 g = vGrid * 16.0;
        vec2 gf = abs(fract(g) - 0.5);
        vec2 gw = fwidth(g) * 1.2;
        float line = 1.0 - min(smoothstep(0.0, gw.x, gf.x), smoothstep(0.0, gw.y, gf.y));
        color = mix(color, vec3(0.05, 1.0, 0.4), clamp(line, 0.0, 1.0) * 0.85);
    }
    if (uWetness > 0.001 && uIsWater < 0.5 && vH > 0.0) {
        color *= mix(1.0, 0.65, uWetness);
        vec3 wetViewDir = normalize(camWorld - vWorld);
        vec3 halfDir = normalize(sunDir + wetViewDir);
        float spec = pow(max(dot(n, halfDir), 0.0), 24.0);
        color += spec * uWetness * 0.5 * vec3(1.0, 1.0, 0.95);
    }
    float macroMu = nwSun;
    float dayShade = mix(uNightFloor, 1.0, smoothstep(-uTermWidth, uTermWidth, macroMu));
    vec3 viewDir = normalize(camWorld - vWorld);
    float viewGraze = max(dot(nWorld, viewDir), 0.0);
    float limb = 0.45 + 0.55 * smoothstep(0.0, 0.45, viewGraze);
    vec3 nightFill = vec3(0.06, 0.075, 0.11) * uNightLights;
    vec3 color2 = (color * dayShade + nightFill * (1.0 - dayShade));
    vec3 c = color2 * uExposure;
    vec3 mapped = clamp((c*(2.51*c+0.03))/(c*(2.43*c+0.59)+0.14), 0.0, 1.0);
    float lum = dot(mapped, vec3(0.2126, 0.7152, 0.0722));
    mapped = mix(vec3(lum), mapped, uLookSat);
    mapped = clamp((mapped - 0.5) * uLookContrast + 0.5, 0.0, 1.0);
    fragColor = vec4(pow(mapped, vec3(1.0/2.2)), 1.0);
#endif
}
#endif

#ifdef _PROBE_
uniform vec3 probeDir;
out vec4 probeOut;
void main(){
    vec3 dir0 = normalize(probeDir);
    int face; vec2 uv; hpfFaceUV(dir0, face, uv);
    highp vec2 faceLocal = (uv * 2.0 - 1.0) * defRadius;
    highp float h = composeHeight(dir0, faceLocal, 64.0);
    probeOut = vec4(h, 0.0, 0.0, 1.0);
}
#endif

#ifdef _HEIGHTBAKE_
uniform mat3 uBakeFrame;
uniform vec4 uBakeOffset;
uniform float uBakeRes;
out vec4 bakeOut;
void main(){
    highp vec2 uv = (gl_FragCoord.xy - 0.5) / max(uBakeRes - 1.0, 1.0);
    highp vec2 faceLocal = faceWarp(uv * uBakeOffset.z + uBakeOffset.xy);
    highp vec3 dir0 = normalize(uBakeFrame * vec3(faceLocal, defRadius));
    highp float h = composeHeight(dir0, faceLocal, uBakeOffset.z);
    bakeOut = vec4(h, 0.0, 0.0, 1.0);
}
#endif
