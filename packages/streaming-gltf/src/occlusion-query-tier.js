import * as THREE from 'three';

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _unitBoxSourceGeo = new THREE.BoxGeometry(1, 1, 1);
const _scaleMat = new THREE.Matrix4();
const _mvpMat = new THREE.Matrix4();
const _projViewMat = new THREE.Matrix4();
const _mvpArr = new Float32Array(16);
const QUERY_BOX_INFLATE_M = 1e-4;
const QUERY_BOX_DEPTH_SLOPE_BIAS = -4;
const QUERY_BOX_DEPTH_UNITS_BIAS = -8;

export class OcclusionQueryTier {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && this.gl instanceof WebGL2RenderingContext;
    this.minCandidates = opts.minCandidates ?? 64;
    this.maxQueriesPerFrame = opts.maxQueriesPerFrame ?? 32;
    this._rrCursor = 0;
    this._records = new Map();
    this.stats = { queried: 0, occluded: 0, resolved: 0, supported: this.isWebGL2 };
    this._boxProgram = null;
    this._boxVao = null;
  }

  supported() {
    return this.isWebGL2;
  }

  _ensureBoxGeometry() {
    if (this._boxProgram) return;
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, `#version 300 es
      uniform mat4 uMvp;
      layout(location=0) in vec3 aPos;
      void main(){ gl_Position = uMvp * vec4(aPos, 1.0); }`);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, `#version 300 es
      precision mediump float;
      out vec4 o;
      void main(){ o = vec4(0.0); }`);
    gl.compileShader(fs);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[occlusion-query-tier] box program link failed:', gl.getProgramInfoLog(prog));
      return;
    }
    this._boxProgram = { prog, uMvp: gl.getUniformLocation(prog, 'uMvp') };
    const posAttr = _unitBoxSourceGeo.getAttribute('position');
    const idxAttr = _unitBoxSourceGeo.getIndex();
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, posAttr.array, gl.STATIC_DRAW);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idxAttr.array, gl.STATIC_DRAW);
    this._boxVao = gl.createVertexArray();
    gl.bindVertexArray(this._boxVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bindVertexArray(null);
    this._indexCount = idxAttr.count;
    this._indexType = idxAttr.array instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  }

  runQueries(camera, candidates) {
    if (!this.isWebGL2 || !candidates.length) return;
    const gl = this.gl;
    this._ensureBoxGeometry();
    if (!this._boxProgram) return;

    let resolved = 0, occluded = 0;
    for (const [entity, rec] of this._records) {
      if (!rec.pending) continue;
      const available = gl.getQueryParameter(rec.query, gl.QUERY_RESULT_AVAILABLE);
      if (!available) continue;
      const passed = gl.getQueryParameter(rec.query, gl.QUERY_RESULT);
      rec.occluded = passed === 0;
      rec.pending = false;
      rec.resolves = (rec.resolves || 0) + 1;
      resolved++;
      if (rec.occluded) occluded++;
    }
    this.stats.resolved = resolved;
    this.stats.occluded = occluded;

    if (this.maxQueriesPerFrame <= 0) { this.stats.queried = 0; return; }

    gl.useProgram(this._boxProgram.prog);
    gl.bindVertexArray(this._boxVao);
    gl.colorMask(false, false, false, false);
    gl.depthMask(false);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(QUERY_BOX_DEPTH_SLOPE_BIAS, QUERY_BOX_DEPTH_UNITS_BIAS);

    _projViewMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    let queried = 0;
    const n = candidates.length;
    const budget = this.maxQueriesPerFrame;
    if (this._rrCursor >= n) this._rrCursor = 0;
    let idx = this._rrCursor;
    for (let examined = 0; examined < n && queried < budget; examined++, idx = (idx + 1) % n) {
      const entity = candidates[idx];
      let rec = this._records.get(entity);
      if (!rec) {
        rec = { query: gl.createQuery(), pending: false, occluded: false };
        this._records.set(entity, rec);
      }
      if (rec.pending) continue;

      if (!rec.localBox) {
        entity.root.updateWorldMatrix(true, true);
        const worldBox = new THREE.Box3().setFromObject(entity.root);
        if (worldBox.isEmpty()) { rec.localBox = null; }
        else {
          const invMatrix = new THREE.Matrix4().copy(entity.root.matrixWorld).invert();
          rec.localBox = worldBox.applyMatrix4(invMatrix);
        }
      }
      if (!rec.localBox) continue;
      _box.copy(rec.localBox).applyMatrix4(entity.root.matrixWorld);
      if (_box.isEmpty()) continue;
      _box.getSize(_size);
      _box.getCenter(_center);
      _size.addScalar(QUERY_BOX_INFLATE_M);

      _scaleMat.makeScale(_size.x, _size.y, _size.z);
      _scaleMat.setPosition(_center);
      _mvpMat.multiplyMatrices(_projViewMat, _scaleMat);
      _mvpMat.toArray(_mvpArr);

      gl.uniformMatrix4fv(this._boxProgram.uMvp, false, _mvpArr);
      gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, rec.query);
      gl.drawElements(gl.TRIANGLES, this._indexCount, this._indexType, 0);
      gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      rec.pending = true;
      queried++;
    }
    this._rrCursor = idx;
    gl.bindVertexArray(null);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    this.renderer.resetState();
    if (queried > 0) gl.flush();
    this.stats.queried = queried;
  }

  isOccluded(entity) {
    const rec = this._records.get(entity);
    return !!rec && rec.occluded;
  }

  getResolveCount(entity) {
    const rec = this._records.get(entity);
    return rec ? (rec.resolves || 0) : 0;
  }

  release(entity) {
    const rec = this._records.get(entity);
    if (!rec) return;
    this.gl.deleteQuery(rec.query);
    this._records.delete(entity);
  }

  dispose() {
    const gl = this.gl;
    for (const rec of this._records.values()) gl.deleteQuery(rec.query);
    this._records.clear();
    if (this._boxProgram) { gl.deleteProgram(this._boxProgram.prog); this._boxProgram = null; }
    if (this._boxVao) { gl.deleteVertexArray(this._boxVao); this._boxVao = null; }
  }
}
