const float ATM_PI = 3.14159265358979;

const float ATM_BOTTOM = 6360.0;
const float ATM_TOP    = 6500.0;
const float ATM_RAYLEIGH_H = 18.0;
const float ATM_MIE_H      = 4.0;
const float ATM_MIE_G      = 0.8;

const vec3  ATM_RAYLEIGH = vec3(0.005802, 0.013558, 0.0331);
const vec3  ATM_MIE      = vec3(0.003996, 0.003996, 0.003996);
const vec3  ATM_MIE_EXT  = vec3(0.003996) * (1.0 / 0.9);
const vec3  ATM_SOLAR_IRRADIANCE = vec3(1.474, 1.8504, 1.91198);
const float ATM_SUN_ANGULAR_RADIUS = 0.004675;
const float ATM_BOTTOM2 = ATM_BOTTOM * ATM_BOTTOM;
const float ATM_TOP2    = ATM_TOP * ATM_TOP;
const float ATM_MIE_G2 = ATM_MIE_G * ATM_MIE_G;
const float ATM_MIE_2G = 2.0 * ATM_MIE_G;
const float ATM_MIE_K  = (3.0 / (8.0 * ATM_PI)) * (1.0 - ATM_MIE_G2) / (2.0 + ATM_MIE_G2);
const float ATM_RAYLEIGH_PHASE_K = 3.0 / (16.0 * ATM_PI);

vec3 atmPos(highp vec3 worldMeters, highp float R_m) {
    return worldMeters * (ATM_BOTTOM / R_m);
}

float atm_rayleighPhase(float nu) { return ATM_RAYLEIGH_PHASE_K * (1.0 + nu*nu); }
float atm_miePhase(float nu) {
    float base = max(1.0 + ATM_MIE_G2 - ATM_MIE_2G*nu, 1e-4);
    return ATM_MIE_K * (1.0+nu*nu) / (base * sqrt(base));
}

float atm_distToTop(highp float r, float mu) {
    highp float disc = r*r*(mu*mu - 1.0) + ATM_TOP2;
    if (disc < 0.0) return -1.0;
    return max(-r*mu + sqrt(disc), 0.0);
}
float atm_distToGround(highp float r, float mu) {
    highp float disc = r*r*(mu*mu - 1.0) + ATM_BOTTOM2;
    if (disc < 0.0) return -1.0;
    highp float d = -r*mu - sqrt(disc);
    return d >= 0.0 ? d : -1.0;
}
float atm_distToGround_continuous(highp float r, float mu) {
    highp float disc = max(r*r*(mu*mu - 1.0) + ATM_BOTTOM2, 0.0);
    return -r*mu - sqrt(disc);
}

const float ATM_INV_RAYLEIGH_H = 1.0 / ATM_RAYLEIGH_H;
const float ATM_INV_MIE_H      = 1.0 / ATM_MIE_H;
void atm_densities(highp float r, out float dR, out float dM) {
    highp float alt = r - ATM_BOTTOM;
    dR = exp(-alt * ATM_INV_RAYLEIGH_H);
    dM = exp(-alt * ATM_INV_MIE_H);
}

void atm_opticalDepth(highp vec3 p0, vec3 dir, float d, out float odR, out float odM) {
    const int N = 4;
    float dt = d / float(N);
    odR = 0.0; odM = 0.0;
    for (int i = 0; i < N; i++) {
        highp vec3 p = p0 + dir * (dt * (float(i) + 0.5));
        float dRd, dMd; atm_densities(length(p), dRd, dMd);
        odR += dRd * dt;
        odM += dMd * dt;
    }
}

vec3 atm_transmittanceSeg(highp vec3 p0, vec3 dir, float d) {
    float odR, odM;
    atm_opticalDepth(p0, dir, d, odR, odM);
    return exp(-(ATM_RAYLEIGH * odR + ATM_MIE_EXT * odM));
}

uniform sampler2D uTransmittanceLUT;
const float ATM_RHO_MAX = sqrt(ATM_TOP2 - ATM_BOTTOM2);
vec2 atm_lutUV(highp float r, float mu) {
    highp float rho = sqrt(max(r * r - ATM_BOTTOM2, 0.0));
    float u = clamp(rho / ATM_RHO_MAX, 0.0, 1.0);
    highp float dMin = ATM_TOP - r;
    highp float dMax = rho + ATM_RHO_MAX;
    highp float d = atm_distToTop(r, mu);
    float v = (dMax > dMin) ? clamp((d - dMin) / (dMax - dMin), 0.0, 1.0) : 0.0;
    return vec2(u, v);
}
vec3 atm_transmittanceLUTSample(highp float r, float mu) {
    return texture(uTransmittanceLUT, atm_lutUV(r, mu)).rgb;
}

vec3 atm_transmittanceToSun(highp vec3 p, vec3 sun) {
    highp float r = length(p);
    float mu = dot(p, sun) / r;
    float muHoriz = -sqrt(max(0.0, 1.0 - ATM_BOTTOM2 / (r * r)));
    float soft = smoothstep(muHoriz - 0.035, muHoriz + 0.005, mu);
    if (soft <= 0.0) return vec3(0.0);
    return atm_transmittanceLUTSample(r, mu) * soft;
}

