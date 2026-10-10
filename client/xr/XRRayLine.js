import * as THREE from 'three'

const STRAIGHT_RAY_VERTICES = 2

export function createRayLine({ color, opacity, name, length = 0, segments = STRAIGHT_RAY_VERTICES }) {
  const vertexCount = Math.max(STRAIGHT_RAY_VERTICES, segments)
  const last = vertexCount - 1
  const points = []
  for (let i = 0; i < vertexCount; i++) points.push(new THREE.Vector3(0, 0, -length * (i / last)))
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color, transparent: true, opacity }))
  line.name = name
  return line
}
