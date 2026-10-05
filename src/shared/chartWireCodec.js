const CHART_FLOATS = 12
const FLOAT_BYTES = 8
export const CHART_WIRE_BYTES = CHART_FLOATS * FLOAT_BYTES

export function encodeChart(chart) {
  const bytes = new Uint8Array(CHART_WIRE_BYTES)
  const view = new DataView(bytes.buffer)
  const values = [chart.radius, chart.offsetY, chart.anchorHeight, ...chart.east, ...chart.up, ...chart.north]
  for (let i = 0; i < CHART_FLOATS; i++) view.setFloat64(i * FLOAT_BYTES, values[i], true)
  return { e: chart.chartEpoch, d: bytes }
}

export function decodeChart(wire) {
  if (!wire || !Number.isInteger(wire.e) || !(wire.d instanceof Uint8Array) || wire.d.byteLength !== CHART_WIRE_BYTES) {
    throw new Error(`chart wire form needs an integer epoch and ${CHART_WIRE_BYTES} bytes of float64, got ${JSON.stringify(wire && { e: wire.e, bytes: wire.d?.byteLength })}`)
  }
  const view = new DataView(wire.d.buffer, wire.d.byteOffset, wire.d.byteLength)
  const v = i => view.getFloat64(i * FLOAT_BYTES, true)
  for (let i = 0; i < CHART_FLOATS; i++) if (!Number.isFinite(v(i))) throw new Error(`chart wire form float ${i} is not finite`)
  return {
    radius: v(0), offsetY: v(1), anchorHeight: v(2), chartEpoch: wire.e,
    east: [v(3), v(4), v(5)], up: [v(6), v(7), v(8)], north: [v(9), v(10), v(11)]
  }
}
