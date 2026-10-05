import { bakeTransmittanceLUT, LUT_WIDTH, LUT_HEIGHT } from './atmosphere-transmittance-lut.js'
import { bakeScatteringLUT, SCAT_LUT_WIDTH, SCAT_LUT_HEIGHT, SCAT_LUT_LAYERS } from './atmosphere-scattering-lut.js'
import { runModuleWorkerJob } from './worker-job.js'

export function startLutBakeWorker() {
  return runModuleWorkerJob(new URL('./atmosphere-lut-worker.js', import.meta.url), {}, (d) => (d.trans && d.scat ? { trans: d.trans, scat: d.scat } : null))
}

export function bakeAtmosphereLUTsSync() {
  const trans = bakeTransmittanceLUT(LUT_WIDTH, LUT_HEIGHT)
  const scat = bakeScatteringLUT(SCAT_LUT_WIDTH, SCAT_LUT_HEIGHT, SCAT_LUT_LAYERS, undefined, trans)
  return { trans, scat }
}

export async function bakeAtmosphereLUTs() {
  const job = startLutBakeWorker()
  const off = job ? await job : null
  if (off) { performance.mark('boot:backdrop:lut-worker-done'); return off }
  performance.mark('boot:backdrop:lut-sync-bake-start')
  const baked = bakeAtmosphereLUTsSync()
  performance.mark('boot:backdrop:lut-sync-bake-done')
  return baked
}
