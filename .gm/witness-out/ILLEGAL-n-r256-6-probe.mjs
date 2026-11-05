const { SNAPSHOT_ENCODE_CODE_VERSION } = await import('/workspace/spoint/src/shared/cacheCodeVersions.js')
const { SNAPSHOT_ENCODE_CODE_VERSION_SOURCE, BAKE_INPUTS_SNAPSHOT_ENCODE } = await import('/workspace/spoint/src/static/BakeCodeVersion.js')
console.log(JSON.stringify({ pin: SNAPSHOT_ENCODE_CODE_VERSION, sourceHash: SNAPSHOT_ENCODE_CODE_VERSION_SOURCE, match: SNAPSHOT_ENCODE_CODE_VERSION === SNAPSHOT_ENCODE_CODE_VERSION_SOURCE, inputs: BAKE_INPUTS_SNAPSHOT_ENCODE }))
