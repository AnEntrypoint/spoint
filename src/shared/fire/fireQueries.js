const MAX_SAMPLES = 512

function insidePlumeLength(rangeM, startAboveGroundM, climbPerMetre, plumeM) {
  if (!(climbPerMetre > 1e-6)) return startAboveGroundM <= plumeM ? rangeM : 0
  const exit = (plumeM - startAboveGroundM) / climbPerMetre
  return exit < rangeM ? exit : rangeM
}

export function rayOpticalDepth(kernel, face, I0, J0, I1, J1, rangeM, startAboveGroundM, climbPerMetre, plumeM, cellM) {
  const length = insidePlumeLength(rangeM, startAboveGroundM, climbPerMetre, plumeM)
  if (!(length > 0)) return 0
  const dI = I1 - I0, dJ = J1 - J0
  const samples = Math.min(MAX_SAMPLES, Math.max(1, Math.ceil(length / (cellM * 0.5))))
  const segment = length / samples
  let depth = 0
  for (let k = 0; k < samples; k++) {
    const f = (k + 0.5) * segment / rangeM
    const density = kernel.smokeAt(face, I0 + Math.round(dI * f), J0 + Math.round(dJ * f))
    if (density !== 0) depth += density * segment / 255
  }
  return depth
}

export function sampledOpticalDepth(kernel, lattice, frame, origin, direction, rangeM, startAboveGroundM, plumeM, scratch) {
  const length = insidePlumeLength(rangeM, startAboveGroundM, direction[1], plumeM)
  if (!(length > 0)) return 0
  const samples = Math.min(MAX_SAMPLES, Math.max(1, Math.ceil(length / (lattice.cellM * 0.5))))
  const segment = length / samples
  let depth = 0
  for (let k = 0; k < samples; k++) {
    const along = (k + 0.5) * segment
    const d = frame.localToDir(origin[0] + direction[0] * along, origin[2] + direction[2] * along, origin[1] + direction[1] * along)
    lattice.cellOfDir(d[0], d[1], d[2], scratch)
    const density = kernel.smokeAt(scratch.face, scratch.I, scratch.J)
    if (density !== 0) depth += density * segment / 255
  }
  return depth
}
