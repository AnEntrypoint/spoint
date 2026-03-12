import { Packr } from 'msgpackr'
const packr = new Packr({ useFloat32: 3, bundleStrings: true })
export const pack = packr.pack.bind(packr)
export const unpack = packr.unpack.bind(packr)
