import { decodeSurfaceTextureSet } from './surface-texture-decode.js';

self.onmessage = async (ev) => {
  try {
    const r = await decodeSurfaceTextureSet(ev.data && ev.data.baseUrl);
    self.postMessage({ ok: true, ...r }, [r.albAll.buffer, r.nrmAll.buffer]);
  } catch (e) {
    self.postMessage({ ok: false, error: String(e && e.message || e) });
  }
};
