// patch-deps.mjs -- postinstall text-patches for REGISTRY deps only. Each patch is IDEMPOTENT
// (no-op once its marker is present) so when the upstream package ships the fix natively the patch
// silently does nothing.
//
// mapspinner + streaming-gltf are NOT patched here anymore: they live in-repo as npm workspaces
// (packages/mapspinner, packages/streaming-gltf) -- node_modules/<name> is a symlink into packages/,
// so fixes are committed directly to the package source. The old vendorInto/marker-gated bridge for
// them (and the staleness bug class it carried) is gone.
//
// @three.ez/instanced-mesh instanceIndex decl: on three r183 a custom/depth material does not always
// include <batching_pars_vertex> (the chunk the lib appends the `attribute uint instanceIndex` decl
// onto), so the lib's injected uniforms block referenced an UNDECLARED instanceIndex -> shader compile
// fail -> broken program every frame (fps collapse + GL error flood across grass/veg/impostor). Prepend
// the decl when that chunk is absent.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// Every patch below targets @three.ez/instanced-mesh's built bundle by matching literal minified
// source text (anchor strings). That text shape is only guaranteed to match the exact version this
// was authored against -- a version bump (even a patch-level one) can reflow the minifier's output
// enough that the anchor silently fails to match, which the pre-existing `anchor not found` warning
// already degrades safely for. But the OPPOSITE failure mode is the dangerous one and was previously
// unguarded: the installed version drifts (via `npm update`/a lockfile change) while the anchor text
// HAPPENS to still match syntactically, silently applying a patch authored against different logic
// (wrong line, wrong intent) with no build failure -- a corrupt-but-plausible patched file that only
// shows up as a live rendering bug later. Pin the version this file was actually verified against and
// hard-fail (non-zero exit) the whole patch run on a mismatch instead of proceeding on an unverified base.
const PINNED_VERSIONS = {
  // Re-verified against 0.3.16's real build/index.js before moving this pin, which
  // is the whole point of the guard below -- "it installs" is not evidence when the
  // patches are literal source-text matches.
  //
  // Three of the four anchors were confirmed present EXACTLY ONCE in the pristine
  // 0.3.16 source (occurrence-count matters: String.replace would silently patch the
  // wrong site if an anchor appeared twice), and none of the markers were already
  // present. The fourth (`instanceIndex decl guard`) is correctly absent from
  // pristine source because it anchors on text the FIRST patch inserts -- the two
  // are sequential, not independent, so its absence pre-patch is expected rather
  // than drift.
  '@three.ez/instanced-mesh': '0.3.16'
}

function checkPinnedVersion(pkgName) {
  const pinned = PINNED_VERSIONS[pkgName]
  if (!pinned) return   // no pin recorded for this package -- nothing to verify
  const pkgJsonUrl = new URL(`../node_modules/${pkgName}/package.json`, import.meta.url)
  if (!existsSync(pkgJsonUrl)) return   // not installed; the per-patch existsSync check below already handles this
  let installed
  try {
    installed = JSON.parse(readFileSync(pkgJsonUrl, 'utf8')).version
  } catch (e) {
    console.error(`[patch-deps] FATAL: could not read ${pkgName}/package.json to verify version: ${e.message}`)
    process.exit(1)
  }
  if (installed !== pinned) {
    console.error(`[patch-deps] FATAL: ${pkgName} version mismatch -- installed ${installed}, patches in this file were verified against ${pinned}.`)
    console.error(`[patch-deps] The patch anchors are literal source-text matches against the pinned version; applying them against a different version risks a silent wrong-logic patch even if the anchor text happens to still match.`)
    console.error(`[patch-deps] Re-verify each patch's anchor/replacement against the new version's source, then update PINNED_VERSIONS in scripts/patch-deps.mjs.`)
    process.exit(1)
  }
}

function patch(relPath, marker, anchor, replacement, label) {
  const file = new URL('../' + relPath, import.meta.url)
  if (!existsSync(file)) { console.log(`[patch-deps] ${label}: not installed; skipping`); return }
  // relPath is node_modules/<pkg or @scope/pkg>/... -- derive the package name (1 or 2 segments) to
  // look up its pin, so a future patch() call against a different package is checked automatically.
  const pkgMatch = relPath.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//)
  if (pkgMatch) checkPinnedVersion(pkgMatch[1])
  const src = readFileSync(file, 'utf8')
  if (src.includes(marker)) { console.log(`[patch-deps] ${label}: already present (published or patched); no-op`); return }
  if (!src.includes(anchor)) { console.warn(`[patch-deps] ${label}: anchor not found -- upstream shape changed; skipping (verify the fix manually)`); return }
  writeFileSync(file, src.replace(anchor, replacement), 'utf8')
  console.log(`[patch-deps] ${label}: injected`)
}

