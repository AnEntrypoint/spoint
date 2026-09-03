// spoint-core: portable WASM math, codec, and hash functions.
// First slice of ugc-wasm-core-extraction — implements the 5 most portable core functions
// identified from the spoint JS codebase:
//   1. pack_quat / unpack_quat  (SnapshotEncoder.js — 32-bit quaternion compression)
//   2. fnv1a_hash               (msgpack.js / LockstepChecksum.js — FNV-1a 32-bit hash)
//   3. mul_quat                 (math.js — quaternion multiplication)
//   4. rot_vec                  (math.js — rotate vector by quaternion)
//
// These are all pure functions with zero DOM/Node dependencies, making them ideal for
// cross-platform WASM sharing. The JS equivalents are byte-identical in output.

use wasm_bindgen::prelude::*;

const QSCALE: f64 = 511.0 * std::f64::consts::SQRT_2;
const FNV_PRIME: u32 = 16777619;
const FNV_OFFSET: u32 = 0x811c9dc5;

// ---- Quaternion pack/unpack (32-bit "smallest three" representation) ----

/// Pack a quaternion into a 32-bit unsigned integer.
/// The largest-magnitude component is dropped; its sign is encoded in the maxIdx,
/// and the other three components are quantized to 10 bits each.
/// Layout: [maxIdx:2][c0:10][c1:10][c2:10]
/// Matches SnapshotEncoder.js packQuat byte-for-byte.
#[wasm_bindgen]
pub fn pack_quat(rx: f64, ry: f64, rz: f64, rw: f64) -> u32 {
    let arx = rx.abs();
    let ary = ry.abs();
    let arz = rz.abs();
    let arw = rw.abs();

    let (max_idx, max_val) = if ary > arx {
        if arz > ary {
            if arw > arz { (3, rw) } else { (2, rz) }
        } else {
            if arw > ary { (3, rw) } else { (1, ry) }
        }
    } else {
        if arz > arx {
            if arw > arz { (3, rw) } else { (2, rz) }
        } else {
            if arw > arx { (3, rw) } else { (0, rx) }
        }
    };

    let sign = if max_val < 0.0 { -1.0 } else { 1.0 };
    let components = [rx, ry, rz, rw];

    let mut packed: u32 = max_idx as u32;
    for i in 0..4 {
        if i != max_idx {
            let val = (components[i] * sign + std::f64::consts::FRAC_1_SQRT_2) * QSCALE;
            let clamped = val.max(0.0).min(1022.0).round() as u32;
            packed = (packed << 10) | (clamped & 0x3FF);
        }
    }
    packed
}

/// Unpack a 32-bit packed quaternion back into [rx, ry, rz, rw].
/// Matches SnapshotEncoder.js unpackQuat byte-for-byte.
#[wasm_bindgen]
pub fn unpack_quat(packed: u32) -> Vec<f64> {
    let max_idx = ((packed >> 30) & 0x3) as usize;
    let c2 = ((packed & 0x3FF) as f64) / QSCALE - std::f64::consts::FRAC_1_SQRT_2;
    let c1 = (((packed >> 10) & 0x3FF) as f64) / QSCALE - std::f64::consts::FRAC_1_SQRT_2;
    let c0 = (((packed >> 20) & 0x3FF) as f64) / QSCALE - std::f64::consts::FRAC_1_SQRT_2;

    let sum_sq = c0 * c0 + c1 * c1 + c2 * c2;
    let m = (1.0_f64 - sum_sq).max(0.0).sqrt();

    let mut out = [0.0_f64; 4];
    let comps = [c0, c1, c2];
    let indices: [[usize; 3]; 4] = [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]];
    let idx = indices[max_idx];

    out[max_idx] = m;
    out[idx[0]] = comps[0];
    out[idx[1]] = comps[1];
    out[idx[2]] = comps[2];

    out.to_vec()
}

// ---- FNV-1a 32-bit hash ----

/// Compute the FNV-1a 32-bit hash of a byte slice.
/// Matches msgpack.js _computeStructHash and LockstepChecksum.js foldFloat64.
#[wasm_bindgen]
pub fn fnv1a_32(data: &[u8]) -> u32 {
    let mut hash = FNV_OFFSET;
    for &byte in data {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// Compute the FNV-1a 32-bit hash of a string (UTF-8 encoded).
#[wasm_bindgen]
pub fn fnv1a_str(s: &str) -> u32 {
    fnv1a_32(s.as_bytes())
}

/// Step an FNV-1a hash with a f64 value, folding its raw IEEE 754 bits.
/// Matches LockstepChecksum.js foldFloat64 (normalizes -0 to 0, NaN to a fixed pattern).
#[wasm_bindgen]
pub fn fnv1a_fold_f64(hash: u32, n: f64) -> u32 {
    let v = if n == 0.0 { 0.0_f64 } else if n.is_nan() { f64::NAN } else { n };
    let bytes = v.to_le_bytes();
    let mut h = hash;
    for &byte in &bytes {
        h ^= byte as u32;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

// ---- Quaternion math ----

/// Multiply two quaternions [x, y, z, w].
/// Matches math.js mulQuat.
#[wasm_bindgen]
pub fn mul_quat(a: Vec<f64>, b: Vec<f64>) -> Vec<f64> {
    let (ax, ay, az, aw) = (a[0], a[1], a[2], a[3]);
    let (bx, by, bz, bw) = (b[0], b[1], b[2], b[3]);
    vec![
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]
}

/// Rotate a 3D vector by a quaternion.
/// Matches math.js rotVec.
#[wasm_bindgen]
pub fn rot_vec(v: Vec<f64>, q: Vec<f64>) -> Vec<f64> {
    let (vx, vy, vz) = (v[0], v[1], v[2]);
    let (qx, qy, qz, qw) = (q[0], q[1], q[2], q[3]);
    let ix = qw * vx + qy * vz - qz * vy;
    let iy = qw * vy + qz * vx - qx * vz;
    let iz = qw * vz + qx * vy - qy * vx;
    let iw = -qx * vx - qy * vy - qz * vz;
    vec![
        ix * qw + iw * -qx + iy * -qz - iz * -qy,
        iy * qw + iw * -qy + iz * -qx - ix * -qz,
        iz * qw + iw * -qz + ix * -qy - iy * -qx,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_unpack_roundtrip() {
        // Identity quaternion
        let packed = pack_quat(0.0, 0.0, 0.0, 1.0);
        let unpacked = unpack_quat(packed);
        assert!((unpacked[3] - 1.0).abs() < 0.002, "w should be ~1.0, got {:?}", unpacked);
    }

    #[test]
    fn fnv1a_basic() {
        let hash = fnv1a_str("hello");
        assert_ne!(hash, 0);
        // Same input = same hash
        assert_eq!(fnv1a_str("hello"), fnv1a_str("hello"));
    }

    #[test]
    fn mul_quat_identity() {
        let id = vec![0.0, 0.0, 0.0, 1.0];
        let q = vec![0.0, 0.7071, 0.0, 0.7071];
        let result = mul_quat(q.clone(), id.clone());
        for i in 0..4 {
            assert!((result[i] - q[i]).abs() < 0.001);
        }
    }
}