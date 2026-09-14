import { bakeTransmittanceLUT, LUT_WIDTH, LUT_HEIGHT } from './atmosphere-transmittance-lut.js';
import { bakeScatteringLUT, SCAT_LUT_WIDTH, SCAT_LUT_HEIGHT, SCAT_LUT_LAYERS } from './atmosphere-scattering-lut.js';

self.onmessage = () => {
  try {
    const trans = bakeTransmittanceLUT(LUT_WIDTH, LUT_HEIGHT);
    const scat = bakeScatteringLUT(SCAT_LUT_WIDTH, SCAT_LUT_HEIGHT, SCAT_LUT_LAYERS, undefined, trans);
    self.postMessage({ ok: true, trans, scat }, [trans.data.buffer, scat.data.buffer]);
  } catch (e) {
    self.postMessage({ ok: false, error: String(e && e.message || e) });
  }
};
