// atmosphere-lut-worker.js -- off-main-thread bake of the two CPU atmosphere LUTs (transmittance +
// single-scatter). Both bakes are PURE functions of the module constants (atmosphere-transmittance-lut.js /
// atmosphere-scattering-lut.js) -- same JS engine, same code, same doubles -> byte-identical Float32 data
// to the synchronous in-thread bake gl-render.js's ensureTransmittanceLUT/ensureScatteringLUT would
// otherwise run (~1-3 s of main-thread block at init). gl-render.js spawns this worker BEFORE the shader
// fetch/compile and awaits the result only where the synchronous bake used to run, so the LUT is always
// fully baked before the first frame (no not-yet-ready-LUT frame exists) and the CPU work overlaps the
// driver's shader compile instead of serializing after it. Any failure -> the caller falls back to the
// synchronous bake (see _startLutBakeWorker in gl-render.js).
import { bakeTransmittanceLUT, LUT_WIDTH, LUT_HEIGHT } from './atmosphere-transmittance-lut.js';
import { bakeScatteringLUT, SCAT_LUT_WIDTH, SCAT_LUT_HEIGHT, SCAT_LUT_LAYERS } from './atmosphere-scattering-lut.js';

self.onmessage = () => {
  try {
    // IDENTICAL call shapes to gl-render.js's ensureTransmittanceLUT / ensureScatteringLUT.
    const trans = bakeTransmittanceLUT(LUT_WIDTH, LUT_HEIGHT);
    const scat = bakeScatteringLUT(SCAT_LUT_WIDTH, SCAT_LUT_HEIGHT, SCAT_LUT_LAYERS, undefined, trans);
    self.postMessage({ ok: true, trans, scat }, [trans.data.buffer, scat.data.buffer]);
  } catch (e) {
    self.postMessage({ ok: false, error: String(e && e.message || e) });
  }
};
