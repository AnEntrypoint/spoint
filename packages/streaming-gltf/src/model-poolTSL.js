import * as THREE from 'three/webgpu';
import { pow, vertexColor, vec3, vec4 } from 'three/tsl';

export function createVertexColorNodeMaterial() {
  const material = new THREE.MeshLambertNodeMaterial({ vertexColors: false });
  material.colorNode = vec4(pow(vertexColor().rgb, vec3(2.2)), vertexColor().a);
  return material;
}

export default { createVertexColorNodeMaterial };
