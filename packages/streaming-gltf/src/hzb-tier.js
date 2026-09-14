import * as THREE from 'three';

const _v = new THREE.Vector3();
const OCCLUSION_DEPTH_EPS = 1e-5;

const FULLSCREEN_VS = `#version 300 es
// Single oversized triangle covering the viewport with no vertex buffer —
// gl_VertexID-driven, avoids a VBO/VAO attribute for a pass this cheap.
out vec2 vUv;
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;

const REDUCE_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;   // 1/srcWidth, 1/srcHeight
uniform vec2 uSrcSize;    // srcWidth, srcHeight (for edge clamp)
in vec2 vUv;
out vec4 oColor;
void main() {
  vec2 base = floor(vUv * uSrcSize) * 2.0;
  vec2 c00 = min(base, uSrcSize - 1.0);
  vec2 c10 = min(base + vec2(1.0, 0.0), uSrcSize - 1.0);
  vec2 c01 = min(base + vec2(0.0, 1.0), uSrcSize - 1.0);
  vec2 c11 = min(base + vec2(1.0, 1.0), uSrcSize - 1.0);
  float d00 = texture(uSrc, (c00 + 0.5) * uSrcTexel).r;
  float d10 = texture(uSrc, (c10 + 0.5) * uSrcTexel).r;
  float d01 = texture(uSrc, (c01 + 0.5) * uSrcTexel).r;
  float d11 = texture(uSrc, (c11 + 0.5) * uSrcTexel).r;
  float m = min(min(d00, d10), min(d01, d11));
  oColor = vec4(m, m, m, 1.0);
}`;

const SEED_FS = `#version 300 es
precision highp float;
uniform sampler2D uDepth;
in vec2 vUv;
out vec4 oColor;
void main() {
  float d = texture(uDepth, vUv).r;
  oColor = vec4(d, d, d, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`[hzb-tier] shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`[hzb-tier] program link failed: ${log}`);
  }
  return prog;
}