patch(
  'node_modules/@three.ez/instanced-mesh/build/index.js',
  'spoint patch] three r183',
  `const { vertex: l, fragment: d } = this.uniformsTexture.getUniformsGLSL("uniformsTexture", "instanceIndex", "uint");
        h.vertexShader = h.vertexShader.replace("void main() {", l), h.fragmentShader = h.fragmentShader.replace("void main() {", d);`,
  `const { vertex: l, fragment: d } = this.uniformsTexture.getUniformsGLSL("uniformsTexture", "instanceIndex", "uint");
        // [spoint patch] three r183: custom/depth materials may lack <batching_pars_vertex> (which carries
        // the lib's appended \`attribute uint instanceIndex\` decl) -> the injected uniforms block referenced
        // an UNDECLARED instanceIndex -> compile fail -> broken program/fps collapse. Prepend the decl when
        // that chunk is absent (skip when present to avoid a redefinition).
        const _ezDecl = "#ifdef USE_INSTANCING_INDIRECT\\n\\tattribute highp uint instanceIndex;\\n#endif\\n";
        const _lv = h.vertexShader.includes("#include <batching_pars_vertex>") ? l : (_ezDecl + l);
        h.vertexShader = h.vertexShader.replace("void main() {", _lv), h.fragmentShader = h.fragmentShader.replace("void main() {", d);`,
  'three.ez instanceIndex decl'
)

// --- @three.ez/instanced-mesh instanceIndex decl guard gap (instancedmesh2-vegetation-shader-
//     useprogram-invalid-preexisting-bug): the "three r183" patch above only recognizes
//     '#include <batching_pars_vertex>' as evidence instanceIndex is already declared. But this
//     codebase's OWN hand-written InstancedMesh2 shaders (see the fix for
//     instancedmesh2-instanceindex-undeclared-identifier-vegetation-shader: Grass.js, Weather.js's
//     splash material, Vegetation.js's addShadowLOD dummy material, and SSAO.js's shared
//     scene.overrideMaterial G-buffer pass) declare instanceIndex via
//     '#include <instanced_pars_vertex>' instead -- a chunk the guard above doesn't check for. Any
//     InstancedMesh2 that BOTH uses one of those already-fixed shaders (or a shared override material
//     like SSAO's, which every InstancedMesh2 in the scene gets patched against once) AND has a
//     uniformsTexture (calls initUniformsPerInstance -- true for Weather.js's rain-splash pool) hits
//     the guard's false branch, prepending a SECOND 'attribute uint instanceIndex' decl on top of the
//     one '#include <instanced_pars_vertex>' already declared -> real live GL compile failure
//     ("'instanceIndex' : redefinition", vertex stage) -> the program never links -> every later
//     onBeforeRender's bindTextures() call passes that unlinked WebGLProgram to
//     renderer.state.useProgram(), which the GL driver rejects with "useProgram: program not valid"
//     every single frame that InstancedMesh2 renders. Root-caused live via a real booted server +
//     Playwright chromium (?singleplayer&world=tps-game, real streamed weather rain-splash particles)
//     with a WebGL2RenderingContext.prototype.compileShader/linkProgram monkeypatch: confirmed the
//     exact failing shader is SSAO.js's shared _gbufferMat (scene.overrideMaterial G-buffer pass, hit
//     via Weather.js's imSplash InstancedMesh2), verbatim compile error
//     "ERROR: 0:94: 'instanceIndex' : redefinition", and every useProgram INVALID_OPERATION traced by
//     stack to InstancedMesh2's own bindTextures call passing that exact unlinked program. Fix: widen
//     the guard to recognize EITHER include (both declare the same attribute the same way). ---
patch(
  'node_modules/@three.ez/instanced-mesh/build/index.js',
  'spoint patch] instanceIndex decl guard: instanced_pars_vertex',
  `const _lv = h.vertexShader.includes("#include <batching_pars_vertex>") ? l : (_ezDecl + l);`,
  `// [spoint patch] instanceIndex decl guard: instanced_pars_vertex -- '#include <instanced_pars_vertex>'
        // (this codebase's own instanceIndex-undeclared fix sites: Grass.js/Weather.js/Vegetation.js/
        // SSAO.js) ALSO declares instanceIndex, same as '#include <batching_pars_vertex>'; recognizing
        // only the latter caused a real 'instanceIndex : redefinition' compile failure (unlinked program
        // -> every later useProgram() call on it rejected by the GL driver) whenever a uniformsTexture-
        // bearing InstancedMesh2 (e.g. Weather.js's rain-splash pool, via initUniformsPerInstance) got
        // patched against one of those shaders (e.g. SSAO's shared scene.overrideMaterial G-buffer pass).
        const _hasInstanceIndexDecl = h.vertexShader.includes("#include <batching_pars_vertex>") || h.vertexShader.includes("#include <instanced_pars_vertex>");
        const _lv = _hasInstanceIndexDecl ? l : (_ezDecl + l);`,
  'three.ez instanceIndex decl guard gap (instanced_pars_vertex, useProgram-invalid root cause)'
)

