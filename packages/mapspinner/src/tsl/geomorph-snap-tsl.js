import { floor } from 'three/tsl'

export function parentGridPosition({ gridCoord, patchOrigin, patchSize, faceHalfExtent, gridSize }) {
  const vertexIndex = floor(gridCoord.mul(gridSize).add(0.5))
  const patchIndex = floor(patchOrigin.add(faceHalfExtent).div(patchSize).add(0.5))
  const globalIndex = patchIndex.mul(gridSize).add(vertexIndex)
  const pairIndex = floor(globalIndex.mul(0.5))
  const isOdd = globalIndex.sub(pairIndex.mul(2.0))
  const pairIsOdd = pairIndex.sub(floor(pairIndex.mul(0.5)).mul(2.0))
  const parentIndex = pairIndex.mul(2.0).add(isOdd.mul(pairIsOdd).mul(2.0))
  return parentIndex.mul(patchSize.div(gridSize)).sub(faceHalfExtent)
}
