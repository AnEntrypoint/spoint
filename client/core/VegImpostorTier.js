// Packs per-species octahedral impostor atlases into one shared mega atlas (atlas-of-atlases) so all species share one far-LOD material/draw. window.__vegImpostorAtlas exposes the packed result.
import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
// Single canonical impostor implementation, see AGENTS.md draw-call-audit-impostor-system-unification.
import { createOctahedralImpostorMaterial } from 'streaming-gltf/octahedral-impostor-ez'
import { dbg } from './debug-log.js'
import { get as _idbGet, put as _idbPut } from '../IndexedDBStore.js'

const _dbgImpostor = dbg('impostor')

// Half-width (metres) of the impostor's dither-discard dissolve band, centered on nearCutoff. Exported
// so callers (Vegetation.js) can align a mesh LOD's own swap-out distance to land inside this band
// instead of re-declaring the same literal.
export const IMPOSTOR_DISSOLVE_FADE_BAND_M = 3.0

// speciesAtlases: array of { albedo: THREE.Texture, normal?: THREE.Texture }. Returns mega textures + per-species tile mapping.
export function buildSharedImpostorAtlas(renderer, speciesAtlases, opts = {}) {
  const list = (speciesAtlases || []).filter(a => a && a.albedo)
  const n = list.length
  if (!renderer || n === 0) return null
  const atlasSize = opts.atlasSize || (list[0].albedo.image ? (list[0].albedo.image.width || 1024) : 1024)
  const gridSide = Math.max(1, Math.ceil(Math.sqrt(n)))
  const mega = atlasSize * gridSide
  const hasNormal = list.every(a => a.normal)

  const mkRT = () => {
    // Trilinear mipmapping required: unmipmapped far billboards alias/shimmer. Sprite tiles carry border padding so mip sampling never bleeds cross-tile.
    const rt = new THREE.WebGLRenderTarget(mega, mega, {
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, generateMipmaps: true,
    })
    rt.texture.anisotropy = 4
    try { renderer.initRenderTarget(rt) } catch (_) {}
    return rt
  }
  const albedoRT = mkRT()
  const normalRT = hasNormal ? mkRT() : null

  const _dst = new THREE.Vector2()
  const tiles = []
  let copied = 0
  // Dispose each source atlas immediately after copy (not at the end) — holding all N + the mega simultaneously OOM'd the tab previously.
  const disposeSource = opts.disposeSource !== false
  for (let i = 0; i < n; i++) {
    const col = i % gridSide, row = Math.floor(i / gridSide)
    _dst.set(col * atlasSize, row * atlasSize)
    try {
      renderer.copyTextureToTexture(list[i].albedo, albedoRT.texture, null, _dst)
      if (normalRT && list[i].normal) renderer.copyTextureToTexture(list[i].normal, normalRT.texture, null, _dst)
      copied++
    } catch (e) { console.warn('[vegImpostorTier] tile copy failed:', i, e?.message || e) }
    if (disposeSource) {
      try { list[i].albedo && list[i].albedo.dispose && list[i].albedo.dispose() } catch (e) { _dbgImpostor('source albedo dispose failed:', i, e?.message || e) }
      try { list[i].normal && list[i].normal.dispose && list[i].normal.dispose() } catch (e) { _dbgImpostor('source normal dispose failed:', i, e?.message || e) }
    }
    tiles.push({ species: i, col, row, offset: [col / gridSide, row / gridSide] })
  }

  // Must regenerate mips after tile copies: copyTextureToTexture only writes mip level 0, leaving the mip pyramid stale and far trees would vanish (empty coarse mips).
  const _regenMips = (rt) => {
    if (!rt) return
    try {
      const gl = renderer.getContext()
      const props = renderer.properties.get(rt.texture)
      const tex = props && props.__webglTexture
      if (gl && tex) { gl.bindTexture(gl.TEXTURE_2D, tex); gl.generateMipmap(gl.TEXTURE_2D) }
    } catch (e) { console.warn('[vegImpostorTier] mip regen failed (level-0 only):', e?.message || e) }
  }
  _regenMips(albedoRT)
  _regenMips(normalRT)

  const result = {
    albedo: albedoRT.texture, normal: normalRT ? normalRT.texture : null,
    albedoRT, normalRT, tileScale: 1 / gridSide, gridSide, atlasSize, mega, tiles, copied,
    dispose() { try { albedoRT.dispose() } catch (e) { _dbgImpostor('albedoRT dispose failed:', e?.message || e) } try { normalRT && normalRT.dispose() } catch (e) { _dbgImpostor('normalRT dispose failed:', e?.message || e) } },
    megaBytes: mega * mega * 4 * (normalRT ? 2 : 1),
    perSpeciesBytes: n * atlasSize * atlasSize * 4 * (hasNormal ? 2 : 1),
  }
  if (typeof window !== 'undefined') window.__vegImpostorAtlas = result
  return result
}

