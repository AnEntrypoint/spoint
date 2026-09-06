// surface-texture-decode.js -- worker-safe image decode for loadSurfaceTextures (gl-render.js).
//
// The original decode path used `document.createElement('canvas')` + `new Image()` +
// `ctx.getImageData()`. None of `document`/`Image` exist inside a Worker (no DOM), which is exactly
// the environment a future OffscreenCanvas-hosted render loop (offscreencanvas-worker-migration-full-
// game-loop) needs to decode surface textures in. This module ports the decode to
// `createImageBitmap(blob)` + an `OffscreenCanvas` 2D context -- both spec'd to work identically on
// the main thread AND inside a dedicated Worker, so gl-render.js can call the SAME function from
// either context instead of forking window-vs-worker decode paths.
//
// PIXEL-SHAPE CONTRACT (load-bearing, verified byte-for-byte against the old document/Image path --
// see the decode-and-compare-checksum harness this module ships alongside): `decodeImageToPixels`
// returns a `Uint8ClampedArray` of length `w*h*4` (RGBA8, straight/un-premultiplied alpha, top-left
// origin, row-major) -- the EXACT shape `CanvasRenderingContext2D.getImageData(...).data` already
// produced. Callers that previously read `.data` off a `getImageData()` result can read this
// return value directly with zero shape change.
//
// crossOrigin: `fetch()` defaults to a CORS-mode request for a cross-origin URL (e.g. a consumer
// loading the SDK from unpkg) -- matching the old `img.crossOrigin = 'anonymous'` intent. A
// same-origin or CORS-clean response decodes cleanly via createImageBitmap; a tainted/opaque
// response (`response.type === 'opaque'`, e.g. no-cors mode) is never requested here, so
// createImageBitmap never throws the canvas-taint SecurityError the old drawImage+getImageData path
// could.

// True in a dedicated Worker (no window, but self===globalThis and importScripts/postMessage exist)
// AND on the main thread (window===globalThis too) -- NOT true in a plain Node process with neither.
export function canDecodeImages() {
  return typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined';
}

// Fetch + decode a single image URL to raw RGBA8 pixels via the worker-safe path.
// Returns { data: Uint8ClampedArray(w*h*4), width, height }.
export async function decodeImageToPixels(url, targetW, targetH) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('fetch ' + url + ' -> HTTP ' + res.status);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const w = targetW || bitmap.width, h = targetH || bitmap.height;
  const oc = new OffscreenCanvas(w, h);
  const cx = oc.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bitmap, 0, 0, w, h);
  const imgData = cx.getImageData(0, 0, w, h);
  bitmap.close?.();   // release the decoded-bitmap backing store promptly (worker has no GC nudge from a detached DOM Image)
  return { data: imgData.data, width: w, height: h };
}

