import { MeshBasicNodeMaterial } from 'three/webgpu'
import { Fn, buffer, instanceIndex, cameraPosition, positionGeometry, vec3, vec4 } from 'three/tsl'

function instanceMatrixNodeFor(object) {
  const im = object.instanceMatrix
  return buffer(im.array, 'mat4', Math.max(im.count, 1)).element(instanceIndex)
}

export function createDotMaterialTSL(matrixNode) {
  const mat = new MeshBasicNodeMaterial({ color: 0xffcc66, transparent: true, opacity: 0.85, depthWrite: false })

  mat.positionNode = Fn((builder) => {
    const instanceMatrixNode = matrixNode || instanceMatrixNodeFor(builder.object)
    const worldPos = instanceMatrixNode.mul(vec4(0.0, 0.0, 0.0, 1.0)).xyz
    const toCam = cameraPosition.sub(worldPos).normalize()
    const up = vec3(0.0, 1.0, 0.0)
    const right = toCam.cross(up).normalize()
    const camUp = right.cross(toCam)
    const sx = instanceMatrixNode[0].xyz.length()
    const billboardLocal = right.mul(positionGeometry.x).mul(sx).add(camUp.mul(positionGeometry.z).mul(sx))
    return instanceMatrixNode.mul(vec4(billboardLocal, 1.0)).xyz
  })()

  return mat
}
