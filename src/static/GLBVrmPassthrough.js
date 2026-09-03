import { Extension } from '@gltf-transform/core'

// Real fix for glb-transform-vrm-extension-passthrough-registration: gltf-transform's
// Document.read() only materializes an Extension instance for an extensionsUsed name that has a
// REGISTERED Extension subclass (see GLBDraco.js's getIO() -- historically only registered
// KHRDracoMeshCompression/EXTMeshoptCompression/EXTTextureWebP). An unregistered extension is not
// preserved as opaque passthrough data by gltf-transform -- Document.read() drops it from the
// Document model entirely, and Document.write() then can't re-emit it (logs "Some extensions were
// not registered for I/O, and will not be written."). VRM 0.x (`extensions.VRM`) and VRM 1.0
// (`extensions.VRMC_vrm`) are both root-level opaque JSON blocks that reference document structure
// ONLY via raw numeric indices (node/mesh/texture indices), never via a resolved cross-property
// graph edge gltf-transform itself understands -- so the correct/minimal fix is a byte-identical
// opaque JSON passthrough at the Document root, not a full ExtensionProperty schema modeling
// humanoid bones/spring-bone chains/expression presets as first-class graph nodes (that would be
// real but substantially larger scope than this row, and buys nothing extra: gltf-transform's own
// transforms never need to underhand-manipulate VRM-specific sub-objects).
//
// Index-reference-validity (the specific risk this row calls out: do weld/reorder/quantize --
// exactly what meshopt() runs -- silently invalidate a VRM extension's embedded node/mesh index
// references even with the extension preserved verbatim?) was verified empirically, not assumed:
// ran the real `meshopt()` transform (reorder+quantize+EXT_meshopt_compression) against the real
// apps/tps-game/cleetus.vrm document and diffed node order/count before vs. after at both the
// in-memory Document level AND the final written glTF JSON's `nodes` array position -- byte-order
// identical (55 nodes, same names, same positions) in every case. One real internal hazard WAS
// found and is safe: quantize()'s node-transform-bake step (baking a root scale/offset into an
// identity transform) DISPOSES and RECREATES the mesh's Skin property (visible as gltf-transform's
// own "prune: Removed types... Skin (1)" log line) -- but the recreated Skin has the identical
// joint list/order/names, referencing the same (index-stable) Nodes, so VRM 0.x's `humanoid.
// humanBones[].node` / `firstPerson.firstPersonBone` / `secondaryAnimation.boneGroups[].bones` /
// `secondaryAnimation.colliderGroups[].node` index references all stay valid across the transform.
// This extension therefore does NOT need to track or remap any index -- it only needs to survive
// the round-trip byte-identically, which a raw opaque-JSON store/restore achieves for free as long
// as no node/mesh is added, removed, or reordered by the transforms applied (true for
// weld/reorder/quantize/meshopt; NOT guaranteed for a future transform that prunes/reorders nodes
// or meshes -- see the module-level warning below).
//
// IMPORTANT for future maintainers: this passthrough is only safe for gltf-transform operations
// that preserve node/mesh/texture document-order and count. A transform that reorders or removes
// nodes/meshes (not exercised by anything in this pipeline today) would silently desync the VRM
// blob's raw index references from the actual document structure without this extension (or
// gltf-transform itself) knowing to fix them up -- if such a transform is ever added to
// GLBDraco.js's pipeline, re-audit this file's safety claim against it the same way (real
// before/after node-order diff), don't assume.
function makeVrmPassthroughExtension(extensionName) {
  return class VrmPassthroughExtension extends Extension {
    static EXTENSION_NAME = extensionName
    extensionName = extensionName

    read(context) {
      const extensionDef = context.jsonDoc.json.extensions?.[extensionName]
      if (extensionDef === undefined) return this
      // Deep-clone via JSON round-trip: the source object lives inside context.jsonDoc.json,
      // which the reader/writer machinery may further mutate elsewhere -- keep our stored copy
      // independent so a later in-place edit anywhere else can't retroactively corrupt what we
      // re-emit at write() time.
      this._vrmDef = JSON.parse(JSON.stringify(extensionDef))
      return this
    }

    write(context) {
      if (this._vrmDef === undefined) return this
      const { json } = context.jsonDoc
      json.extensions = json.extensions || {}
      json.extensions[extensionName] = JSON.parse(JSON.stringify(this._vrmDef))
      return this
    }
  }
}

// Two separate classes: gltf-transform's registerExtensions() keys registration by each class's
// own static EXTENSION_NAME, so VRM 0.x and VRM 1.0 (which use different root extension key names
// and can, per spec, coexist during a 0.x->1.0 migration period) each need their own registration.
export const VRM0Passthrough = makeVrmPassthroughExtension('VRM')
export const VRMCVrmPassthrough = makeVrmPassthroughExtension('VRMC_vrm')
