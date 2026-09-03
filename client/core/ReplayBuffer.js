// Generic replay/slowmo ring buffer: records a per-frame snapshot (whatever captureFn returns)
// into a fixed-size ring and lets a caller scrub back to any retained frame. Decoupled from any
// specific entity/game shape -- captureFn is the sole extension point. Ring-buffer shape mirrors
// client/core/RuntimeStats.js's createHistoryRing (closure state, fixed-size array, wraparound
// index, no reallocation once warmed up).
export function createReplayBuffer({ maxFrames = 600, captureFn, idleCaptureEveryNFrames = 4 } = {}) {
  if (typeof captureFn !== 'function') throw new Error('createReplayBuffer requires a captureFn() function')
  if (!Number.isFinite(maxFrames) || maxFrames < 1) throw new Error('createReplayBuffer requires maxFrames >= 1')

  const ring = new Array(maxFrames)
  let idx = 0       // next write slot
  let filled = 0    // frames actually recorded, caps at maxFrames
  let totalRecorded = 0   // monotonic count, survives wraparound (useful for external frame numbering)

  // Consumer registration: nothing actually reads the buffer most of the time (it's an opt-in
  // debug/replay primitive reached via window.__replayBuffer), so capturing every frame at full
  // rate is wasted work with zero readers. Any caller that wants full-rate capture calls
  // subscribe() (e.g. a replay-scrub UI opening); when the last consumer unsubscribes, capture
  // drops to a reduced idle rate (every Nth frame) rather than stopping outright, so scrubbing
  // back still finds *something* if a consumer attaches mid-session.
  let consumerCount = 0
  let framesSinceCapture = 0

  function subscribe() {
    consumerCount++
    return () => unsubscribe()
  }

  function unsubscribe() {
    if (consumerCount > 0) consumerCount--
  }

  function getConsumerCount() { return consumerCount }

  function record(nowMs) {
    if (consumerCount <= 0) {
      framesSinceCapture++
      if (framesSinceCapture < idleCaptureEveryNFrames) return undefined
      framesSinceCapture = 0
    } else {
      framesSinceCapture = 0
    }
    const frame = captureFn(nowMs)
    ring[idx] = frame
    idx = (idx + 1) % maxFrames
    if (filled < maxFrames) filled++
    totalRecorded++
    return frame
  }

  function getFrameCount() { return filled }
  function getMaxFrames() { return maxFrames }
  function getTotalRecorded() { return totalRecorded }

  // frameIndex: 0 = oldest retained frame, getFrameCount()-1 = most recently recorded frame.
  function scrub(frameIndex) {
    if (filled === 0) throw new Error('ReplayBuffer.scrub: no frames recorded yet')
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= filled) {
      throw new Error(`ReplayBuffer.scrub: frameIndex ${frameIndex} out of range [0, ${filled - 1}]`)
    }
    // oldest retained physical slot: if the ring hasn't wrapped (filled < maxFrames), slot 0 is oldest.
    // once wrapped, the oldest slot is the NEXT write position (idx), since that's about to be overwritten.
    const oldestSlot = filled < maxFrames ? 0 : idx
    const physicalSlot = (oldestSlot + frameIndex) % maxFrames
    return ring[physicalSlot]
  }

  function clear() {
    ring.fill(undefined)
    idx = 0; filled = 0; totalRecorded = 0
  }

  return { record, scrub, getFrameCount, getMaxFrames, getTotalRecorded, clear, subscribe, unsubscribe, getConsumerCount }
}

// Reference captureFn factory: reads live per-frame render transforms out of the existing
// snapshot-interpolation entity stream (client/core/SceneGraph.js's nodes() map, which every
// player and entity mesh is registered into) -- the current equivalent of what a prior prototype
// read directly off its own hardcoded entity list. Generic over ANY tracked id, not a specific
// game's entity types: a captured frame is just { t, transforms: { [id]: {x,y,z,qx,qy,qz,qw} } }.
export function createSceneGraphCaptureFn(sceneGraph) {
  return function captureSceneGraphFrame(nowMs) {
    const transforms = {}
    for (const [id, node] of sceneGraph.nodes()) {
      const g = node.group
      if (!g) continue
      const p = g.position, q = g.quaternion
      transforms[id] = { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w }
    }
    return { t: nowMs != null ? nowMs : performance.now(), transforms }
  }
}
