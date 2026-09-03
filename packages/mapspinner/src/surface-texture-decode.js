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
