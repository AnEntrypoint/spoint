import { Extension } from '@gltf-transform/core'

function makeVrmPassthroughExtension(extensionName) {
  return class VrmPassthroughExtension extends Extension {
    static EXTENSION_NAME = extensionName
    extensionName = extensionName

    read(context) {
      const extensionDef = context.jsonDoc.json.extensions?.[extensionName]
      if (extensionDef === undefined) return this
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

export const VRM0Passthrough = makeVrmPassthroughExtension('VRM')
export const VRMCVrmPassthrough = makeVrmPassthroughExtension('VRMC_vrm')
