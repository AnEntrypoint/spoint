export function createReplayBuffer({ maxFrames = 600, captureFn, idleCaptureEveryNFrames = 60 } = {}) {
  if (typeof captureFn !== 'function') throw new Error('createReplayBuffer requires a captureFn() function')
  if (!Number.isFinite(maxFrames) || maxFrames < 1) throw new Error('createReplayBuffer requires maxFrames >= 1')

  const ring = new Array(maxFrames)
  let idx = 0
  let filled = 0
  let totalRecorded = 0

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

  function scrub(frameIndex) {
    if (filled === 0) throw new Error('ReplayBuffer.scrub: no frames recorded yet')
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= filled) {
      throw new Error(`ReplayBuffer.scrub: frameIndex ${frameIndex} out of range [0, ${filled - 1}]`)
    }
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