// One shared cross-species impostor mesh: a single InstancedMesh2 sampling the mega atlas via per-instance atlasTile. dims = per-species {center:[x,y,z], radius}.
export function createSharedImpostorMesh(renderer, atlas, dims, opts = {}) {
  if (!renderer || !atlas) return null
  const capacity = Math.min(opts.maxInstances || 20000, opts.initCapacity || 4096)
  const mat = createOctahedralImpostorMaterial({
    albedo: atlas.albedo, normalDepth: atlas.normal,
    useHemiOctahedron: false, spritesPerSide: opts.spritesPerSide || 8,
    transparent: false, alphaClamp: opts.alphaClamp ?? 0.4,
    transform: new THREE.Matrix4(),                 // identity: instance matrix carries the transform
    atlasTile: true, atlasGridSide: atlas.gridSide, renderer,
    farSingleSprite: opts.farSingleSprite !== false,
    // Parallax-corrected impostors (opt-in, default off -- see EZ_PARALLAX in octahedral-impostor-ez.js
    // and the RenderControls vegImpostorParallax/vegImpostorParallaxScale knobs Vegetation.js reads
    // this from). Depth-offset UV sampling using the normalDepth atlas's existing packed depth channel
    // so a close-range impostor shows real per-fragment relief instead of a flat billboard look.
    parallax: opts.parallax === true, parallaxScale: opts.parallaxScale ?? 0.3,
  })
  // POLYGON-OFFSET (impostor-depth-flicker fix): this billboard's own depth-test has NO occlusion-system
  // backstop (see Vegetation.js's applyOcclusion comment -- it relies solely on the raw GPU z-test against
  // mapspinner's terrain depth-writeback). The tree's base sits exactly AT the terrain height sampled from
  // the finest-LOD-density GPU patch bake (patch-baker.js), while the actually-RENDERED terrain surface
  // under it at impostor range is a much coarser LOD mesh (linear-interpolated between sparser vertices) --
  // so the true fine-grained placement height and the coarse rendered surface height disagree by a few cm
  // to a few dm, flipping sign with camera angle/LOD-tile selection as the player moves. That flips which
  // side of the z-test wins every few frames -> "impostors appear and disappear like there's depth error"
  // (verbatim user report). A flat NDC depth-writeback bias (window.__planetDepthBias) undercorrects at
  // range because depth-buffer precision is nonlinear in eye-space distance; the standard GPU-correct fix
  // for near-coplanar surfaces is polygon offset (biases depth in resolution-relative units, not a fixed
  // NDC constant). The impostor plane is camera-facing (near-zero depth slope across the quad), so only
  // the constant `units` term matters; a small negative bias (pulls the impostor toward the camera in
  // depth) makes it reliably win ties against the terrain it's standing on, without visibly detaching it
  // from the ground (a few depth-buffer ULPs, not a world-space offset).
  mat.polygonOffset = true
  mat.polygonOffsetFactor = -4
  mat.polygonOffsetUnits = -8
  // Base geo must be zero-area below nearCutoff (near trees draw the full branch mesh instead) or every near tree double-draws; plane is the far LOD.
  const nearCutoff = opts.nearCutoff
  if (Number.isFinite(nearCutoff) && nearCutoff > 0) {
    const baseCompile = mat.onBeforeCompile
    mat.onBeforeCompile = (shader, r) => {
      baseCompile?.call(mat, shader, r)
      shader.uniforms.uImpNearCutoff = { value: nearCutoff }
      shader.vertexShader = 'uniform float uImpNearCutoff;\nvarying float vImpCamDist;\n' + shader.vertexShader
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvImpCamDist = distance(cameraPosition, (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz);')
      shader.fragmentShader = 'uniform float uImpNearCutoff;\nvarying float vImpCamDist;\n' + shader.fragmentShader
      // ONE-SIDED ramp (tree-lod-impostor-fade-overlap-gap, 2026-08-24), not the old symmetric
      // abs(dist-nearCutoff)/band V-shape: the addLOD boundary at nearCutoff swaps THIS material's
      // active geometry from the zero-area near-LOD (dist<nearCutoff, draws nothing regardless of
      // _impFade) to the real billboard plane (dist>=nearCutoff) -- so the only geometry this
      // discard ever gates is the plane, active only for dist>=nearCutoff. The old V-shape evaluated
      // to 0 (near-fully-discarded) exactly AT nearCutoff, the plane's own engage point, and only
      // climbed back to 1 approaching nearCutoff+band -- so the impostor was its LEAST visible right
      // where the mesh LOD (FAR_LOD_SWAP, Vegetation.js) had already gone empty, a real dead zone
      // live-witnessed as trees fading to near-nothing at the mesh/impostor handoff. A one-sided ramp
      // spanning [nearCutoff-band, nearCutoff] instead reaches full opacity BY the time the plane
      // geometry engages (dist>=nearCutoff clamps this to 1 for the plane's entire active range) --
      // matching what FAR_LOD_SWAP = nearCutoff-band already assumed the shape to be.
      shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>',
        '#include <dithering_fragment>\n' +
        `float _impFade = clamp((vImpCamDist - (uImpNearCutoff - ${IMPOSTOR_DISSOLVE_FADE_BAND_M.toFixed(1)})) / ${IMPOSTOR_DISSOLVE_FADE_BAND_M.toFixed(1)}, 0.0, 1.0);\n` +
        'float _impDither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));\n' +
        'if (_impDither > _impFade) discard;')
    }
    const baseKey = mat.customProgramCacheKey
    mat.customProgramCacheKey = () => baseKey() + '_impfade'
  }
  let baseGeo
  if (Number.isFinite(nearCutoff) && nearCutoff > 0) {
    baseGeo = new THREE.BufferGeometry()
    baseGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3))
    baseGeo.setIndex([0, 1, 2])
  } else {
    baseGeo = new THREE.PlaneGeometry(1, 1)
  }
  // Must stamp a generous unit bounding sphere (radius 1.0) AND a matching non-degenerate bounding box on every
  // geo: PlaneGeometry's auto sphere / the zero-area geo's sphere is too small, causing on-screen billboards to
  // pop out at the frustum edge. The zero-area near-LOD geo (a single degenerate point-triangle, all-zero
  // positions) computes a boundingBox of min=max=[0,0,0] -- @three.ez's computeBVH() builds each instance's BVH
  // leaf from geometry.boundingBox (not boundingSphere), so a zero-volume box collapses EVERY instance's leaf to
  // a single point and the BVH either fails to build a root or never intersects the camera frustum, silently
  // culling 100% of instances regardless of true position (computeBVH throws no error; shared.bvh.root stays
  // falsy and InstancedMesh2's own .count -- the real per-frame drawn-instance count -- stays 0 forever, even
  // though .instancesCount reports every instance as loaded). Stamping boundingBox to the same generous +/-1
  // unit cube the sphere already promises gives the BVH real volume to build from.
  const _cullSphere = (g) => {
    g.computeBoundingSphere(); if (!g.boundingSphere) g.boundingSphere = new THREE.Sphere()
    g.boundingSphere.center.set(0, 0, 0); g.boundingSphere.radius = 1.0
    if (!g.boundingBox) g.boundingBox = new THREE.Box3()
    g.boundingBox.min.set(-1, -1, -1); g.boundingBox.max.set(1, 1, 1)
    return g
  }
  _cullSphere(baseGeo)
  const im = new InstancedMesh2(baseGeo, mat, { capacity, renderer })
  im.initUniformsPerInstance({ fragment: { atlasTile: 'float' } })
  im.perObjectFrustumCulled = true
  im.frustumCulled = false
  if (Number.isFinite(nearCutoff) && nearCutoff > 0) {
    // hysteresis prevents flicker when a tree hovers exactly at nearCutoff
    const hys = Number.isFinite(opts.lodHysteresis) ? opts.lodHysteresis : 0.12
    try { im.addLOD(_cullSphere(new THREE.PlaneGeometry(1, 1)), mat, nearCutoff, hys) } catch (_) {}
  }
  const _c = new THREE.Vector3()
  function addImpostor(species, baseX, baseY, baseZ) {
    const d = dims[species] || { center: [0, 1, 0], radius: 1 }
    const sz = d.radius * 2
    let id = -1
    im.addInstances(1, (e) => {
      e.position.set(baseX + d.center[0], baseY + d.center[1], baseZ + d.center[2])
      e.scale.setScalar(sz); id = e.id
    })
    try { im.setUniformAt(id, 'atlasTile', species) } catch (_) {}
    return id
  }
  // Batched: one addInstances call amortizes InstancedMesh2 per-call overhead across the chunk.
  // cands is either [{species,x,y,z},...] or -- when `speciesOverride` is a number -- any array of
  // {x,y,z} records (Vegetation.js passes its per-species placement bucket directly, so no per-chunk
  // `bucket.map(...)` temp array is allocated just to tag every entry with the same species index).
  function addImpostors(cands, speciesOverride) {
    const n = cands.length
    if (n === 0) return []
    const ids = new Array(n)
    const fixed = Number.isFinite(speciesOverride)
    let bi = 0
    im.addInstances(n, (e) => {
      const c = cands[bi]
      const sp = fixed ? speciesOverride : c.species
      const d = dims[sp] || { center: [0, 1, 0], radius: 1 }
      const sz = d.radius * 2
      e.position.set(c.x + d.center[0], c.y + d.center[1], c.z + d.center[2])
      e.scale.setScalar(sz)
      ids[bi] = e.id
      bi++
    })
    for (let i = 0; i < n; i++) { try { im.setUniformAt(ids[i], 'atlasTile', fixed ? speciesOverride : cands[i].species) } catch (_) {} }
    return ids
  }
  function removeImpostor(id) { try { im.removeInstances(id) } catch (_) {} }
  // Batched removal: ONE variadic removeInstances call per chunk (its trailing _instancesArrayCount trim
  // runs once, not once per instance).
  function removeImpostors(ids) { if (ids.length) { try { im.removeInstances(...ids) } catch (_) {} } }
  return { mesh: im, material: mat, addImpostor, addImpostors, removeImpostor, removeImpostors, get count() { return im.instancesCount || 0 } }
}

