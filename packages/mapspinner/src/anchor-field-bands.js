// Pure noise primitives (hash3/vnoise/fractal/vnoise3/fractal3) + the tuned BANDS array (continental/subcontinental/regional/subregional/local scale-band definitions) for anchor-field.js's createAnchorField(). No reference to any per-instance closure state -- these are deterministic functions of their inputs, extracted as the stateless core the field factory composes.

// ---- cube-face frame (mirrors planet-orchestrator FACE_FRAME / render localToWorld3).
// A face-local point (u,v in [-1,1], outward axis) maps to a world direction. We only need
// the inverse (world dir -> face + uv) for sampleDir, and the forward (face,uv -> dir) for
// the per-node procedural hash seed coordinate.
const FACE_FRAME = [
  { c: [ 1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, // +X
  { c: [-1, 0, 0], u: [0, 0,  1], v: [0, 1, 0] }, // -X
  { c: [0,  1, 0], u: [1, 0, 0],  v: [0, 0, -1] }, // +Y
  { c: [0, -1, 0], u: [1, 0, 0],  v: [0, 0,  1] }, // -Y
  { c: [0, 0,  1], u: [1, 0, 0],  v: [0, 1, 0] },  // +Z
  { c: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },  // -Z
];

// ---- deterministic integer hash (no state). Two rounds of integer mixing (a la PCG/xxhash
// finalizer) -> a uniform float in [0,1). Used to seed each node's procedural base so the
// field is reproducible across reloads and machines.
function hash3(a, b, c) {
  let h = (a | 0) * 374761393 + (b | 0) * 668265263 + (c | 0) * 2246822519;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}
// value-noise sample at a 2D coord via hashed lattice + smooth (quintic) bilinear. Cheap,
// allocation-free; the per-band fractal sums a few octaves of this.
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf*xf*xf*(xf*(xf*6 - 15) + 10);   // quintic smoothstep
  const v = yf*yf*yf*(yf*(yf*6 - 15) + 10);
  const h00 = hash3(xi,     yi,     seed);
  const h10 = hash3(xi + 1, yi,     seed);
  const h01 = hash3(xi,     yi + 1, seed);
  const h11 = hash3(xi + 1, yi + 1, seed);
  const a = h00 + u * (h10 - h00);
  const b = h01 + u * (h11 - h01);
  return (a + v * (b - a)) * 2.0 - 1.0;        // [-1,1]
}
// fractal sum (fBm) of `oct` octaves; ridged=true folds to ridges (continental/mountain).
function fractal(x, y, seed, oct, lacunarity, gain, ridged) {
  let amp = 1.0, freq = 1.0, sum = 0.0, norm = 0.0;
  for (let o = 0; o < oct; o++) {
    let n = vnoise(x * freq, y * freq, seed + o * 1013);
    if (ridged) { n = 1.0 - Math.abs(n); n = n * n; }
    sum += n * amp; norm += amp;
    amp *= gain; freq *= lacunarity;
  }
  let r = sum / Math.max(norm, 1e-6);
  if (ridged) r = r * 2.0 - 1.0;               // recentre ridged to ~[-1,1]
  return r;
}

// 3D value-noise + fBm of the WORLD DIRECTION (seam-fix 2026-06-05). The 2D vnoise/fractal above
// were sampled in FACE-LOCAL coords (baseParams fx=(u+face*4)*..., fy=(v+face*7)*...), so adjacent
// cube faces sampled DISJOINT regions of the 2D field -> a hard continental-elevation step along
// every shared cube-face edge (up to ~3.8km, the 'shelf' the user saw). Seeding the band fractals
// by the 3D world direction instead makes the field a pure function of world dir -> seamless across
// faces + poles BY CONSTRUCTION (validated src/lab/_seamfix_proto.mjs: seam 3765m->13m, landFrac held).
function vnoise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf*xf*xf*(xf*(xf*6-15)+10), v = yf*yf*yf*(yf*(yf*6-15)+10), w = zf*zf*zf*(zf*(zf*6-15)+10);
  const H = (a,b,c) => hash3(a, b, (c*2654435761 ^ seed)|0);
  const c000=H(xi,yi,zi),   c100=H(xi+1,yi,zi),   c010=H(xi,yi+1,zi),   c110=H(xi+1,yi+1,zi);
  const c001=H(xi,yi,zi+1), c101=H(xi+1,yi,zi+1), c011=H(xi,yi+1,zi+1), c111=H(xi+1,yi+1,zi+1);
  const x00=c000+u*(c100-c000), x10=c010+u*(c110-c010), x01=c001+u*(c101-c001), x11=c011+u*(c111-c011);
  const y0=x00+v*(x10-x00), y1=x01+v*(x11-x01);
  return (y0 + w*(y1-y0)) * 2.0 - 1.0;          // [-1,1]
}
// 3D fBm (mirrors fractal()). The band fractal closures call this with the world dir * scale.
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

