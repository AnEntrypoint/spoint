// CachedFrustumPlanes — Pre-compute frustum planes on CPU side.
//
// Problem: Every vertex in the GPU frustum culling code extracts 6 frustum
// planes from the 4x4 projViewMatrix using 16 instructions per vertex.
// For 1M vertices/frame, this wastes 16M GPU instructions.
//
// Solution: Extract planes once per frame on the CPU using Three.js's
// Frustum API, then pass them as 6 vec4 uniforms to the shader.
// The shader uses them directly with 0 extraction overhead.
//
// Expected gain: +2-3 FPS (eliminate extraction overhead per vertex).

import * as THREE from 'three';

export class CachedFrustumPlanes {
  constructor() {
    // 6 planes: [left, right, bottom, top, near, far]
    // Each plane is a vec4: (normal.x, normal.y, normal.z, distance)
    this.planes = [
      new THREE.Vector4(), // left
      new THREE.Vector4(), // right
      new THREE.Vector4(), // bottom
      new THREE.Vector4(), // top
      new THREE.Vector4(), // near
      new THREE.Vector4(), // far
    ];

    // Scratch THREE.Frustum for extraction (reused per frame)
    this._frustum = new THREE.Frustum();
    this._tmpMatrix = new THREE.Matrix4();
  }

  /**
   * Update frustum planes from camera's view-projection matrix.
   * Call once per frame before rendering.
   *
   * @param {THREE.Camera} camera - The camera to extract planes from.
   * @param {THREE.Frustum} [sourceFrustum] - Optional already-computed frustum
   *   (e.g. the caller's own per-frame `THREE.Frustum.setFromProjectionMatrix`
   *   result) to copy planes from directly, skipping the redundant
   *   projView multiply + plane extraction this method would otherwise redo
   *   from `camera` itself. Pass this whenever the caller already built a
   *   frustum from the same camera/projView this frame.
   */
  updatePlanes(camera, sourceFrustum) {
    const frustum = sourceFrustum || (() => {
      // Compose view-projection matrix: projection × inverse(matrixWorld)
      this._tmpMatrix.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse
      );
      // Use Three.js Frustum to extract the 6 planes
      this._frustum.setFromProjectionMatrix(this._tmpMatrix);
      return this._frustum;
    })();

    // Copy planes from frustum to our uniform array
    // Frustum.planes is a Vector4[] where each plane is (normal.x, normal.y, normal.z, distance)
    for (let i = 0; i < 6; i++) {
      const srcPlane = frustum.planes[i];
      const dstPlane = this.planes[i];
      dstPlane.x = srcPlane.normal.x;
      dstPlane.y = srcPlane.normal.y;
      dstPlane.z = srcPlane.normal.z;
      dstPlane.w = srcPlane.constant;
    }
  }

  /**
   * Get the 6 planes as an array of vec4 for shader uniforms.
   * Format: [leftPlane, rightPlane, bottomPlane, topPlane, nearPlane, farPlane]
   *
   * @returns {THREE.Vector4[]} Array of 6 planes.
   */
  getPlaneUniforms() {
    return this.planes;
  }

  /**
   * Get a single plane by index [0..5].
   * Useful for debugging or alternate shader approaches.
   *
   * @param {number} index - Plane index [0..5].
   * @returns {THREE.Vector4} The requested plane.
   */
  getPlane(index) {
    return this.planes[index] || new THREE.Vector4();
  }

  /**
   * Test if a world-space sphere is within all 6 planes.
   * Returns true if the sphere might be visible (conservative test).
   * Used for CPU-side validation/debugging.
   *
   * @param {number} cx - Sphere center X.
   * @param {number} cy - Sphere center Y.
   * @param {number} cz - Sphere center Z.
   * @param {number} r - Sphere radius.
   * @returns {boolean} True if sphere intersects frustum.
   */
  testSphere(cx, cy, cz, r) {
    for (let i = 0; i < 6; i++) {
      const p = this.planes[i];
      const len = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
      if (len > 0) {
        const d = (p.x * cx + p.y * cy + p.z * cz + p.w) / len;
        if (d < -r) return false; // sphere is fully outside this plane
      }
    }
    return true;
  }
}
