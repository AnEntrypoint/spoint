# EP_progressive_lod

## Contributors

- lanmower (https://github.com/lanmower)

## Status

Draft. This extension is **not yet registered** with the Khronos glTF extension
registry. The vendor prefix `EP` must be reserved via a pull request to
[KhronosGroup/glTF](https://github.com/KhronosGroup/glTF) before this can be
considered an official extension; until then the name is provisional and the
extension MUST be treated as vendor-private.

## Dependencies

Written against the glTF 2.0 specification.

## Overview

`EP_progressive_lod` declares a set of progressively-refinable level-of-detail
(LOD) representations for the meshes and textures of a glTF asset, so a client
can render a coarse representation immediately and refine it lazily as bandwidth
and on-screen size warrant — without downloading the full-detail asset up front.

The base glTF (the LOD that the standard `meshes`/`images`/`accessors` arrays
describe) is always the **coarsest** representation. A conforming client that
does not implement this extension ignores the extension object entirely and
renders that coarse base LOD — so the extension is purely additive and is
declared in `extensionsUsed`, never `extensionsRequired`.

Higher-detail LODs are addressed in one of two storage modes:

- **`sibling-file`** — each higher LOD lives in a separate sibling file
  (`path` relative to the root asset). The client fetches a sibling only when it
  decides to refine. This is the mode produced by `tools/bake-progressive.mjs`.
- **`single-glb-range`** — every LOD is packed into the single GLB's one BIN
  chunk as independent `bufferView` byte ranges. The client issues HTTP `Range`
  requests for only the byte ranges of the LOD it needs. This is the mode
  produced by `tools/bake-streaming.mjs`.

The `storage` field on the extension object discriminates the two.

## glTF Schema Updates

The extension is added to the top-level (document root) `extensions` object:

```json
{
  "extensionsUsed": ["EP_progressive_lod"],
  "extensions": {
    "EP_progressive_lod": {
      "version": 1,
      "storage": "sibling-file",
      "meshes": [
        {
          "meshIndex": 0,
          "primIndex": 0,
          "lods": [
            { "ratio": 0.04, "kind": "textured", "inline": true,  "indexCount": 312 },
            { "ratio": 0.15, "kind": "textured", "inline": false, "path": "lod_2.glb",  "indexCount": 1180, "bytes": 24010, "decodeAABB": null },
            { "ratio": 1.0,  "kind": "textured", "inline": false, "path": "lod_0.glb",  "indexCount": 7800, "bytes": 161200, "decodeAABB": null }
          ]
        }
      ],
      "textures": [
        {
          "textureIndex": 0,
          "name": "albedo",
          "lods": [
            { "width": 128,  "inline": true,  "bytes": 3100 },
            { "width": 512,  "inline": false, "path": "tex0_512.webp",  "bytes": 22000 },
            { "width": 2048, "inline": false, "path": "tex0_2048.webp", "bytes": 210000 }
          ]
        }
      ]
    }
  }
}
```

For `storage: "single-glb-range"`, each LOD entry carries `bufferView` (and the
mirrored `byteOffset` / `byteLength`) instead of `path`, and `inline` is absent;
texture LODs carry `mime`. See `schema/` for the authoritative shape.

### Property reference

| Property      | Description                                                        | Required |
|---------------|--------------------------------------------------------------------|----------|
| `version`     | Payload version integer.                                           | yes      |
| `storage`     | `"sibling-file"` or `"single-glb-range"`.                          | yes      |
| `meshes`      | Per-primitive LOD descriptors.                                     | yes      |
| `textures`    | Per-texture LOD descriptors.                                       | no       |

Each `meshes[i].lods[j]` entry: `ratio` (decimation ratio vs the source mesh, in
`(0,1]`), `kind` (`"unskinned"` | `"vertcolor"` | `"textured"`), and — by
storage mode — either `inline`+`path` (sibling-file) or `bufferView` (range).
`indexCount`, `vertexCount`, `bytes`, and `decodeAABB` (a `[min,max]` AABB used
to dequantize position attributes back to mesh-local space) are optional hints.

## Known Implementations

- Reference baker: `tools/bake-progressive.mjs` (sibling-file),
  `tools/bake-streaming.mjs` (single-glb-range).
- Reference runtime: `examples/local-progressive/model-pool.js` (three.js).
- Conformance validator: `tools/validate-extension.mjs`.

## Resources

- glTF 2.0 specification: https://registry.khronos.org/glTF/
- Extension authoring guidelines:
  https://github.com/KhronosGroup/glTF/tree/main/extensions