// ---- Boot-time impostor mega-atlas persistence (IndexedDB) -------------------------------------------
// The per-species octahedral bakes (15 species x 64 sprites x 2 targets at 1024^2) + the mega-atlas pack
// are pure functions of (species list, per-species tree bounding sphere, atlas/sprite parameters, GPU
// driver). On a repeat visit the packed mega atlas is loaded straight from IndexedDB as two DataTextures
// carrying the SAME level-0 bytes the render targets held (readRenderTargetPixels readback of the
// packed RTs, same RGBA8 layout, same sampler state, mips regenerated by the same driver call) -- so the
// far-LOD trees sample identical texels and the whole bake is skipped. Any failure (quota, corrupt
// record, key mismatch) falls through to the normal bake; nothing here can leave the impostor tier
// missing. Key = version + species + rounded per-species dims (a fingerprint of the tree geometry: any
// preset/scale change moves the bounding sphere) + atlas params + the GL renderer string (bytes are only
// reusable on the driver that produced them).
export const IMPOSTOR_ATLAS_CACHE_VERSION = 1
const _ATLAS_DB = 'spoint-veg-impostor', _ATLAS_DB_VER = 1, _ATLAS_STORE = 'atlas'

export function impostorAtlasCacheKey(renderer, speciesNames, dims, params) {
  let glId = ''
  try { const gl = renderer.getContext(); glId = String(gl.getParameter(gl.RENDERER)) + '|' + String(gl.getParameter(gl.VERSION)) } catch (_) {}
  const d = dims.map(x => [x.center[0].toFixed(3), x.center[1].toFixed(3), x.center[2].toFixed(3), x.radius.toFixed(3)].join(','))
  return JSON.stringify({ v: IMPOSTOR_ATLAS_CACHE_VERSION, species: speciesNames, dims: d, ...params, gl: glId })
}

