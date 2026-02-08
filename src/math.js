export function mulQuat(a, b) {
  return [
    a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
    a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
    a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
    a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2]
  ]
}

export function rotVec(v, q) {
  const [qx, qy, qz, qw] = q
  const ix = qw*v[0] + qy*v[2] - qz*v[1]
  const iy = qw*v[1] + qz*v[0] - qx*v[2]
  const iz = qw*v[2] + qx*v[1] - qy*v[0]
  const iw = -qx*v[0] - qy*v[1] - qz*v[2]
  return [
    ix*qw + iw*-qx + iy*-qz - iz*-qy,
    iy*qw + iw*-qy + iz*-qx - ix*-qz,
    iz*qw + iw*-qz + ix*-qy - iy*-qx
  ]
}
