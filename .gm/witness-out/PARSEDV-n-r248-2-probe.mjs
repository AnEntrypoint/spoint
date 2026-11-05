import { sampleMinimapCell, reliefShade, shadeHeightGrid } from '/workspace/spoint/src/shared/MinimapBiome.js'
const frame = { groundHeightLocal: () => NaN, localToDir: () => [0, 1, 0] }
const out = [9, 9, 9, 9, 9]
const r = sampleMinimapCell(frame, null, 1, 2, out, 0)
const heights = new Float64Array([0, 1, NaN, 3])
const shade = new Float64Array(4)
const rgbIn = new Float64Array([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100])
const rgbOut = new Float64Array(12)
shadeHeightGrid(heights, 2, 2, 1, new Uint8Array([1, 1, 1, 1]), rgbIn, rgbOut, 3, 3, shade)
console.log(JSON.stringify({ sampleMinimapCell_returned: r, out, reliefShade_flat: reliefShade(0, 0), shadeGrid_withNaNNeighbour: Array.from(shade) }))