uniform sampler2DArray uScatteringLUT;
uniform float uUseScatteringLUT;
const float ATM_SCAT_LAYERS = 24.0;
const float ATM_SCAT_K = 1.4;
float atm_scatMuSToLayerF(float muS) {
    float th = tanh(ATM_SCAT_K);
    float t = atanh(clamp(muS * th, -0.999999, 0.999999)) / ATM_SCAT_K;
    float w = clamp((t + 1.0) * 0.5, 0.0, 1.0);
    return clamp(w * ATM_SCAT_LAYERS - 0.5, 0.0, ATM_SCAT_LAYERS - 1.0);
}
vec4 atm_scatteringLUTSample(highp float r, float mu, float muS) {
    vec2 uv = atm_lutUV(r, mu);
    float lf = atm_scatMuSToLayerF(muS);
    float l0 = floor(lf);
    float l1 = min(l0 + 1.0, ATM_SCAT_LAYERS - 1.0);
    float lt = lf - l0;
    vec4 s0 = texture(uScatteringLUT, vec3(uv, l0));
    vec4 s1 = texture(uScatteringLUT, vec3(uv, l1));
    return mix(s0, s1, lt);
}

vec3 atm_marchRadiance(highp vec3 camera, vec3 viewRay, vec3 sun, float dEnd, int steps, out vec3 transmittance) {
    highp float r = length(camera);
    float mu = dot(camera, viewRay) / r;
    float muS = dot(camera, sun) / r;
    float nu = dot(viewRay, sun);
    highp float dTop = atm_distToTop(r, mu);

    if (uUseScatteringLUT > 0.5 && dTop > 0.0) {
        vec4 fullScat = atm_scatteringLUTSample(r, mu, muS);
        vec3 inscatR = fullScat.rgb;
        float inscatM = fullScat.a;
        vec3 tFull = atm_transmittanceLUTSample(r, mu);
        if (dEnd < dTop - 1e-4) {
            highp vec3 pEnd = camera + viewRay * dEnd;
            highp float rEnd = length(pEnd);
            float muEnd = dot(pEnd, viewRay) / rEnd;
            float muSEnd = dot(pEnd, sun) / rEnd;
            vec4 tailScat = atm_scatteringLUTSample(rEnd, muEnd, muSEnd);
            vec3 tToEnd = atm_transmittanceLUTSample(r, mu) / max(atm_transmittanceLUTSample(rEnd, muEnd), vec3(1e-6));
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

    float dt = dEnd / float(steps);
    vec3 inscatR = vec3(0.0);
    vec3 inscatM = vec3(0.0);
    float odR = 0.0, odM = 0.0;

    vec3 tView = vec3(1.0);
    for (int i = 0; i < steps; i++) {
        highp vec3 p = camera + viewRay * (dt * (float(i) + 0.5));
        float dRd, dMd; atm_densities(length(p), dRd, dMd);
        float dR = dRd * dt;
        float dM = dMd * dt;
        odR += dR; odM += dM;
        tView = exp(-(ATM_RAYLEIGH * odR + ATM_MIE_EXT * odM));
        vec3 tSun = atm_transmittanceToSun(p, sun);
        vec3 t = tView * tSun;
        inscatR += t * dR;
        inscatM += t * dM;
    }
    transmittance = tView;
    return ATM_SOLAR_IRRADIANCE * (
        inscatR * ATM_RAYLEIGH * atm_rayleighPhase(nu) +
        inscatM * ATM_MIE      * atm_miePhase(nu));
}

const float ATM_HORIZON_BLEND_MU = 0.006;
vec3 atm_skyRadiance(highp vec3 cameraIn, vec3 viewRay, vec3 sun, out vec3 transmittance) {
    highp vec3 camera = cameraIn;
    highp float r = length(camera);
    float mu = dot(camera, viewRay) / r;

    if (r > ATM_TOP) {
        float dt = atm_distToTop(r, mu);
        if (dt < 0.0) { transmittance = vec3(1.0); return vec3(0.0); }
        camera = camera + viewRay * dt;
        r = length(camera);
        mu = dot(camera, viewRay) / r;
    }

    float dTop = atm_distToTop(r, mu);
    if (dTop <= 0.0) { transmittance = vec3(1.0); return vec3(0.0); }

    float muTangent = -sqrt(max(0.0, 1.0 - ATM_BOTTOM2 / (r * r)));
    float wSky = smoothstep(muTangent - ATM_HORIZON_BLEND_MU, muTangent + ATM_HORIZON_BLEND_MU, mu);

    vec3 transSky;
    vec3 radSky = atm_marchRadiance(camera, viewRay, sun, dTop, 8, transSky);
    if (wSky >= 1.0) { transmittance = transSky; return radSky; }

    float dGround = max(atm_distToGround_continuous(r, mu), 1e-3);
    vec3 transGround;
    vec3 radGround = atm_marchRadiance(camera, viewRay, sun, dGround, 8, transGround);
    if (wSky <= 0.0) { transmittance = vec3(0.0); return radGround; }

    transmittance = mix(vec3(0.0), transSky, wSky);
    return mix(radGround, radSky, wSky);
}

vec3 atm_sunSkyIrradiance(highp vec3 point, vec3 normal, vec3 sun, out vec3 sky_irradiance) {
    highp float r = length(point);
    vec3 up = point / r;
    float muS = dot(up, sun);
    vec3 tSun = atm_transmittanceToSun(up * (ATM_BOTTOM + 0.5), sun);
    vec3 direct = ATM_SOLAR_IRRADIANCE * tSun * clamp(dot(normal, sun), 0.0, 1.0);
    float day = smoothstep(-0.10, 0.25, muS);
    vec3 rayTint = ATM_RAYLEIGH / (ATM_RAYLEIGH.x);
    vec3 skyTint = mix(vec3(1.0), rayTint, 0.4);
    sky_irradiance = ATM_SOLAR_IRRADIANCE * 0.075 * day * skyTint
                     * (0.5 * (1.0 + dot(normal, up)));
    return direct;
}
