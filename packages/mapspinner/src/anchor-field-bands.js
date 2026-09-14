const FACE_FRAME = [
  { c: [ 1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { c: [-1, 0, 0], u: [0, 0,  1], v: [0, 1, 0] },
  { c: [0,  1, 0], u: [1, 0, 0],  v: [0, 0, -1] },
  { c: [0, -1, 0], u: [1, 0, 0],  v: [0, 0,  1] },
  { c: [0, 0,  1], u: [1, 0, 0],  v: [0, 1, 0] },
  { c: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

function hash3(a, b, c) {
  let h = (a | 0) * 374761393 + (b | 0) * 668265263 + (c | 0) * 2246822519;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf*xf*xf*(xf*(xf*6 - 15) + 10);
  const v = yf*yf*yf*(yf*(yf*6 - 15) + 10);
  const h00 = hash3(xi,     yi,     seed);
  const h10 = hash3(xi + 1, yi,     seed);
  const h01 = hash3(xi,     yi + 1, seed);
  const h11 = hash3(xi + 1, yi + 1, seed);
  const a = h00 + u * (h10 - h00);
  const b = h01 + u * (h11 - h01);
  return (a + v * (b - a)) * 2.0 - 1.0;
}
function fractal(x, y, seed, oct, lacunarity, gain, ridged) {
  let amp = 1.0, freq = 1.0, sum = 0.0, norm = 0.0;
  for (let o = 0; o < oct; o++) {
    let n = vnoise(x * freq, y * freq, seed + o * 1013);
    if (ridged) { n = 1.0 - Math.abs(n); n = n * n; }
    sum += n * amp; norm += amp;
    amp *= gain; freq *= lacunarity;
  }
  let r = sum / Math.max(norm, 1e-6);
  if (ridged) r = r * 2.0 - 1.0;
  return r;
}

function vnoise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf*xf*xf*(xf*(xf*6-15)+10), v = yf*yf*yf*(yf*(yf*6-15)+10), w = zf*zf*zf*(zf*(zf*6-15)+10);
  const H = (a,b,c) => hash3(a, b, (c*2654435761 ^ seed)|0);
  const c000=H(xi,yi,zi),   c100=H(xi+1,yi,zi),   c010=H(xi,yi+1,zi),   c110=H(xi+1,yi+1,zi);
  const c001=H(xi,yi,zi+1), c101=H(xi+1,yi,zi+1), c011=H(xi,yi+1,zi+1), c111=H(xi+1,yi+1,zi+1);
  const x00=c000+u*(c100-c000), x10=c010+u*(c110-c010), x01=c001+u*(c101-c001), x11=c011+u*(c111-c011);
  const y0=x00+v*(x10-x00), y1=x01+v*(x11-x01);
  return (y0 + w*(y1-y0)) * 2.0 - 1.0;
}
function fractal3(x, y, z, seed, oct, lacunarity, gain, ridged) {
  let amp = 1.0, freq = 1.0, sum = 0.0, norm = 0.0;
  for (let o = 0; o < oct; o++) {
    let n = vnoise3(x * freq, y * freq, z * freq, seed + o * 1013);
    if (ridged) { n = 1.0 - Math.abs(n); n = n * n; }
    sum += n * amp; norm += amp; amp *= gain; freq *= lacunarity;
  }
  let r = sum / Math.max(norm, 1e-6);
  if (ridged) r = r * 2.0 - 1.0;
  return r;
}

const RAD_TO_DEG = 57.29577951;
const RIDGED_MASK_SKEW_OFFSET = 0.13;

const BANDS = [
  {
    name: 'continental', level: 3,
    fractal: (x, y, s) => {
      const wx = x + 0.6 * fractal(x, y, s + 7, 2, 2.0, 0.5, false);
      const wy = y + 0.6 * fractal(x, y, s + 9, 2, 2.0, 0.5, false);
      return fractal(wx, wy, s, 4, 2.0, 0.55, true);
    },
    fractal3: (x, y, z, s) => {
      const wx = x + 0.6 * fractal3(x, y, z, s + 7, 2, 2.0, 0.5, false);
      const wy = y + 0.6 * fractal3(x, y, z, s + 9, 2, 2.0, 0.5, false);
      const wz = z + 0.6 * fractal3(x, y, z, s + 13, 2, 2.0, 0.5, false);
      return fractal3(wx, wy, wz, s, 4, 2.0, 0.55, true);
    },
    params: (f) => ({
      seaBias:   (f - RIDGED_MASK_SKEW_OFFSET) * 2600.0,
      elevAmp:   1.0 + 0.25 * f,
      temp:      0.0, humidity: 0.0, erosion: 0.0, roughness: 0.0,
    }),
  },
  {
    name: 'subcontinental', level: 5,
    fractal: (x, y, s) => {
      const wx = x + 0.6 * fractal(x, y, s + 7, 2, 2.0, 0.5, false);
      const wy = y + 0.6 * fractal(x, y, s + 9, 2, 2.0, 0.5, false);
      return fractal(wx, wy, s + 65, 4, 2.0, 0.55, true);
    },
    fractal3: (x, y, z, s) => {
      const wx = x + 0.6 * fractal3(x, y, z, s + 7, 2, 2.0, 0.5, false);
      const wy = y + 0.6 * fractal3(x, y, z, s + 9, 2, 2.0, 0.5, false);
      const wz = z + 0.6 * fractal3(x, y, z, s + 13, 2, 2.0, 0.5, false);
      return fractal3(wx, wy, wz, s + 65, 4, 2.0, 0.55, true);
    },
    params: (f) => ({
      seaBias:  f * 900.0,
      elevAmp:  1.0,
      temp: 0.0, humidity: 0.0, erosion: 0.0, roughness: 0.0,
    }),
  },
  {
    name: 'regional', level: 6,
    fractal: (x, y, s) => fractal(x, y, s, 5, 2.0, 0.5, false),
    fractal3: (x, y, z, s) => fractal3(x, y, z, s, 5, 2.0, 0.5, false),
    params: (f, lat = 0, fx = 0, fy = 0) => {
      const belt = fractal(f * 3.0, f * 3.0, 31, 3, 2.0, 0.5, true);
      const latBase = Math.pow(Math.max(0, Math.cos(lat)), 1.1);
      const tNoise = fractal(fx * 2.2 + 11.0, fy * 2.2 - 7.0, 9211, 4, 2.0, 0.55, false);
      const hNoise = fractal(fx * 2.2 - 5.0,  fy * 2.2 + 13.0, 9307, 4, 2.0, 0.55, false);
      const inland = Math.max(0, Math.min(1, f * 0.5 + 0.5));
      const temp = Math.max(0, Math.min(1, Math.pow(latBase, 1.4) * 1.05 + 0.28 * tNoise - 0.10 * inland - 0.04));
      const latDeg = Math.abs(lat) * RAD_TO_DEG;
      const equatorialWetBulge = 0.20 * Math.exp(-(latDeg * latDeg) / (2 * 11 * 11));
      const subtropicalDryTrough = 0.24 * Math.exp(-((latDeg - 25) * (latDeg - 25)) / (2 * 8 * 8));
      const temperateHumidRecovery = 0.12 * Math.exp(-((latDeg - 52) * (latDeg - 52)) / (2 * 14 * 14));
      const latHumid = equatorialWetBulge - subtropicalDryTrough + temperateHumidRecovery;
      const rainShadow = 0.22 * Math.max(0, belt);
      const humidity = Math.max(0, Math.min(1, 0.62 + 0.52 * hNoise - 0.40 * inland + latHumid - rainShadow));
      return {
        seaBias:  f * 1600.0,
        elevAmp:  1.0 + 0.8 * Math.max(0, belt),
        temp,
        humidity,
        erosion:  0.3 + 0.4 * Math.max(0, belt),
        roughness: 0.0,
      };
    },
  },
  {
    name: 'subregional', level: 7,
    fractal: (x, y, s) => {
      const wx = x + 0.6 * fractal(x, y, s + 7, 2, 2.0, 0.5, false);
      const wy = y + 0.6 * fractal(x, y, s + 9, 2, 2.0, 0.5, false);
      return fractal(wx, wy, s + 91, 4, 2.0, 0.55, true);
    },
    fractal3: (x, y, z, s) => {
      const wx = x + 0.6 * fractal3(x, y, z, s + 7, 2, 2.0, 0.5, false);
      const wy = y + 0.6 * fractal3(x, y, z, s + 9, 2, 2.0, 0.5, false);
      const wz = z + 0.6 * fractal3(x, y, z, s + 13, 2, 2.0, 0.5, false);
      return fractal3(wx, wy, wz, s + 91, 4, 2.0, 0.55, true);
    },
    params: (f) => ({
      seaBias:  f * 750.0,
      elevAmp:  1.0,
      temp: 0.0, humidity: 0.0, erosion: 0.0, roughness: 0.0,
    }),
  },
  {
    name: 'local', level: 9,
    fractal: (x, y, s) => Math.abs(fractal(x, y, s, 4, 2.2, 0.55, false)),
    fractal3: (x, y, z, s) => Math.abs(fractal3(x, y, z, s, 4, 2.2, 0.55, false)),
    params: (f) => ({
      seaBias: 0.0, elevAmp: 1.0 + 0.15 * f, temp: 0.0, humidity: 0.0,
      erosion: 0.0,
      roughness: 0.4 + 0.6 * f,
    }),
  },
];

export { FACE_FRAME, hash3, vnoise, fractal, vnoise3, fractal3, BANDS };
