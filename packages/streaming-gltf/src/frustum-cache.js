import * as THREE from 'three';

export class CachedFrustumPlanes {
  constructor() {
    this.planes = [
      new THREE.Vector4(),
      new THREE.Vector4(),
      new THREE.Vector4(),
      new THREE.Vector4(),
      new THREE.Vector4(),
      new THREE.Vector4(),
    ];

    this._frustum = new THREE.Frustum();
    this._tmpMatrix = new THREE.Matrix4();
  }

  updatePlanes(camera, sourceFrustum) {
    const frustum = sourceFrustum || (() => {
      this._tmpMatrix.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse
      );
      this._frustum.setFromProjectionMatrix(this._tmpMatrix);
      return this._frustum;
    })();

    for (let i = 0; i < 6; i++) {
      const srcPlane = frustum.planes[i];
      const dstPlane = this.planes[i];
      dstPlane.x = srcPlane.normal.x;
      dstPlane.y = srcPlane.normal.y;
      dstPlane.z = srcPlane.normal.z;
      dstPlane.w = srcPlane.constant;
    }
  }

  getPlaneUniforms() {
    return this.planes;
  }

  getPlane(index) {
    return this.planes[index] || new THREE.Vector4();
  }

  testSphere(cx, cy, cz, r) {
    for (let i = 0; i < 6; i++) {
      const p = this.planes[i];
      const len = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
      if (len > 0) {
        const d = (p.x * cx + p.y * cy + p.z * cz + p.w) / len;
        if (d < -r) return false;
      }
    }
    return true;
  }
}
