// surface-texture-worker.js -- off-main-thread decode of the 4-material surface photo-texture set
// (grass/rock/sand/snow color + displacement + normals -> the two packed sampler2DArray pixel blocks).
// The whole pipeline (fetch + createImageBitmap + de-shade blur + Sobel normals + means) lives in
// surface-texture-decode.js's decodeSurfaceTextureSet(), which is the SAME function gl-render.js runs
// inline when a Worker is unavailable -- one implementation, so the worker path and the inline fallback
// cannot diverge. Results are posted back with the two 16 MB pixel buffers TRANSFERRED (zero copy).
import { decodeSurfaceTextureSet } from './surface-texture-decode.js';

self.onmessage = async (ev) => {
  try {
    const r = await decodeSurfaceTextureSet(ev.data && ev.data.baseUrl);
    self.postMessage({ ok: true, ...r }, [r.albAll.buffer, r.nrmAll.buffer]);
  } catch (e) {
    self.postMessage({ ok: false, error: String(e && e.message || e) });
  }
};
