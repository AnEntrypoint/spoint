import * as THREE from 'three'

// Flat per-node record layout inside the packed Float32Array used by tickBatch().
// [x,y,z, vx,vy,vz, rx,ry,rz,rw, lx,ly,lz, lrx,lry,lrz,lrw] = 17 floats/node
export const STRIDE = 17
const OFF_X = 0, OFF_Y = 1, OFF_Z = 2
const OFF_VX = 3, OFF_VY = 4, OFF_VZ = 5
const OFF_RX = 6, OFF_RY = 7, OFF_RZ = 8, OFF_RW = 9
const OFF_LX = 10, OFF_LY = 11, OFF_LZ = 12
const OFF_LRX = 13, OFF_LRY = 14, OFF_LRZ = 15, OFF_LRW = 16

export function lerpEntityTransform(mesh, target, lerpFactor, frameDt) {
  const gx = target.x + (target.vx || 0) * frameDt
  const gy = target.y + (target.vy || 0) * frameDt
  const gz = target.z + (target.vz || 0) * frameDt
  mesh.position.x += (gx - mesh.position.x) * lerpFactor
  mesh.position.y += (gy - mesh.position.y) * lerpFactor
  mesh.position.z += (gz - mesh.position.z) * lerpFactor
  // guard against a corrupt (NaN) snapshot rotation poisoning the matrix
  if (!(Number.isFinite(target.rx) && Number.isFinite(target.ry) && Number.isFinite(target.rz) && Number.isFinite(target.rw))) return
  // flip target sign when dot<0 so the lerp takes the shortest arc (quat double-cover)
  const dot = mesh.quaternion.x * target.rx + mesh.quaternion.y * target.ry + mesh.quaternion.z * target.rz + mesh.quaternion.w * target.rw
  const s = dot < 0 ? -1 : 1
  const dx = s * target.rx - mesh.quaternion.x, dy = s * target.ry - mesh.quaternion.y
  const dz = s * target.rz - mesh.quaternion.z, dw = s * target.rw - mesh.quaternion.w
  if (dx * dx + dy * dy + dz * dz + dw * dw > 1e-12) {
    mesh.quaternion.x += dx * lerpFactor; mesh.quaternion.y += dy * lerpFactor
    mesh.quaternion.z += dz * lerpFactor; mesh.quaternion.w += dw * lerpFactor
    // skip normalize() sqrt when already within tolerance of unit length (perf)
    const q = mesh.quaternion, nrm2 = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w
    if (Math.abs(nrm2 - 1) > 1e-6) mesh.quaternion.normalize()
  }
}

export function applyPlayerTransform(mesh, pos, lerpFactor) {
  if (!mesh.userData.initialized) {
    mesh.position.set(pos.x, pos.y, pos.z)
    mesh.userData.initialized = true
    return
  }
  if (lerpFactor === undefined) {
    mesh.position.x = pos.x; mesh.position.y = pos.y; mesh.position.z = pos.z
  } else {
    mesh.position.x += (pos.x - mesh.position.x) * lerpFactor
    mesh.position.y += (pos.y - mesh.position.y) * lerpFactor
    mesh.position.z += (pos.z - mesh.position.z) * lerpFactor
  }
}

// --- Batched flat-array path -------------------------------------------------
// Packs every interpolated (non-player) node's target+last-applied state into one
// contiguous Float32Array and runs a single tight loop over it per tick, instead of
// N separate per-object method calls into scattered THREE.Vector3/Quaternion fields.
// Rotation uses in-place nlerp (normalized lerp) with shortest-arc sign flip, which is
// the standard cheap approximation for per-tick rotation deltas this small -- avoids
// THREE.Quaternion.slerp's trig/allocation cost entirely.

export function ensureBatchCapacity(state, count) {
  const needed = count * STRIDE
  if (!state.buf || state.buf.length < needed) {
    const buf = new Float32Array(Math.max(needed, state.buf ? state.buf.length * 2 : 64))
    if (state.buf) buf.set(state.buf)
    state.buf = buf
  }
  return state.buf
}

/**
 * Runs one flat-array interpolation pass over `records` (array of {mesh,target} for
 * non-player nodes with a defined target.x). Returns true if any node moved.
 * `state` is a small persistent object ({buf}) owned by the caller (SceneGraph) so the
 * backing Float32Array is reused across ticks with zero per-tick allocation.
 */