export class HzbTier {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && this.gl instanceof WebGL2RenderingContext;
    this.minCandidates = opts.minCandidates ?? 64;
    this._depthTarget = null;
    this._mips = [];
    this._seedProgram = null;
    this._reduceProgram = null;
    this._vao = null;
    this._readPixel = new Uint8Array(4);
    this._pyrW = 0;
    this._pyrH = 0;
    this._pyramidReady = false;
    this.stats = { levels: 0, queried: 0, occluded: 0, supported: this.isWebGL2 };
    this._records = new Map();
  }

  supported() {
    return this.isWebGL2;
  }

  _ensurePrograms() {
    if (this._seedProgram) return;
    const gl = this.gl;
    this._seedProgram = { prog: link(gl, FULLSCREEN_VS, SEED_FS), uDepth: null };
    this._seedProgram.uDepth = gl.getUniformLocation(this._seedProgram.prog, 'uDepth');
    this._reduceProgram = { prog: link(gl, FULLSCREEN_VS, REDUCE_FS), uSrc: null, uSrcTexel: null, uSrcSize: null };
    this._reduceProgram.uSrc = gl.getUniformLocation(this._reduceProgram.prog, 'uSrc');
    this._reduceProgram.uSrcTexel = gl.getUniformLocation(this._reduceProgram.prog, 'uSrcTexel');
    this._reduceProgram.uSrcSize = gl.getUniformLocation(this._reduceProgram.prog, 'uSrcSize');
    this._vao = gl.createVertexArray();
  }

  _ensurePyramid(width, height) {
    const gl = this.gl;
    width = Math.max(1, width | 0);
    height = Math.max(1, height | 0);
    if (this._pyrW === width && this._pyrH === height && this._mips.length) return;
    this._pyrW = width;
    this._pyrH = height;
    this._disposeMips();
    let w = width, h = height;
    for (;;) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this._mips.push({ tex, fbo, w, h });
      if (w === 1 && h === 1) break;
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.stats.levels = this._mips.length;
  }

  _disposeMips() {
    const gl = this.gl;
    for (const m of this._mips) {
      gl.deleteTexture(m.tex);
      gl.deleteFramebuffer(m.fbo);
    }
    this._mips.length = 0;
  }

  buildPyramid(rawDepthTex, width, height) {
    if (!this.isWebGL2 || !rawDepthTex) return false;
    const gl = this.gl;
    this._ensurePrograms();
    this._ensurePyramid(width, height);
    if (!this._mips.length) return false;

    const prevTarget = this.renderer.getRenderTarget();
    const prevViewport = new THREE.Vector4();
    this.renderer.getViewport(prevViewport);

    gl.bindVertexArray(this._vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);

    const lvl0 = this._mips[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, lvl0.fbo);
    gl.viewport(0, 0, lvl0.w, lvl0.h);
    gl.useProgram(this._seedProgram.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rawDepthTex);
    gl.uniform1i(this._seedProgram.uDepth, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(this._reduceProgram.prog);
    for (let i = 1; i < this._mips.length; i++) {
      const src = this._mips[i - 1];
      const dst = this._mips[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(this._reduceProgram.uSrc, 0);
      gl.uniform2f(this._reduceProgram.uSrcTexel, 1 / src.w, 1 / src.h);
      gl.uniform2f(this._reduceProgram.uSrcSize, src.w, src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setViewport(prevViewport);
    this.renderer.resetState();
    this._pyramidReady = true;
    return true;
  }

  captureAndBuild(scene, camera, width, height) {
    if (!this.isWebGL2) return false;
    width = Math.max(1, width | 0);
    height = Math.max(1, height | 0);
    if (!this._depthTarget || this._depthTarget.width !== width || this._depthTarget.height !== height) {
      if (this._depthTarget) this._depthTarget.dispose();
      this._depthTarget = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: true,
        stencilBuffer: false,
        depthTexture: new THREE.DepthTexture(width, height, THREE.UnsignedIntType),
      });
    }
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this._depthTarget);
    this.renderer.clear(true, true, false);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(prevTarget);

    const props = this.renderer.properties.get(this._depthTarget.depthTexture);
    const rawTex = props && props.__webglTexture;
    if (!rawTex) return false;
    return this.buildPyramid(rawTex, width, height);
  }

  _selectLevel(wPx, hPx) {
    const span = Math.max(wPx, hPx, 1);
    let level = Math.ceil(Math.log2(span));
    if (level < 0) level = 0;
    if (level >= this._mips.length) level = this._mips.length - 1;
    return level;
  }

  _readMipTexel(level, u, v) {
    const gl = this.gl;
    const mip = this._mips[level];
    if (!mip) return 1;
    const x = Math.min(mip.w - 1, Math.max(0, Math.floor(u * mip.w)));
    const y = Math.min(mip.h - 1, Math.max(0, Math.floor(v * mip.h)));
    gl.bindFramebuffer(gl.FRAMEBUFFER, mip.fbo);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._readPixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this._readPixel[0] / 255;
  }

  isOccludedBox(worldBox, camera) {
    if (!this._pyramidReady || !this._mips.length || !camera) return false;
    if (worldBox.isEmpty()) return false;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity;
    let anyInFront = false;
    const min = worldBox.min, max = worldBox.max;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
      _v.applyMatrix4(camera.matrixWorldInverse);
      if (_v.z > -camera.near) continue;
      anyInFront = true;
      _v.applyMatrix4(camera.projectionMatrix);
      if (!isFinite(_v.x) || !isFinite(_v.y) || !isFinite(_v.z)) continue;
      const sx = (_v.x * 0.5 + 0.5);
      const sy = (_v.y * 0.5 + 0.5);
      const sz = (_v.z * 0.5 + 0.5);
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
      if (sz < minZ) minZ = sz;
    }
    if (!anyInFront || !isFinite(minX) || !isFinite(minY)) return false;
    minX = Math.max(0, minX); maxX = Math.min(1, maxX);
    minY = Math.max(0, minY); maxY = Math.min(1, maxY);
    if (maxX <= minX || maxY <= minY) return false;

    const wPx = (maxX - minX) * this._pyrW;
    const hPx = (maxY - minY) * this._pyrH;
    const level = this._selectLevel(wPx, hPx);
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const pyramidDepth = this._readMipTexel(level, cx, cy);
    return minZ >= pyramidDepth + OCCLUSION_DEPTH_EPS;
  }

  isOccluded(entity) {
    const rec = this._records.get(entity);
    if (!rec || !rec.localBox) return false;
    const worldBox = rec.localBox.clone().applyMatrix4(entity.root.matrixWorld);
    return this.isOccludedBox(worldBox, this._lastCamera);
  }

  runQueries(camera, candidates) {
    if (!this.isWebGL2 || !this._pyramidReady) { this.stats.queried = 0; this.stats.occluded = 0; return; }
    this._lastCamera = camera;
    let occluded = 0;
    for (let i = 0; i < candidates.length; i++) {
      const entity = candidates[i];
      let rec = this._records.get(entity);
      if (!rec) { rec = {}; this._records.set(entity, rec); }
      if (!rec.localBox) {
        entity.root.updateWorldMatrix(true, true);
        const worldBox = new THREE.Box3().setFromObject(entity.root);
        if (!worldBox.isEmpty()) {
          const inv = new THREE.Matrix4().copy(entity.root.matrixWorld).invert();
          rec.localBox = worldBox.clone().applyMatrix4(inv);
        }
      }
      if (rec.localBox && this.isOccluded(entity)) occluded++;
    }
    this.stats.queried = candidates.length;
    this.stats.occluded = occluded;
  }

  release(entity) {
    this._records.delete(entity);
  }

  dispose() {
    this._disposeMips();
    if (this._seedProgram) { this.gl.deleteProgram(this._seedProgram.prog); this._seedProgram = null; }
    if (this._reduceProgram) { this.gl.deleteProgram(this._reduceProgram.prog); this._reduceProgram = null; }
    if (this._vao) { this.gl.deleteVertexArray(this._vao); this._vao = null; }
    if (this._depthTarget) { this._depthTarget.dispose(); this._depthTarget = null; }
    this._records.clear();
    this._pyramidReady = false;
  }
}

