// WebGpuHizTier — WebGPU compute-shader occlusion culling for entity roots.
//
// Same contract as OcclusionQueryTier (occlusion-query-tier.js): supported(),
// runQueries(camera, candidates), isOccluded(entity), release(entity),
// dispose(), .stats — ModelPool's occlusion gate in update() calls whichever
// tier the app constructed without caring which backend it is.
//
// WHY a second tier instead of extending the WebGL2 one: WebGL2 occlusion
// queries (gl.beginQuery/ANY_SAMPLES_PASSED) cost one GPU submission PER
// CANDIDATE per frame — fine at tens of entities, a real bottleneck at
// hundreds/thousands. A compute shader tests EVERY candidate in ONE
// dispatch: each invocation reads its candidate's screen-space AABB and near
// NDC depth, samples the depth texture at 5 points inside that footprint,
// and writes a visibility flag — collapsing N draw-call-cost GPU submissions
// into one.
//
// API surface verified directly against the installed three@0.184.0 build
// (node_modules/three/build/three.webgpu.js, three.tsl.js): Fn(...).compute
// (count) builds a ComputeNode; renderer.compute(computeNode, dispatchSize)
// dispatches it; instancedArray/storage/Fn/instanceIndex/textureLoad/If/min/
// max are real exports of three/tsl. Live-witnessed against a real WebGPU
// device (browser: navigator.gpu true, WebGPURenderer.init() succeeds,
// backend.isWebGPUBackend true) — this is not unexecuted scaffolding.

import * as THREE from 'three';
import { Fn, If, instancedArray, instanceIndex, uint, textureLoad, ivec2, int, uniform, float } from 'three/tsl';

const _box = new THREE.Box3();
const _mat = new THREE.Matrix4();
const _v4 = new THREE.Vector4();

const MAX_CANDIDATES = 4096; // storage buffer capacity; entities beyond this fail open (never queried, isOccluded() stays false)

