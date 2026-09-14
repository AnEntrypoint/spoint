const XF_IDLE = 10
const XF_LEN = 11

function captureTransform(xf, e) {
  const p = e.position, r = e.rotation, s = e.scale
  const p0 = p[0], p1 = p[1], p2 = p[2], r0 = r[0], r1 = r[1], r2 = r[2], r3 = r[3], s0 = s[0], s1 = s[1], s2 = s[2]
  const changed = xf[0] !== p0 || xf[1] !== p1 || xf[2] !== p2 || xf[3] !== r0 || xf[4] !== r1 || xf[5] !== r2 || xf[6] !== r3 || xf[7] !== s0 || xf[8] !== s1 || xf[9] !== s2
  if (changed) { xf[0] = p0; xf[1] = p1; xf[2] = p2; xf[3] = r0; xf[4] = r1; xf[5] = r2; xf[6] = r3; xf[7] = s0; xf[8] = s1; xf[9] = s2 }
  return changed
}

export function mixinStaticMotion(runtime) {
  runtime._staticXf = new Map()
  runtime._staticMotionVersion = -1

  runtime.trackStaticMotion = function(idleSnapshots) {
    const staticReencodePending = this._staticMotionVersion !== this._staticVersion
    const xfs = this._staticXf, moving = this._movedStaticIds
    let demoted = false
    for (const id of this._staticEntityIds) {
      const e = this.entities.get(id); if (!e) continue
      let xf = xfs.get(id)
      if (!xf) { xf = new Float64Array(XF_LEN); captureTransform(xf, e); xfs.set(id, xf); continue }
      const changed = captureTransform(xf, e)
      if (moving.has(id)) {
        if (changed) xf[XF_IDLE] = 0
        else if (++xf[XF_IDLE] >= idleSnapshots) { moving.delete(id); demoted = true }
      } else if (changed && !staticReencodePending) {
        xf[XF_IDLE] = 0
        moving.add(id)
      }
    }
    if (demoted) this._staticVersion++
    this._staticMotionVersion = this._staticVersion
  }

  runtime._forgetStaticMotion = function(id) {
    this._staticXf.delete(id)
    this._movedStaticIds.delete(id)
  }
}
