import { MeshLambertNodeMaterial } from 'three/webgpu'
import { Fn, attribute, texture, uniform, storage, instanceIndex, vec2, vec3, vec4, mod, floor, min, mix, clamp, positionLocal, normalLocal } from 'three/tsl'
import { bakeVAT, bakeVATMultiClip } from './PlayerVATBake.js'

function instanceMatrixNodeFor(object) {
  const im = object.instanceMatrix
  return storage(im, 'mat4', Math.max(im.count, 1)).element(instanceIndex)
}

export { bakeVAT, bakeVATMultiClip }

function vatFrameUV(vertexIndex, width, rowsPerFrame, frameCount, height, phase) {
  const frame = mod(phase, 1.0).mul(frameCount.sub(1.0)).toVar()
  const f0 = floor(frame).toVar()
  const f1 = min(f0.add(1.0), frameCount.sub(1.0))
  const falpha = frame.sub(f0)
  const col = mod(vertexIndex, width)
  const rowInFrame = floor(vertexIndex.div(width))
  const row0 = f0.mul(rowsPerFrame).add(rowInFrame)
  const row1 = f1.mul(rowsPerFrame).add(rowInFrame)
  const uv0 = vec2(col.add(0.5).div(width), row0.add(0.5).div(height))
  const uv1 = vec2(col.add(0.5).div(width), row1.add(0.5).div(height))
  return { uv0, uv1, falpha }
}

function vatSampleClip(tex, vertexIndex, width, rowsPerFrame, frameCount, height, phase) {
  const { uv0, uv1, falpha } = vatFrameUV(vertexIndex, width, rowsPerFrame, frameCount, height, phase)
  const d0 = texture(tex, uv0).xyz
  const d1 = texture(tex, uv1).xyz
  return mix(d0, d1, falpha)
}

function vatDims(data) {
  return {
    width: uniform(data.width),
    rowsPerFrame: uniform(data.rowsPerFrame),
    frameCount: uniform(data.frameCount),
    height: uniform(data.rowsPerFrame * data.frameCount),
  }
}

export function createVATMaterialTSL(vatData, opts = {}) {
  const moveVatData = opts.moveVatData || null
  const hasNormalVAT = !!(vatData.normalTexture || (moveVatData && moveVatData.normalTexture))

  const idle = vatDims(vatData)
  const move = moveVatData ? vatDims(moveVatData) : null

  const vatPhase = attribute('vatPhase', 'float')
  const vatIdlePhase = attribute('vatIdlePhase', 'float')
  const vatBlend = attribute('vatBlend', 'float')

  const vertexIndex = attribute('vatVertexIndex', 'float')

  const mat = new MeshLambertNodeMaterial({ color: opts.color ?? 0xd8b48c })
  mat._vatHasNormal = hasNormalVAT

  mat.positionNode = Fn((builder) => {
    const instanceMatrixNode = instanceMatrixNodeFor(builder.object)
    const deltaIdle = vatSampleClip(vatData.texture, vertexIndex, idle.width, idle.rowsPerFrame, idle.frameCount, idle.height, move ? vatIdlePhase : vatPhase)
    const delta = move
      ? mix(deltaIdle, vatSampleClip(moveVatData.texture, vertexIndex, move.width, move.rowsPerFrame, move.frameCount, move.height, vatPhase), clamp(vatBlend, 0.0, 1.0))
      : deltaIdle

    if (hasNormalVAT) {
      const nDeltaIdle = vatData.normalTexture
        ? vatSampleClip(vatData.normalTexture, vertexIndex, idle.width, idle.rowsPerFrame, idle.frameCount, idle.height, move ? vatIdlePhase : vatPhase)
        : vec3(0.0)
      const nDelta = move
        ? mix(
            nDeltaIdle,
            moveVatData.normalTexture
              ? vatSampleClip(moveVatData.normalTexture, vertexIndex, move.width, move.rowsPerFrame, move.frameCount, move.height, vatPhase)
              : vec3(0.0),
            clamp(vatBlend, 0.0, 1.0)
          )
        : nDeltaIdle
      normalLocal.addAssign(nDelta)
    }

    const localPos = positionLocal.add(delta)
    return instanceMatrixNode.mul(vec4(localPos, 1.0)).xyz
  })()

  return mat
}