export async function loadCachedImpostorAtlas(key) {
  try {
    const rec = await _idbGet(_ATLAS_DB, _ATLAS_DB_VER, _ATLAS_STORE, key)
    if (!rec || !rec.albedo || !Number.isFinite(rec.mega) || rec.albedo.byteLength !== rec.mega * rec.mega * 4) return null
    if (rec.normal && rec.normal.byteLength !== rec.mega * rec.mega * 4) return null
    return rec
  } catch (_) { return null }
}

// Reads the packed RTs back (level 0, RGBA8) and stores them. Fire-and-forget; only stores when the
// browser reports enough quota headroom (3x the payload) so a near-full origin never wedges on the write.
export async function storeCachedImpostorAtlas(renderer, atlas, key) {
  try {
    const mega = atlas.mega
    const bytes = mega * mega * 4
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate()
      if (Number.isFinite(est.quota) && Number.isFinite(est.usage) && (est.quota - est.usage) < bytes * (atlas.normalRT ? 2 : 1) * 3) return false
    }
    const albedo = new Uint8Array(bytes)
    renderer.readRenderTargetPixels(atlas.albedoRT, 0, 0, mega, mega, albedo)
    let normal = null
    if (atlas.normalRT) { normal = new Uint8Array(bytes); renderer.readRenderTargetPixels(atlas.normalRT, 0, 0, mega, mega, normal) }
    await _idbPut(_ATLAS_DB, _ATLAS_DB_VER, _ATLAS_STORE, key, { albedo: albedo.buffer, normal: normal ? normal.buffer : null, mega, gridSide: atlas.gridSide, atlasSize: atlas.atlasSize, tiles: atlas.tiles, createdAt: Date.now() })
    return true
  } catch (e) { _dbgImpostor('atlas cache store failed:', e?.message || e); return false }
}

