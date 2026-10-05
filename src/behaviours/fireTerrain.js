export function createFirebreakFuel({ baseClassAt, breaks, frame, lattice, terrain }) {
  const centre = [0, 0, 0]
  const R = frame.radius
  const heightAt = breaks.heightAt ?? terrain.heightAt
  const seaLevelAt = breaks.seaLevelAt ?? terrain.seaLevelAt
  const kindAt = breaks.kindAt ?? terrain.kindAt

  function localXZ(face, I, J, out) {
    lattice.cellCentreDir(face, I, J, centre)
    const up = frame.up, east = frame.east, north = frame.north
    const du = centre[0] * up[0] + centre[1] * up[1] + centre[2] * up[2]
    if (!(du > 0.2)) return false
    const t = R + frame.anchorHeight
    out[0] = (centre[0] * east[0] + centre[1] * east[1] + centre[2] * east[2]) / du * t
    out[1] = (centre[0] * north[0] + centre[1] * north[1] + centre[2] * north[2]) / du * t
    return true
  }

  const xz = [0, 0]
  return function classAt(face, I, J) {
    const base = baseClassAt(face, I, J)
    if (base === 0 || !localXZ(face, I, J, xz)) return base
    const x = xz[0], z = xz[1]
    for (const c of breaks.cleared) if (Math.hypot(x - c.center[0], z - c.center[1]) <= c.radiusM) return 0
    if (kindAt !== null && breaks.kinds.size > 0) { const k = kindAt(x, z); if (k != null && breaks.kinds.has(k)) return 0 }
    if (breaks.water && heightAt !== null && seaLevelAt !== null) {
      const h = heightAt(x, z), sea = seaLevelAt(x, z)
      if (Number.isFinite(h) && Number.isFinite(sea) && h < sea) return 0
    }
    if (breaks.rock !== null && breaks.rock(x, z)) return 0
    return base
  }
}
