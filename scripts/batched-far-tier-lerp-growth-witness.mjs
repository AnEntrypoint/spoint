import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIER_URL = pathToFileURL(path.join(ROOT, 'packages/streaming-gltf/src/batched-far-tier.js')).href;

const failures = [];
function expect(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` :: ${detail}`}`);
  if (!ok) failures.push(label);
}

function readTexel(tex, x, y) {
  const { data, width } = tex.image;
  const o = (y * width + x) * 4;
  return [data[o], data[o + 1], data[o + 2], data[o + 3]];
}

function readLerpPair(tier, id) {
  const idx0 = id * tier._lerpTexelsPerInstance;
  const w = tier._lerpTex.image.width;
  const p0 = readTexel(tier._lerpTex, idx0 % w, Math.floor(idx0 / w));
  const idx1 = idx0 + 1;
  const p1 = readTexel(tier._lerpTex, idx1 % w, Math.floor(idx1 / w));
  return { p0, p1 };
}

function stubShader() {
  return {
    uniforms: {},
    vertexShader: '#include <color_vertex>\n#include <batching_pars_vertex>\n#include <batching_vertex>',
  };
}

async function runGlPath(THREE, BatchedFarTier) {
  const tier = new BatchedFarTier({}, { maxInstances: 2, maxVerts: 4096, maxIndex: 4096 });
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const asset = { url: 'stub://box' };
  const id0 = tier.acquire({ n: 0 }, asset, 0, 0, geo);
  const id1 = tier.acquire({ n: 1 }, asset, 0, 0, geo);
  const id2 = tier.acquire({ n: 2 }, asset, 0, 0, geo);
  expect('gl: first two instances take ids 0 and 1', id0 === 0 && id1 === 1, `ids=${id0},${id1}`);
  expect('gl: third acquire grows instance count to 4', id2 === 2 && tier.maxInstances === 4, `id=${id2} maxInstances=${tier.maxInstances}`);

  tier.setLerpTarget(id2, 1, 2, 3, 4, 5, 6, 0.5, 2.0);
  const { p0, p1 } = readLerpPair(tier, id2);
  const stored = p0[0] === 1 && p0[1] === 2 && p0[2] === 3 && p0[3] === 0.5
    && p1[0] === 4 && p1[1] === 5 && p1[2] === 6 && p1[3] === 2.0;
  expect('gl: lerp for a grown id is stored and read back from the texture', stored,
    `p0=${JSON.stringify(p0)} p1=${JSON.stringify(p1)}`);

  const capacity = tier._lerpTex.image.width * tier._lerpTex.image.height;
  expect('gl: lerp texture holds two texels for every instance after growth', capacity >= 4 * 2,
    `texels=${capacity} needed=${4 * 2}`);

  const shader = stubShader();
  tier.material.onBeforeCompile(shader);
  expect('gl: shader uniform uLerpTexW tracks the grown texture width',
    shader.uniforms.uLerpTexW.value === tier._lerpTex.image.width,
    `uniform=${shader.uniforms.uLerpTexW.value} width=${tier._lerpTex.image.width}`);
  expect('gl: shader uniform uLerpTex is the live lerp texture', shader.uniforms.uLerpTex.value === tier._lerpTex);
}

async function runTslPath(THREE, BatchedFarTier) {
  const tier = new BatchedFarTier({ renderer: { isWebGPURenderer: true } }, { maxInstances: 2, maxVerts: 4096, maxIndex: 4096 });
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const asset = { url: 'stub://box-tsl' };
  tier.acquire({ n: 0 }, asset, 0, 0, geo);
  tier.acquire({ n: 1 }, asset, 0, 0, geo);
  const id2 = tier.acquire({ n: 2 }, asset, 0, 0, geo);
  const w = tier._lerpTex.image.width;
  expect('tsl: uniform node for lerp width tracks the grown texture',
    tier._uLerpTexWNode?.value === w,
    `node=${tier._uLerpTexWNode?.value} width=${w}`);
  tier.setLerpTarget(id2, 7, 8, 9, 10, 11, 12, 1.0, 3.0);
  const { p0, p1 } = readLerpPair(tier, id2);
  expect('tsl: lerp for a grown id is stored and read back from the texture',
    p0[0] === 7 && p0[3] === 1.0 && p1[0] === 10 && p1[3] === 3.0,
    `p0=${JSON.stringify(p0)} p1=${JSON.stringify(p1)}`);
}

async function main() {
  const THREE = await import('three');
  const { BatchedFarTier } = await import(TIER_URL);
  await runGlPath(THREE, BatchedFarTier);
  await runTslPath(THREE, BatchedFarTier);
  if (failures.length) {
    console.log(`RESULT: FAIL (${failures.length} check(s): ${failures.join('; ')})`);
    process.exit(1);
  }
  console.log('RESULT: PASS');
  process.exit(0);
}

main().catch((err) => {
  console.log(`RESULT: FAIL (threw: ${err && err.message})`);
  process.exit(1);
});