// ---- 8-bit <-> linear helpers for the de-shade pass ----------------------------------------------------
// 8-bit -> linear LUT (perf sweep 2026-06-11): gamma-2.2 on an 8-bit input has exactly 256 values; the
// LUT is bit-identical for every 8-bit input.
export const LIN8 = new Float32Array(256);
for (let v = 0; v < 256; v++) LIN8[v] = Math.pow(v / 255, 2.2);
// EXACT linear -> 8-bit delinearizer (2026-09-06, replaces 12.6M Math.pow calls per texture-set decode).
// The old per-pixel expression was  byte = min(255, max(0, round(pow(x, 1/2.2) * 255)))  for x >= 0.
// That function is a monotone step function of x with 255 steps; DELIN_T[k] is the SMALLEST double x at
// which it first returns >= k, found by bisection on the double lattice against the ORIGINAL expression
// itself (the oracle), so the table is exact by construction for this engine's Math.pow. delin8(x) then
// counts thresholds <= x (8-step binary search) -- proven byte-identical to the oracle over a 53.6M-input
// sweep (every threshold +-2000 ulps, a 40M-point dense [0,2.5] grid, 10M random doubles, and the exact
// production shape lin(c)*s stretched about the channel mean; 0 mismatches).
const _delinOracle = (x) => Math.min(255, Math.max(0, Math.round(Math.pow(x, 1 / 2.2) * 255)));
function _nextUp(x) { const b = new Float64Array([x]); const u = new BigUint64Array(b.buffer); u[0] += 1n; return b[0]; }
export const DELIN_T = (() => {
  const T = new Float64Array(256);
  for (let k = 1; k <= 255; k++) {
    let lo = 0, hi = 2;   // oracle(2) == 255 >= k for every k
    if (_delinOracle(lo) >= k) { T[k] = lo; continue; }
    while (_nextUp(lo) < hi) { const mid = lo + (hi - lo) / 2; if (_delinOracle(mid) >= k) hi = mid; else lo = mid; }
    T[k] = hi;
  }
  return T;
})();
export function delin8(x) {   // x >= 0 (finite) -> 0..255, == _delinOracle(x)
  let lo = 1, hi = 255, r = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (DELIN_T[m] <= x) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
const _yield = () => new Promise(res => setTimeout(res, 0));

// ---- the full surface photo-texture set decode ----------------------------------------------------
// grass/rock/sand/snow color + displacement JPGs (+ artist normal JPGs where present) -> two packed
// sampler2DArray pixel blocks: albAll = sRGB color (RGB) + displacement (A); nrmAll = tangent normal xy
// 0.5-biased (RG) + displacement (B). Normals are Sobel-derived from the displacement when no normal JPG
// exists (3x3 + two wider taps, WRAPPED edges -- the textures tile). Runs identically on the main thread
// (gl-render.js inline fallback) and inside surface-texture-worker.js; every heavy sub-pass is separated
// by a macrotask yield so no single block runs long on whichever thread hosts it.
// baseUrl: absolute URL of the textures directory (trailing slash); defaults to this module's ../textures/.
export async function decodeSurfaceTextureSet(baseUrl) {
  const base = baseUrl || new URL('../textures/', import.meta.url).href;
  const MATS = ['grass', 'rock', 'sand', 'snow'];   // layer order: matches terrain.glsl splat
  // Normal JPG filenames per material (null = derive from displacement via Sobel)
  const NRM_JPGS = ['grass-normals.jpg', 'ground-normals.jpg', 'sand-normals.jpg', 'snow-normals.jpg'];
  const SZ = 1024;
  const px = async (u) => (await decodeImageToPixels(u, SZ, SZ)).data;
  const albAll = new Uint8Array(SZ * SZ * 4 * MATS.length);
  const nrmAll = new Uint8Array(SZ * SZ * 4 * MATS.length);
  const _tex = (n) => new URL(n, base).href;
  for (let m = 0; m < MATS.length; m++) {
    const [c, d, nj] = await Promise.all([px(_tex(MATS[m] + '-color.jpg')), px(_tex(MATS[m] + '-displacement.jpg')), px(_tex(NRM_JPGS[m])).catch(() => null)]);
    // DE-SHADE (user 2026-06-11 'flat, unangled bowls of rock'): divide each pixel by a wrapped-bilinear
    // 32x32 blur of the photo's own linear color (renormalized to the photo mean), PER-CHANNEL (user
    // 2026-06-11: large grey-brown bare-dirt patches differ in CHROMA) -- kills bowl-scale light/blotches,
    // keeps fine grain.
    { const G = 32, cell = SZ / G, grid = new Float32Array(G * G * 3), cnt = cell * cell;
      const lin = (v) => LIN8[v];
      for (let y = 0; y < SZ; y++) for (let x = 0; x < SZ; x++) {
        const i = (y * SZ + x) * 4, g = (((y / cell) | 0) * G + ((x / cell) | 0)) * 3;
        grid[g] += LIN8[c[i]]; grid[g + 1] += LIN8[c[i + 1]]; grid[g + 2] += LIN8[c[i + 2]];
      }
      const gMean = [0, 0, 0];
      for (let g = 0; g < G * G; g++) for (let ch = 0; ch < 3; ch++) { grid[g * 3 + ch] /= cnt; gMean[ch] += grid[g * 3 + ch]; }
      for (let ch = 0; ch < 3; ch++) gMean[ch] /= G * G;
      await _yield();   // sub-pass yield: blur accumulate -> per-pixel divide
      for (let y = 0; y < SZ; y++) {
        if ((y & 255) === 255) await _yield();   // ~quarter-image slices (keeps each block well under ~10ms)
        for (let x = 0; x < SZ; x++) {
          const gx = x / cell - 0.5, gy = y / cell - 0.5;
          const x0 = (Math.floor(gx) + G) % G, y0 = (Math.floor(gy) + G) % G;
          const x1 = (x0 + 1) % G, y1 = (y0 + 1) % G;
          const fx = gx - Math.floor(gx), fy = gy - Math.floor(gy);
          const i = (y * SZ + x) * 4;
          for (let ch = 0; ch < 3; ch++) {
            const blur = (grid[(y0 * G + x0) * 3 + ch] * (1 - fx) + grid[(y0 * G + x1) * 3 + ch] * fx) * (1 - fy)
                       + (grid[(y1 * G + x0) * 3 + ch] * (1 - fx) + grid[(y1 * G + x1) * 3 + ch] * fx) * fy;
            // pow 0.8: the patches must GO; fine (sub-64px) structure is untouched by construction.
            const s = Math.min(2.5, Math.max(0.4, Math.pow(gMean[ch] / Math.max(blur, 1e-4), 0.8)));
            // FINE-CONTRAST RESTORE (user 2026-06-11): stretch the remaining (fine-grain) deviation around
            // the channel mean x1.35 so the texture stays visible on flat ground.
            const v = lin(c[i + ch]) * s;
            c[i + ch] = delin8(Math.max(0, gMean[ch] + (v - gMean[ch]) * 1.35));   // == min(255,max(0,round(pow(.,1/2.2)*255))), exact
          }
        }
      }
    }
    // yield between the de-shade and Sobel/pack passes (perf sweep 2026-06-11)
    await _yield();
    const baseO = m * SZ * SZ * 4;
    if (nj) {
      // Use artist-authored normal JPG directly (RG = tangent XY 0.5-biased, standard normal map format)
      for (let i = 0; i < SZ * SZ; i++) {
        const o = baseO + i * 4;
        albAll[o] = c[i * 4]; albAll[o + 1] = c[i * 4 + 1]; albAll[o + 2] = c[i * 4 + 2]; albAll[o + 3] = d[i * 4];
        nrmAll[o] = nj[i * 4]; nrmAll[o + 1] = nj[i * 4 + 1]; nrmAll[o + 2] = d[i * 4]; nrmAll[o + 3] = 255;
      }
    } else {
      // Derive normals from displacement via multi-scale Sobel (fallback when no normals JPG)
      const S = 2.2;
      for (let y = 0; y < SZ; y++) {
        if ((y & 255) === 255) await _yield();
        const ym = (y + SZ - 1) % SZ, yp = (y + 1) % SZ;
        for (let x = 0; x < SZ; x++) {
          const xm = (x + SZ - 1) % SZ, xp = (x + 1) % SZ;
          const i = y * SZ + x, o = baseO + i * 4;
          const r = (X, Y) => d[(Y * SZ + X) * 4];
          const gx = (r(xp, ym) + 2 * r(xp, y) + r(xp, yp) - r(xm, ym) - 2 * r(xm, y) - r(xm, yp)) / (8 * 255);
          const gy = (r(xm, yp) + 2 * r(x, yp) + r(xp, yp) - r(xm, ym) - 2 * r(x, ym) - r(xp, ym)) / (8 * 255);
          const x6p = (x + 6) % SZ, x6m = (x + SZ - 6) % SZ, y6p = (y + 6) % SZ, y6m = (y + SZ - 6) % SZ;
          const gx2 = (r(x6p, y) - r(x6m, y)) / (2 * 255), gy2 = (r(x, y6p) - r(x, y6m)) / (2 * 255);
          const x48p = (x + 48) % SZ, x48m = (x + SZ - 48) % SZ, y48p = (y + 48) % SZ, y48m = (y + SZ - 48) % SZ;
          const gx3 = (r(x48p, y) - r(x48m, y)) / (2 * 255), gy3 = (r(x, y48p) - r(x, y48m)) / (2 * 255);
          let nx = -(gx * S + gx2 * 2.5 + gx3 * 2.0), ny = -(gy * S + gy2 * 2.5 + gy3 * 2.0);
          const tm = Math.hypot(nx, ny);
          if (tm > 0.9) { nx *= 0.9 / tm; ny *= 0.9 / tm; }
          const il = 1 / Math.hypot(nx, ny, 1);
          albAll[o] = c[i * 4]; albAll[o + 1] = c[i * 4 + 1]; albAll[o + 2] = c[i * 4 + 2]; albAll[o + 3] = d[i * 4];
          nrmAll[o] = Math.round((nx * il * 0.5 + 0.5) * 255);
          nrmAll[o + 1] = Math.round((ny * il * 0.5 + 0.5) * 255);
          nrmAll[o + 2] = d[i * 4]; nrmAll[o + 3] = 255;
        }
      }
    }
    await _yield();
  }
  // mean LINEAR color of the rock photo (layer 1): the far-field macro bcRock defaults to this so
  // the >20km rock shade matches the near-field photo rock (no color pop across the fade).
  let rockMean;
  { let r = 0, g = 0, b = 0; const b1 = 1 * SZ * SZ * 4, n = SZ * SZ;
    for (let i = 0; i < n; i++) { r += albAll[b1 + i * 4]; g += albAll[b1 + i * 4 + 1]; b += albAll[b1 + i * 4 + 2]; }
    const lin = (v) => Math.pow(v / n / 255, 2.2);
    rockMean = [lin(r), lin(g), lin(b)];
  }
  await _yield();
  // mean LINEAR luminance per layer (user 2026-06-11): the shader shade-matches the photo by dividing out
  // its LAYER-MEAN luminance.
  const meanL = [0, 0, 0, 0];
  for (let m = 0; m < MATS.length; m++) {
    let s = 0; const b0 = m * SZ * SZ * 4, n = SZ * SZ;
    for (let i = 0; i < n; i++) {
      s += 0.2126 * LIN8[albAll[b0 + i * 4]] + 0.7152 * LIN8[albAll[b0 + i * 4 + 1]] + 0.0722 * LIN8[albAll[b0 + i * 4 + 2]];
    }
    meanL[m] = s / n;
    await _yield();
  }
  return { albAll, nrmAll, meanL, rockMean, matCount: MATS.length, sz: SZ };
}
