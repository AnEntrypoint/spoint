import { clampTiltInducedUpward } from '../shared/chartReexpress.js'

const groundScratch = [0, 0, 0]

export function reexpressMotionState(pass, state) {
  if (!state) return
  const transfer = pass.transfer
  const position = state.position
  let groundY = NaN
  if (Number.isFinite(state.groundY)) {
    groundScratch[0] = position[0]; groundScratch[1] = state.groundY; groundScratch[2] = position[2]
    groundY = transfer.point(groundScratch, groundScratch)[1]
  }
  pass.point(position)
  pass.vector(state.velocity)
  if (state.rotation) pass.yawRotation(state.rotation)
  if (state.groundNormal) pass.vector(state.groundNormal)
  if (state.onGround) clampTiltInducedUpward(transfer, state.velocity)
  if ('groundY' in state) state.groundY = state.onGround ? position[1] : groundY
}

export function saveStepNormal(entry, normal) {
  entry.hasNormal = !!normal
  if (normal) { entry.normal[0] = normal[0]; entry.normal[1] = normal[1]; entry.normal[2] = normal[2] }
}

export function copyAckedEntry(dst, src, moveKeys) {
  dst.sequence = src.sequence
  for (let i = 0; i < 3; i++) { dst.position[i] = src.position[i]; dst.velocity[i] = src.velocity[i] }
  dst.onGround = src.onGround; dst.groundY = src.groundY
  for (const k of moveKeys) dst.move[k] = src.move[k]
}

// --- hot swap -----------------------------------------------------------------------------
// Every export below is a pure function over its arguments. groundScratch is a per-call scratch
// buffer that every call overwrites before reading, so the swapped-in copy starts from the same
// observable state. An ESM import is a live binding to this instance's export bindings, so every
// importer already holding them reads the new code on its next call.
const _hotSwapPredictionChart = (next) => {
  reexpressMotionState = next.reexpressMotionState
  saveStepNormal = next.saveStepNormal
  copyAckedEntry = next.copyAckedEntry
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapPredictionChart)