// Builds the same atlas record shape buildSharedImpostorAtlas returns, from cached bytes. Sampler
// state mirrors mkRT above exactly (trilinear, clamp, anisotropy 4, RGBA8, NoColorSpace, no flip).
export function createAtlasFromCache(rec) {
  const mkTex = (buf) => {
    const t = new THREE.DataTexture(new Uint8Array(buf), rec.mega, rec.mega, THREE.RGBAFormat, THREE.UnsignedByteType)
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter
    t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping
    t.generateMipmaps = true; t.anisotropy = 4; t.flipY = false; t.needsUpdate = true
    return t
  }
  const albedo = mkTex(rec.albedo), normal = rec.normal ? mkTex(rec.normal) : null
  const result = {
    albedo, normal, albedoRT: null, normalRT: null, tileScale: 1 / rec.gridSide, gridSide: rec.gridSide, atlasSize: rec.atlasSize, mega: rec.mega, tiles: rec.tiles, copied: rec.tiles.length,
    fromCache: true,
    dispose() { try { albedo.dispose() } catch (_) {} try { normal && normal.dispose() } catch (_) {} },
    megaBytes: rec.mega * rec.mega * 4 * (normal ? 2 : 1), perSpeciesBytes: 0,
  }
  if (typeof window !== 'undefined') window.__vegImpostorAtlas = result
  return result
}
