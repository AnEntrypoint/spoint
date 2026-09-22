import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, If, int, float, vec3, vec4, ivec2, mix, clamp, pow,
  positionLocal, vertexColor, textureLoad, textureSize,
  instanceIndex, drawIndex, uniform,
} from 'three/tsl';

function getIndirectIndexTSL(indirectTexture, id) {
  const size = int(textureSize(textureLoad(indirectTexture), 0).x).toConst();
  const x = int(id).mod(size).toConst();
  const y = int(id).div(size).toConst();
  return textureLoad(indirectTexture, ivec2(x, y)).x;
}

function lerpTexelTSL(lerpTexture, lerpTexWNode, idxNode) {
  const w = int(lerpTexWNode).toConst();
  const x = idxNode.mod(w).toConst();
  const y = idxNode.div(w).toConst();
  return textureLoad(lerpTexture, ivec2(x, y));
}

export function makeBatchedFarTierMaterialTSL(lerpTex, lerpTexW, nowSec) {
  const material = new MeshBasicNodeMaterial();
  const uLerpTexW = uniform(lerpTexW);
  const uNow = uniform(nowSec);

  material.colorNode = Fn(() => {
    const vc = vertexColor();
    return vec4(pow(vc.rgb, vec3(2.2)), vc.a);
  })();

  material.positionNode = Fn((builder) => {
    const batchMesh = builder.object;
    const batchingIdNode = builder.getDrawIndex() === null ? instanceIndex : drawIndex;
    const indirectId = getIndirectIndexTSL(batchMesh._indirectTexture, int(batchingIdNode));
    const base = float(indirectId).mul(2).toInt();

    const p0 = lerpTexelTSL(lerpTex, uLerpTexW, base);
    const p1 = lerpTexelTSL(lerpTex, uLerpTexW, base.add(1));
    const dur = p1.w;

    const pos = positionLocal.toVar();
    If(dur.greaterThan(0.0), () => {
      const t = clamp(uNow.sub(p0.w).div(dur), 0.0, 1.0);
      const offset = mix(p0.xyz, p1.xyz, t).sub(p0.xyz);
      pos.addAssign(offset);
    });
    return pos;
  })();

  return { material, uLerpTexW, uNow };
}