// --- @three.ez/instanced-mesh bindTextures: drop a synchronous gl.getParameter(CURRENT_PROGRAM) read
//     + a restoring state.useProgram(h) that run on EVERY onBeforeRender/onBeforeShadow per InstancedMesh2/
//     LOD child per pass. three's WebGLState.useProgram is a TRACKED cache -- after state.useProgram(o) the
//     tracked program IS o, and WebGLRenderer.setProgram always re-establishes the correct program via the
//     same tracked path before any draw executes, so restoring the pre-call program is redundant. Zero
//     visual risk (verified against real source + adversarially confirmed); GC/driver-round-trip win only. ---
patch(
  'node_modules/@three.ez/instanced-mesh/build/index.js',
  'spoint patch] bindTextures',
  `const a = t.getContext(), c = s.getUniforms().map, h = a.getParameter(a.CURRENT_PROGRAM);
    t.state.useProgram(o), this.matricesTexture.bindToProgram(t, a, c, i, "matricesTexture"), this.colorsTexture?.bindToProgram(t, a, c, i, "colorsTexture"), this.uniformsTexture?.bindToProgram(t, a, c, i, "uniformsTexture"), this.boneTexture?.bindToProgram(t, a, c, i, "boneTexture"), t.state.useProgram(h);`,
  `const a = t.getContext(), c = s.getUniforms().map;
    // [spoint patch] bindTextures: dropped the getParameter(CURRENT_PROGRAM) read + restoring useProgram(h)
    // -- three's WebGLState.useProgram is a tracked cache, so after useProgram(o) the tracked program IS o,
    // and WebGLRenderer.setProgram re-establishes the correct program via the same tracked path before any
    // draw runs; nothing between here and the next draw reads gl.CURRENT_PROGRAM directly.
    t.state.useProgram(o), this.matricesTexture.bindToProgram(t, a, c, i, "matricesTexture"), this.colorsTexture?.bindToProgram(t, a, c, i, "colorsTexture"), this.uniformsTexture?.bindToProgram(t, a, c, i, "uniformsTexture"), this.boneTexture?.bindToProgram(t, a, c, i, "boneTexture");`,
  'three.ez bindTextures redundant program restore'
)

// --- @three.ez/instanced-mesh InstancedMeshBVH.frustumCullingLOD: the native bvh.js BVH resolves an
//     internal (non-leaf) node's LOD level from THAT NODE'S OWN (coarse, margin-inflated, multi-instance)
//     bounding box the instant the node is fully inside the frustum (bvh.js's own showAll fast path),
//     and stamps that ONE level onto every instance beneath it with ZERO hysteresis (bvh.js source has a
//     literal "// if we want to add hysteresis" TODO comment on this exact line -- it was never wired).
//     This disagrees with the correct, hysteresis-aware per-instance fallback
//     (getObjectLODIndexForDistance, used only when a leaf/ancestor box straddles a cutover and returns
//     null) for any instance whose real distance sits in the ~hysteresis-width band around a LOD cutover
//     (e.g. 12.32m-14m for D1=14/hys=0.12): which of the two code paths "wins" for that instance depends
//     on unpredictable BVH internal-node shape (refit/rotate from unrelated instances streaming in/out
//     elsewhere in the scene, or even camera-frustum-mask resolution order), not on real distance --
//     producing a genuine, reproducible per-frame LOD-bucket flip (mesh popping between the near/mid/far
//     tiers) for every instance near a cutover, independent of camera stillness. Root-caused live as the
//     mechanism behind "tree trunks flicker continuously when near" (D1=14m is exactly the near-tier cutoff).
//     Fix: shrink the distance threshold fed to the native BVH by the SAME per-level hysteresis fraction
//     getObjectLODIndexForDistance already applies, so the coarse box-level fast path and the precise
//     per-instance fallback always agree -- closing the disagreement band entirely, zero API change to
//     the vendored bvh.js package. ---
patch(
  'node_modules/@three.ez/instanced-mesh/build/index.js',
  'spoint patch] BVH LOD hysteresis',
  `    for (let a = 0; a < n.length; a++)
      s[a] = n[a].distance;`,
  `    // [spoint patch] BVH LOD hysteresis: shrink by the level's own hysteresis fraction (matches
    // getObjectLODIndexForDistance's levelDistance = distance - distance*hysteresis) so bvh.js's
    // internal-node showAll fast path (which has NO hysteresis of its own -- see its "if we want to
    // add hysteresis" TODO) can never disagree with the precise per-instance fallback near a cutover.
    for (let a = 0; a < n.length; a++)
      s[a] = n[a].distance - n[a].distance * n[a].hysteresis;`,
  'three.ez BVH LOD hysteresis (trunk-flicker root cause)'
)