// ---- band definitions: each scale band is an independent fixed quadtree over the 6 faces
// at a chosen LEVEL (resolution), driven by its OWN fractal, contributing its OWN parameter
// set. levelsPerFace = 2^level cells per face edge -> 6 * 4^level anchors in the band.
// The procedural base of each parameter is a fractal of the node's world position; edits
// are sparse deltas layered on top. Tuned so coarse bands make broad continents and finer
// bands add regional then local structure (different fractals at different scales).
const BANDS = [
  {
    name: 'continental', level: 3,   // 6 * 64 = 384 anchors; ~plate scale
    // band0 drives the broad land/sea split + plate-scale uplift. Ridged low-octave domain-
    // warped noise -> big coherent landmasses with oceanic basins between (tectonic feel).
    fractal: (x, y, s) => {
      // domain warp for non-blobby continent shapes
      const wx = x + 0.6 * fractal(x, y, s + 7, 2, 2.0, 0.5, false);
      const wy = y + 0.6 * fractal(x, y, s + 9, 2, 2.0, 0.5, false);
      return fractal(wx, wy, s, 4, 2.0, 0.55, true);   // ridged plate mask
    },
    // 3D world-dir version (seam fix): domain-warped ridged plate mask, seamless across cube faces.
    fractal3: (x, y, z, s) => {
      const wx = x + 0.6 * fractal3(x, y, z, s + 7, 2, 2.0, 0.5, false);
      const wy = y + 0.6 * fractal3(x, y, z, s + 9, 2, 2.0, 0.5, false);
      const wz = z + 0.6 * fractal3(x, y, z, s + 13, 2, 2.0, 0.5, false);
      return fractal3(wx, wy, wz, s, 4, 2.0, 0.55, true);   // ridged plate mask
    },
    // maps the fractal value -> parameter contributions (meters / scales). The -0.13 sea-level bias
    // offsets the ridged mask's positive skew so landFrac stays ~0.43 (tuned, _seamfix_proto.mjs).
    params: (f) => ({
      seaBias:   (f - 0.13) * 2600.0,   // +/- ~2.6km broad swell: land above 0, ocean below
      elevAmp:   1.0 + 0.25 * f,        // gentle continental-shelf amplitude modulation
      temp:      0.0, humidity: 0.0, erosion: 0.0, roughness: 0.0,
    }),
  },
  {
    // SUB-CONTINENTAL infill band (anchor-density ladder [3,5,6,7,9], gate nodejs-2215). Closes the
    // octave gap between continental L3 and regional L6 so ~200-400km features resolve. DISCIPLINE
    // (proven safe-wiring gate): NEUTRAL elevAmp (1.0, multiplies as identity -> no elevAmp compounding)
    // + ZERO-MEAN seaBias ((f), f in [-1,1] -> does not shift land/sea; A/B landFrac delta 0.03 < 0.05).
    name: 'subcontinental', level: 5,   // 6 * 1024 = 6144 anchors
    fractal: (x, y, s) => {
      const wx = x + 0.6 * fractal(x, y, s + 7, 2, 2.0, 0.5, false);
      const wy = y + 0.6 * fractal(x, y, s + 9, 2, 2.0, 0.5, false);
      return fractal(wx, wy, s + 65, 4, 2.0, 0.55, true);   // decorrelated ridged sub-plate mask
    },
    fractal3: (x, y, z, s) => {
      const wx = x + 0.6 * fractal3(x, y, z, s + 7, 2, 2.0, 0.5, false);
      const wy = y + 0.6 * fractal3(x, y, z, s + 9, 2, 2.0, 0.5, false);
      const wz = z + 0.6 * fractal3(x, y, z, s + 13, 2, 2.0, 0.5, false);
      return fractal3(wx, wy, wz, s + 65, 4, 2.0, 0.55, true);   // decorrelated ridged sub-plate mask
    },
    params: (f) => ({
      seaBias:  f * 900.0,     // ZERO-MEAN sub-continental sea-level wiggle (coastline at sub-plate scale)
      elevAmp:  1.0,           // NEUTRAL (gate: keeps composite elevAmp identical to 3-band)
      temp: 0.0, humidity: 0.0, erosion: 0.0, roughness: 0.0,
    }),
  },
  {
    name: 'regional', level: 6,     // 6 * 4096 = 24576 anchors; ~mountain-range/climate scale
    // band1 drives mountain belts, erosion strength, and climate (temp/humidity). Mid-octave
    // fBm (not ridged) -> rolling regional variation with belts of higher relief.
    fractal: (x, y, s) => fractal(x, y, s, 5, 2.0, 0.5, false),
    fractal3: (x, y, z, s) => fractal3(x, y, z, s, 5, 2.0, 0.5, false),
    params: (f, lat = 0, fx = 0, fy = 0) => {
      const belt = fractal(f * 3.0, f * 3.0, 31, 3, 2.0, 0.5, true); // mountain-belt mask
      // BIOME-VARIETY CLIMATE (user: continent featureless/self-similar). The old climate was a
      // single smooth gradient (temp=latitude, humidity=0.5-0.5f) so the whole continent fell in
      // ~2 wet-lowland classes that all render the same green. We give temp AND humidity WIDE
      // REGIONAL range from INDEPENDENT multi-octave fractals of the node position + continentality,
      // so distinct biome PATCHES form (deserts, forests, swamps, tundra, taiga) rather than one
      // gradient. fx,fy = the node's fractal coordinate (threaded from baseParams).
      const latBase = Math.pow(Math.max(0, Math.cos(lat)), 1.1);   // [0,1] equator->pole (still anchors poles cold)
      // independent regional climate octaves (decorrelated seeds). Coordinate scale 2.2 (was 0.5)
      // so several biome PATCHES form WITHIN a single continent (at 0.5 a whole continent fell in
      // one climate cycle -> one biome region = still self-similar). Higher freq -> biome mosaic.
      const tNoise = fractal(fx * 2.2 + 11.0, fy * 2.2 - 7.0, 9211, 4, 2.0, 0.55, false);
      const hNoise = fractal(fx * 2.2 - 5.0,  fy * 2.2 + 13.0, 9307, 4, 2.0, 0.55, false);
      // CONTINENTALITY: interiors/high ground (large seaBias proxy via f) are drier + a touch
      // cooler; near-sea is wetter. f in ~[-1,1] (regional fBm), positive = higher/inland.
      const inland = Math.max(0, Math.min(1, f * 0.5 + 0.5));      // 0 coastal -> 1 interior
      // TEMP: latitude is the spine; regional octave gives +/-0.30 so warm/cool belts cross it;
      // interiors run a bit cooler. Wide range so cold (tundra/ice) AND hot (desert) both occur.
      // latBase^1.4 makes the poles genuinely cold (-> ice/tundra) while the equator stays warm;
      // small offset, wide regional swing so both hot deserts and cold caps occur.
      const temp = Math.max(0, Math.min(1, Math.pow(latBase, 1.4) * 1.05 + 0.28 * tNoise - 0.10 * inland - 0.04));
      // LOGICAL BIOME PLACEMENT (user: biomes in their most logical positions). Two physical
      // climate drivers added so biomes land where Earth puts them, not at random noise spots:
      //  (1) EQUATORIAL-WET / SUBTROPICAL-DRY latitude band (the Hadley-cell / ITCZ profile):
      //      wet at the equator (rainforest), DRY desert belts near +/-25deg (Sahara/Arabian/
      //      Australian latitudes), moderate again in the temperate mid-lats. latDeg from lat.
      //  (2) RAIN-SHADOW: the dry lee of mountain belts -- the `belt` mask reduces humidity so
      //      arid steppe/desert forms downwind of ranges (continentality already covers interiors;
      //      this sharpens the orographic dryness on the high belts themselves).
      const latDeg = Math.abs(lat) * 57.29577951;
      // Hadley/ITCZ humidity profile: equatorial WET bulge, a NARROW subtropical DRY trough at
      // ~25deg (the desert latitudes), and a temperate-humid RECOVERY bump at ~50deg so deserts
      // do NOT bleed into the mid-latitudes. Trough sigma 8 (narrow) so it decays before 40deg.
      const latHumid = 0.20 * Math.exp(-(latDeg * latDeg) / (2 * 11 * 11))            // equatorial wet bulge
                     - 0.24 * Math.exp(-((latDeg - 25) * (latDeg - 25)) / (2 * 8 * 8)) // subtropical dry trough (narrow)
                     + 0.12 * Math.exp(-((latDeg - 52) * (latDeg - 52)) / (2 * 14 * 14)); // temperate-humid recovery
      const rainShadow = 0.22 * Math.max(0, belt);   // orographic drying on the high belts
      const humidity = Math.max(0, Math.min(1, 0.62 + 0.52 * hNoise - 0.40 * inland + latHumid - rainShadow));
      return {
        // GENERAL ELEVATION (user: anchorpoints should convey general elevation so terrain is
        // not so flat/featureless). The regional band is the ~100-200km scale the user flies
        // over; at f*350 the within-continent height variation was too small (continental
        // f*2600 dominates, then a big flat gap to fine detail), so interiors read as flat
        // plains. Raise the regional elevation amplitude to f*900 to carve rolling
        // hills/plateaus/valleys at that scale. ZERO-MEAN (f in [-1,1]) so the land/sea split
        // is preserved (safe-wiring gate: landFrac delta < 0.05); validated by CLI hypsometry.
        seaBias:  f * 1600.0,                // regional general-elevation relief. 900->1600 (user 2026-06-02
                                             // 'elevation distribution doesnt create enough elevation'): more
                                             // large-scale highlands/lowlands/basins. ZERO-MEAN (land/sea preserved).
        elevAmp:  1.0 + 0.8 * Math.max(0, belt),  // amplify relief inside mountain belts
        temp,
        humidity,
        erosion:  0.3 + 0.4 * Math.max(0, belt),  // more erosion on the high belts
        roughness: 0.0,
      };
    },
  },
  {
    // SUB-REGIONAL infill band (ladder [3,5,6,7,9]). Closes the gap between regional L6 and local L9
    // so ~25-50km features resolve. Same discipline: NEUTRAL elevAmp + ZERO-MEAN seaBias.
    name: 'subregional', level: 7,   // 6 * 16384 = 98304 anchors
    fractal: (x, y, s) => {
      const wx = x + 0.6 * fractal(x, y, s + 7, 2, 2.0, 0.5, false);
      const wy = y + 0.6 * fractal(x, y, s + 9, 2, 2.0, 0.5, false);
      return fractal(wx, wy, s + 91, 4, 2.0, 0.55, true);   // decorrelated ridged sub-regional mask
    },
    fractal3: (x, y, z, s) => {
      const wx = x + 0.6 * fractal3(x, y, z, s + 7, 2, 2.0, 0.5, false);
      const wy = y + 0.6 * fractal3(x, y, z, s + 9, 2, 2.0, 0.5, false);
      const wz = z + 0.6 * fractal3(x, y, z, s + 13, 2, 2.0, 0.5, false);
      return fractal3(wx, wy, wz, s + 91, 4, 2.0, 0.55, true);   // decorrelated ridged sub-regional mask
    },
    params: (f) => ({
      seaBias:  f * 750.0,     // ZERO-MEAN sub-regional relief (~25-50km hills). 450->750 (more elevation distribution)
      elevAmp:  1.0,           // NEUTRAL
      temp: 0.0, humidity: 0.0, erosion: 0.0, roughness: 0.0,
    }),
  },
  {
    name: 'local', level: 9,        // 6 * 262144 = ~1.5M anchors; ~local-feature scale
    // band2 drives local roughness + material detail weights. High-octave turbulence -> the
    // fine break-up that the detail-texture material reads (the texel-density coupling).
    fractal: (x, y, s) => Math.abs(fractal(x, y, s, 4, 2.2, 0.55, false)),
    fractal3: (x, y, z, s) => Math.abs(fractal3(x, y, z, s, 4, 2.2, 0.55, false)),
    params: (f) => ({
      seaBias: 0.0, elevAmp: 1.0 + 0.15 * f, temp: 0.0, humidity: 0.0,
      erosion: 0.0,
      roughness: 0.4 + 0.6 * f,              // [0.4,1] local surface roughness / detail gain
    }),
  },
];

export { FACE_FRAME, hash3, vnoise, fractal, vnoise3, fractal3, BANDS };
