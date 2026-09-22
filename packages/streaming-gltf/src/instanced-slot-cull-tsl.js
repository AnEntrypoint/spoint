import { Fn, If, instanceIndex, instancedArray, positionLocal, uniformArray, vec3, float, int } from 'three/tsl';

const CULL_SENTINEL = 1e7;

export function createInstancedSlotCullTSL(capacity, framePlanesArray) {
  return {
    capacity,
    boundBuffer: instancedArray(capacity, 'vec4'),
    boundCPU: new Float32Array(capacity * 4),
    planesNode: uniformArray(framePlanesArray, 'vec4'),
  };
}

export function applyInstancedSlotCullPositionNode(material, cull) {
  const boundBuffer = cull.boundBuffer;
  const planesNode = cull.planesNode;
  material.positionNode = Fn(() => {
    const pos = positionLocal.toVar();
    const b = boundBuffer.element(instanceIndex);
    const r = b.w;
    If(r.greaterThan(0.0), () => {
      const c = b.xyz;
      const outside = int(0).toVar();
      for (let i = 0; i < 6; i++) {
        const p = planesNode.element(int(i));
        const dist = p.xyz.dot(c).add(p.w);
        If(dist.lessThan(r.negate()), () => {
          outside.assign(int(1));
        });
      }
      If(outside.greaterThan(int(0)), () => {
        pos.assign(vec3(float(CULL_SENTINEL), float(CULL_SENTINEL), float(CULL_SENTINEL)));
      });
    });
    return pos;
  })();
  material.needsUpdate = true;
}

export function resizeInstancedSlotCull(material, cull, newCapacity, framePlanesArray) {
  cull.capacity = newCapacity;
  cull.boundBuffer = instancedArray(newCapacity, 'vec4');
  cull.boundCPU = new Float32Array(newCapacity * 4);
  cull.planesNode = uniformArray(framePlanesArray, 'vec4');
  applyInstancedSlotCullPositionNode(material, cull);
}

export function syncInstancedSlotCullBounds(cull, instanceMatrixArray, boundArray) {
  const boundCPU = cull.boundCPU;
  const n = cull.capacity;
  for (let i = 0; i < n; i++) {
    const base = i * 16;
    boundCPU[i * 4] = instanceMatrixArray[base + 12];
    boundCPU[i * 4 + 1] = instanceMatrixArray[base + 13];
    boundCPU[i * 4 + 2] = instanceMatrixArray[base + 14];
    boundCPU[i * 4 + 3] = boundArray[i] || 0;
  }
  cull.boundBuffer.value.set(boundCPU);
}