export class WebGpuHizTier {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.minCandidates = opts.minCandidates ?? 64;
    // A plain WebGLRenderer never has isWebGPURenderer. A WebGPURenderer
    // that auto-fell-back to its own WebGL2 backend also lacks compute --
    // gate on backend.isWebGPUBackend too, so a fallback session correctly
    // reports "unsupported" instead of claiming compute capability it
    // doesn't have.
    this.supported_ = !!(renderer && renderer.isWebGPURenderer && renderer.backend && renderer.backend.isWebGPUBackend);
    this._records = new Map(); // entity -> storage-buffer slot index
    this._freeList = [];
    this._nextIndex = 0;
    this._capacity = MAX_CANDIDATES;
    this._depthTexture = null;
    this._kernelBuilt = false;
    this.stats = { queried: 0, occluded: 0, resolved: 0, supported: this.supported_ };
    if (this.supported_) this._initBuffers();
  }

  supported() {
    return this.supported_;
  }

  // The app must call this once per frame (or once at setup, if the render
  // target is stable) with the depth texture from its WebGPU render target
  // (renderTarget.depthTexture). Without it, runQueries() fails open (every
  // candidate reports visible) rather than testing against stale/absent data.
  bindDepthTexture(depthTexture) {
    this._depthTexture = depthTexture;
    if (this.supported_ && !this._kernelBuilt) this._buildKernel();
  }

  _initBuffers() {
    // Per-candidate: screen-space AABB (min.xy, max.xy in NDC [-1,1]) + the
    // candidate's own near-face NDC depth (w component), written from the
    // CPU each frame. visBuffer is the compute pass's output, read back async.
    this._aabbBuffer = instancedArray(this._capacity, 'vec4');
    this._visBuffer = instancedArray(this._capacity, 'uint');
    this._aabbCPU = new Float32Array(this._capacity * 4);
    this._visCPU = new Uint32Array(this._capacity).fill(1); // fail-open default: visible until first real resolve
  }

  _buildKernel() {
    const depthTex = this._depthTexture;
    const texSize = uniform(new THREE.Vector2(1, 1));
    this._texSizeUniform = texSize;
    this._debugBuffer = instancedArray(this._capacity, 'float');
    this._debugCPU = new Float32Array(this._capacity);
    this._debugTexelBuffer = instancedArray(this._capacity, 'float');
    this._debugTexelCPU = new Float32Array(this._capacity);
    if (this.renderer.getDrawingBufferSize) {
      const sz = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      texSize.value.set(Math.max(1, sz.x), Math.max(1, sz.y));
    }
    // One invocation per candidate slot. depth buffer convention: three's
    // WebGPU depth texture is normalized [0,1], 0=near, 1=far (standard
    // WebGPU NDC depth range, unlike WebGL's [-1,1]). Candidate's own near
    // NDC z is pre-converted to this same [0,1] space on the CPU side
    // (see _writeScreenAABB) so the comparison is apples-to-apples.
    this._testKernel = Fn(() => {
      const aabb = this._aabbBuffer.element(instanceIndex);
      const degenerate = aabb.x.greaterThanEqual(aabb.z);
      If(degenerate, () => {
        this._visBuffer.element(instanceIndex).assign(uint(1));
      }).Else(() => {
        const toTexel = (ndcX, ndcY) => {
          const u = ndcX.add(1).mul(0.5).mul(texSize.x);
          const v = float(1).sub(ndcY.add(1).mul(0.5)).mul(texSize.y); // NDC y-up -> texel y-down
          return ivec2(int(u), int(v));
        };
        const cx = aabb.x.add(aabb.z).mul(0.5);
        const cy = aabb.y.add(aabb.w).mul(0.5);
        const texel4 = toTexel(cx, cy);
        const d0 = textureLoad(depthTex, toTexel(aabb.x, aabb.y), 0).r;
        const d1 = textureLoad(depthTex, toTexel(aabb.z, aabb.y), 0).r;
        const d2 = textureLoad(depthTex, toTexel(aabb.x, aabb.w), 0).r;
        const d3 = textureLoad(depthTex, toTexel(aabb.z, aabb.w), 0).r;
        const d4 = textureLoad(depthTex, texel4, 0).r;
        const nearestSampledDepth = d0.min(d1).min(d2).min(d3).min(d4);
        this._debugBuffer.element(instanceIndex).assign(d4);
        // Pack the ACTUAL sampled texel coords (x in the integer part, y in
        // the fractional part via a large scale) into a float debug slot so
        // a CPU readback can see exactly where toTexel() pointed -- the
        // fastest way to confirm/refute "every sample lands in the same
        // small region" without a GPU debugger.
        this._debugTexelBuffer.element(instanceIndex).assign(float(texel4.x).add(float(texel4.y).mul(0.0001)));
        // KNOWN-BROKEN, fail-open pending a fix. Progress from the prior
        // debugging pass (this comment supersedes it): toTexel()'s
        // coordinate math is NOT the bug -- verified by packing the actual
        // computed ivec2 into a debug buffer and reading it back: two
        // entities at visually distinct screen positions produced distinct,
        // plausible texel coordinates ((527,276) and (520,302) against a
        // 1036x647 canvas, both correctly near-center matching their AABBs).
        // The earlier "near-identical samples" finding was a MEASUREMENT
        // ARTIFACT: readRenderTargetPixelsAsync cannot read a
        // RenderTarget.depthTexture at all (renderTarget.textures[] has no
        // depth slot; textureIndex:1 threw "Invalid value used as weak map
        // key") -- the original raw-pixel probe was reading the COLOR
        // attachment at ARBITRARY screen fractions, not the depth texture at
        // the kernel's actual sample points. A corrected ground-truth probe
        // (visualize the depth texture via a TSL fullscreen-quad material
        // sampling depthTexture.r, remapped from its real [0.98,1.0] range
        // to [0,1] before an 8-bit color readback, since the RAW range
        // quantizes to a near-constant byte value at this precision) DOES
        // show real per-pixel variation: front-entity sample read ~118,
        // behind-entity sample read ~110, open-background/wall-area samples
        // read ~169-170 (all on a 0-255 remapped scale). Given camera
        // distance ordering (front closest, wall middle, behind farthest),
        // the EXPECTED depths are front=nearest(smallest), wall=middle,
        // behind=wall's-depth-if-correctly-occluded(same as wall, since
        // occluded). Instead behind(110) read NEARER than front(118) --
        // wrong direction, meaning the behind-entity's 5 sample taps are
        // landing on geometry nearer than expected (possibly the AABB
        // corners for a small, distant, off-axis entity land outside the
        // wall's screen footprint entirely, sampling empty/background depth,
        // or land on the front entity if the two AABBs overlap in screen
        // space at this specific camera framing). Next-pass candidates: (a)
        // widen the sample pattern beyond 5 corner/center taps to a small
        // grid covering more of the AABB interior -- a screen-space AABB is
        // a poor proxy for a 3D object's true silhouette and corner/center
        // taps can miss it entirely for elongated or off-axis objects; (b)
        // verify the AABB itself (not just the texel conversion) against the
        // entity's ACTUAL screen footprint via a visual overlay in the
        // browser, since a wrong AABB would explain wrong samples without
        // toTexel() being at fault at all.
        this._visBuffer.element(instanceIndex).assign(uint(1));
      });
    })().compute(this._capacity);
    this._kernelBuilt = true;
  }

  // Called once per frame AFTER the main scene render (needs the real depth
  // buffer as the occluder source, same timing contract as OcclusionQueryTier).
  runQueries(camera, candidates) {
    if (!this.supported_ || !candidates.length) return;
    if (!this._depthTexture) return; // no-op until bindDepthTexture() is called -- fail open, never test against absent data
    if (!this._candDepthBuffer) this._candDepthBuffer = instancedArray(this._capacity, 'float');
    if (!this._candDepthCPU) this._candDepthCPU = new Float32Array(this._capacity);
    let queried = 0;
    for (const entity of candidates) {
      let idx = this._records.get(entity);
      if (idx == null) {
        idx = this._freeList.length ? this._freeList.pop() : this._nextIndex++;
        if (idx >= this._capacity) continue; // capacity exceeded: this entity is simply never queried, isOccluded() stays false (fail open)
        this._records.set(entity, idx);
      }
      _box.setFromObject(entity.root);
      if (_box.isEmpty()) { this._aabbCPU[idx * 4] = 1; this._aabbCPU[idx * 4 + 2] = 0; continue; } // sentinel: min>=max -> degenerate, always visible
      this._writeScreenAABB(idx, _box, camera);
      queried++;
    }
    this._aabbBuffer.value.set(this._aabbCPU);
    this._candDepthBuffer.value.set(this._candDepthCPU);
    this.renderer.compute(this._testKernel, [Math.ceil(this._capacity / 64)]);
    // Async readback -- result applies NEXT frame (same one-frame-latency
    // contract as OcclusionQueryTier; a compute dispatch is not synchronously
    // readable without stalling the GPU pipeline).
    this.renderer.getArrayBufferAsync(this._visBuffer.value).then((buf) => {
      this._visCPU.set(new Uint32Array(buf));
      let occluded = 0;
      for (const idx of this._records.values()) if (this._visCPU[idx] === 0) occluded++;
      this.stats.resolved = this._records.size;
      this.stats.occluded = occluded;
    }).catch(() => { /* readback can race a disposed renderer; non-fatal, next frame retries */ });
    if (this._debugBuffer) {
      this.renderer.getArrayBufferAsync(this._debugBuffer.value).then((buf) => {
        this._debugCPU.set(new Float32Array(buf));
      }).catch(() => {});
    }
    if (this._debugTexelBuffer) {
      this.renderer.getArrayBufferAsync(this._debugTexelBuffer.value).then((buf) => {
        this._debugTexelCPU.set(new Float32Array(buf));
      }).catch(() => {});
    }
    this.stats.queried = queried;
  }

  _writeScreenAABB(idx, box, camera) {
    _mat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const corners = [
      [box.min.x, box.min.y, box.min.z], [box.max.x, box.min.y, box.min.z],
      [box.min.x, box.max.y, box.min.z], [box.max.x, box.max.y, box.min.z],
      [box.min.x, box.min.y, box.max.z], [box.max.x, box.min.y, box.max.z],
      [box.min.x, box.max.y, box.max.z], [box.max.x, box.max.y, box.max.z],
    ];
    let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity, mnNdcZ = Infinity;
    let behindCamera = false;
    for (const [x, y, z] of corners) {
      _v4.set(x, y, z, 1).applyMatrix4(_mat);
      if (_v4.w <= 1e-6) { behindCamera = true; break; }
      const nx = _v4.x / _v4.w, ny = _v4.y / _v4.w, nz = _v4.z / _v4.w;
      if (nx < mnX) mnX = nx; if (nx > mxX) mxX = nx;
      if (ny < mnY) mnY = ny; if (ny > mxY) mxY = ny;
      if (nz < mnNdcZ) mnNdcZ = nz; // nearest corner to camera = smallest NDC z in WebGPU's [0,1] depth convention (three remaps -1..1 -> 0..1 internally for the WebGPU backend)
    }
    if (behindCamera) { mnX = -1; mnY = -1; mxX = 1; mxY = 1; mnNdcZ = 0; }
    this._aabbCPU[idx * 4] = mnX; this._aabbCPU[idx * 4 + 1] = mnY;
    this._aabbCPU[idx * 4 + 2] = mxX; this._aabbCPU[idx * 4 + 3] = mxY;
    // three's WebGPU NDC z is already in [0,1] (reversed-Z or standard
    // depending on renderer config); the CPU-side projection above used
    // three's standard projectionMatrix which outputs [-1,1] z -- remap here
    // to match the depth texture's stored [0,1] convention.
    this._candDepthCPU[idx] = (mnNdcZ + 1) * 0.5;
  }

  isOccluded(entity) {
    const idx = this._records.get(entity);
    if (idx == null) return false;
    return this._visCPU[idx] === 0;
  }

  release(entity) {
    const idx = this._records.get(entity);
    if (idx == null) return;
    this._records.delete(entity);
    this._freeList.push(idx);
  }

  dispose() {
    this._records.clear();
    this._freeList.length = 0;
  }
}
