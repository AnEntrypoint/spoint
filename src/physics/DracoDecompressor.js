let _dracoDecoderPromise = null

export async function getDracoDecoder() {
  if (!_dracoDecoderPromise) {
    try {
      // Specifier built at runtime, not a bare literal import() -- draco3dgltf's own bundled
      // Emscripten glue has unconditional top-level `require('fs')`/`require('path')` calls (no
      // edge/browser fallback in the package itself, unlike jolt-physics/mapspinner/xstate/msgpackr
      // which this session fixed the SAME class of build-time-static-resolution problem for), so a
      // bundler-based edge/DO build target fails outright trying to statically resolve+bundle it --
      // live-reproduced via a real `wrangler dev`/`wrangler deploy --dry-run` build against
      // WorkerEntry.js's real dependency graph (this file is reached transitively via GLBLoader.js,
      // used by World.js's GLB-based collider path). Draco-compressed GLB colliders are NOT yet
      // edge-safe (see sibling PRD row edge-cf-draco-glb-collider-not-yet-edge-safe) -- this fix only
      // makes the BUILD succeed for a world that never actually calls this function (any world using
      // plain primitive colliders, like apps/world/e2e-ci-arena.js), matching this row's own scoped
      // minimal-slice world. Runtime behavior for every existing Node caller is unchanged: same
      // real 'draco3dgltf' package, same resolution.
      // A plain string-concat literal (e.g. 'draco3d'+'gltf') is STILL constant-folded by esbuild back
      // to a literal specifier and still breaks an edge/DO build -- confirmed live. A specifier built
      // inside a wrapping function call is what actually defeats esbuild's static resolution (same
      // fix as EditorHandlers.js's ServerAPI.js import, same session).
      const _dracoSpec = (() => 'draco3d' + 'gltf')()
      const dracoGltf = await import(_dracoSpec)
      _dracoDecoderPromise = dracoGltf.createDecoderModule()
    } catch(e) {
      throw new Error(`Failed to load Draco decoder: ${e.message}`)
    }
  }
  return _dracoDecoderPromise
}

export async function decompressDracoMesh(buf, json, prim, binOffset, meshName) {
  const decoder = await getDracoDecoder()

  const dracoExt = prim.extensions.KHR_draco_mesh_compression
  const bufView = json.bufferViews[dracoExt.bufferView]
  const offset = binOffset + (bufView.byteOffset || 0)
  const dracoData = buf.slice(offset, offset + bufView.byteLength)

  const d = new decoder.Decoder()
  const db = new decoder.DecoderBuffer()
  const decodedGeom = new decoder.Mesh()

  try {
    const dracoArray = new Uint8Array(dracoData)
    db.Init(dracoArray, dracoArray.length)

    const status = d.DecodeBufferToMesh(db, decodedGeom)
    if (!status.ok()) throw new Error(`Draco decompression failed: ${status.error_msg()}`)

    const posAttrId = d.GetAttributeId(decodedGeom, decoder.POSITION)
    if (posAttrId < 0) throw new Error('No POSITION attribute in decompressed mesh')

    const posAttr = d.GetAttribute(decodedGeom, posAttrId)
    const numPoints = decodedGeom.num_points()
    const posData = new decoder.DracoFloat32Array()
    d.GetAttributeFloatForAllPoints(decodedGeom, posAttr, posData)

    const vertices = new Float32Array(numPoints * 3)
    for (let i = 0; i < numPoints * 3; i++) vertices[i] = posData.GetValue(i)

    let indices = null
    const numFaces = decodedGeom.num_faces()
    if (numFaces > 0) {
      indices = new Uint32Array(numFaces * 3)
      const faceIndices = new decoder.DracoUInt32Array()
      for (let i = 0; i < numFaces; i++) {
        d.GetFaceFromMesh(decodedGeom, i, faceIndices)
        indices[i * 3] = faceIndices.GetValue(0)
        indices[i * 3 + 1] = faceIndices.GetValue(1)
        indices[i * 3 + 2] = faceIndices.GetValue(2)
      }
      decoder.destroy(faceIndices)
    }

    decoder.destroy(posData)
    decoder.destroy(status)

    return { vertices, indices, vertexCount: numPoints, triangleCount: numFaces, name: meshName }
  } finally {
    decoder.destroy(decodedGeom)
    decoder.destroy(d)
    decoder.destroy(db)
  }
}
