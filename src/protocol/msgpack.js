import { Packr } from '/spoint/node_modules/msgpackr/index.js'
const packr = new Packr({ useFloat32: 3, bundleStrings: true })
export const pack = packr.pack.bind(packr)
export const unpack = packr.unpack.bind(packr)
