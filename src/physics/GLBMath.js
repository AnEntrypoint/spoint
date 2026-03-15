export function mat4Identity() {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
}

export function mat4TRS(t, r, s) {
  const [qx, qy, qz, qw] = r
  const [sx, sy, sz] = s
  const x2=qx+qx, y2=qy+qy, z2=qz+qz
  const xx=qx*x2, xy=qx*y2, xz=qx*z2
  const yy=qy*y2, yz=qy*z2, zz=qz*z2
  const wx=qw*x2, wy=qw*y2, wz=qw*z2
  return [
    (1-(yy+zz))*sx, (xy+wz)*sx,    (xz-wy)*sx,    0,
    (xy-wz)*sy,     (1-(xx+zz))*sy,(yz+wx)*sy,    0,
    (xz+wy)*sz,     (yz-wx)*sz,    (1-(xx+yy))*sz,0,
    t[0], t[1], t[2], 1
  ]
}

export function mat4Mul(a, b) {
  const out = new Array(16)
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[row + k*4] * b[k + col*4]
      out[row + col*4] = sum
    }
  }
  return out
}

export function applyTransformMatrix(vertices, m) {
  const count = vertices.length / 3
  const out = new Float32Array(vertices.length)
  for (let i = 0; i < count; i++) {
    const x = vertices[i*3], y = vertices[i*3+1], z = vertices[i*3+2]
    out[i*3]   = m[0]*x + m[4]*y + m[8]*z  + m[12]
    out[i*3+1] = m[1]*x + m[5]*y + m[9]*z  + m[13]
    out[i*3+2] = m[2]*x + m[6]*y + m[10]*z + m[14]
  }
  return out
}

export function buildNodeTransforms(json) {
  const nodes = json.nodes || []
  const matrices = new Array(nodes.length).fill(null)

  function getMatrix(nodeIdx) {
    if (matrices[nodeIdx] !== null) return matrices[nodeIdx]
    const node = nodes[nodeIdx]
    let local = mat4Identity()
    if (node.matrix) {
      local = node.matrix.slice()
    } else {
      const t = node.translation || [0, 0, 0]
      const r = node.rotation || [0, 0, 0, 1]
      const s = node.scale || [1, 1, 1]
      local = mat4TRS(t, r, s)
    }
    const parentIdx = nodes.findIndex((n, i) => i !== nodeIdx && (n.children || []).includes(nodeIdx))
    if (parentIdx >= 0) {
      local = mat4Mul(getMatrix(parentIdx), local)
    }
    matrices[nodeIdx] = local
    return local
  }

  for (let i = 0; i < nodes.length; i++) getMatrix(i)
  return matrices
}