export function tickBatch(state, records, lerpFactor, frameDt) {
  const n = records.length
  if (n === 0) return false
  const buf = ensureBatchCapacity(state, n)
  let moved = false

  // Pack: read each node's mesh + target into the flat buffer.
  for (let i = 0; i < n; i++) {
    const o = i * STRIDE
    const { mesh, target: t, last } = records[i]
    buf[o + OFF_X] = mesh.position.x; buf[o + OFF_Y] = mesh.position.y; buf[o + OFF_Z] = mesh.position.z
    buf[o + OFF_VX] = t.vx || 0; buf[o + OFF_VY] = t.vy || 0; buf[o + OFF_VZ] = t.vz || 0
    buf[o + OFF_RX] = mesh.quaternion.x; buf[o + OFF_RY] = mesh.quaternion.y
    buf[o + OFF_RZ] = mesh.quaternion.z; buf[o + OFF_RW] = mesh.quaternion.w
    // target position/rotation piggybacks on the "last" slots so the whole record
    // (current + target) lives in one cache line per node during the compute pass
    buf[o + OFF_LX] = t.x; buf[o + OFF_LY] = t.y; buf[o + OFF_LZ] = t.z
    buf[o + OFF_LRX] = last.hasRot ? t.rx : mesh.quaternion.x
    buf[o + OFF_LRY] = last.hasRot ? t.ry : mesh.quaternion.y
    buf[o + OFF_LRZ] = last.hasRot ? t.rz : mesh.quaternion.z
    buf[o + OFF_LRW] = last.hasRot ? t.rw : mesh.quaternion.w
  }

  // Compute: single tight numeric loop, no object/property dispatch, no allocation.
  for (let i = 0; i < n; i++) {
    const o = i * STRIDE
    const px = buf[o + OFF_X], py = buf[o + OFF_Y], pz = buf[o + OFF_Z]
    const gx = buf[o + OFF_LX] + buf[o + OFF_VX] * frameDt
    const gy = buf[o + OFF_LY] + buf[o + OFF_VY] * frameDt
    const gz = buf[o + OFF_LZ] + buf[o + OFF_VZ] * frameDt
    buf[o + OFF_X] = px + (gx - px) * lerpFactor
    buf[o + OFF_Y] = py + (gy - py) * lerpFactor
    buf[o + OFF_Z] = pz + (gz - pz) * lerpFactor

    const qx = buf[o + OFF_RX], qy = buf[o + OFF_RY], qz = buf[o + OFF_RZ], qw = buf[o + OFF_RW]
    const tx = buf[o + OFF_LRX], ty = buf[o + OFF_LRY], tz = buf[o + OFF_LRZ], tw = buf[o + OFF_LRW]
    const dot = qx * tx + qy * ty + qz * tz + qw * tw
    const s = dot < 0 ? -1 : 1
    const dx = s * tx - qx, dy = s * ty - qy, dz = s * tz - qz, dw = s * tw - qw
    const d2 = dx * dx + dy * dy + dz * dz + dw * dw
    if (d2 > 1e-12) {
      let nx = qx + dx * lerpFactor, ny = qy + dy * lerpFactor
      let nz = qz + dz * lerpFactor, nw = qw + dw * lerpFactor
      // in-place nlerp normalization, skipped when already within unit-length tolerance
      const nrm2 = nx * nx + ny * ny + nz * nz + nw * nw
      if (Math.abs(nrm2 - 1) > 1e-6) {
        const inv = 1 / Math.sqrt(nrm2)
        nx *= inv; ny *= inv; nz *= inv; nw *= inv
      }
      buf[o + OFF_RX] = nx; buf[o + OFF_RY] = ny; buf[o + OFF_RZ] = nz; buf[o + OFF_RW] = nw
    }
  }

  // Unpack: write the flat buffer back into each mesh's THREE objects.
  for (let i = 0; i < n; i++) {
    const o = i * STRIDE
    const { mesh, last } = records[i]
    mesh.position.x = buf[o + OFF_X]; mesh.position.y = buf[o + OFF_Y]; mesh.position.z = buf[o + OFF_Z]
    if (last.hasRot) {
      mesh.quaternion.x = buf[o + OFF_RX]; mesh.quaternion.y = buf[o + OFF_RY]
      mesh.quaternion.z = buf[o + OFF_RZ]; mesh.quaternion.w = buf[o + OFF_RW]
    }
    moved = true
  }
  return moved
}
