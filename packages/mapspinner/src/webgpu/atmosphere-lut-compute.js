export function supportsAtmosphereLutWebGPU(device) {
  return !!device && typeof device.createTexture === 'function' && typeof device.queue?.writeTexture === 'function' && typeof device.queue?.submit === 'function'
}

export function atmosphereLutFloat32FilterOK(device) {
  return !!(device && device.features && device.features.has('float32-filterable'))
}

function packTransmittanceRGBA(data, width, height) {
  const rgba = new Float32Array(width * height * 4)
  for (let i = 0, n = width * height; i < n; i++) {
    rgba[i * 4] = data[i * 3]
    rgba[i * 4 + 1] = data[i * 3 + 1]
    rgba[i * 4 + 2] = data[i * 3 + 2]
    rgba[i * 4 + 3] = 1
  }
  return rgba
}

export function createTransmittanceLutTexture(device, { data, width, height }) {
  if (!(data instanceof Float32Array)) throw new TypeError('createTransmittanceLutTexture: data must be a Float32Array')
  const rgba = packTransmittanceRGBA(data, width, height)
  const texture = device.createTexture({
    label: 'mapspinner-atm-transmittance-lut',
    size: { width, height, depthOrArrayLayers: 1 },
    format: 'rgba32float',
    dimension: '2d',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
  })
  device.queue.writeTexture(
    { texture },
    rgba,
    { bytesPerRow: width * 16, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  )
  return texture
}

export function createScatteringLutTexture(device, { data, width, height, layers }) {
  if (!(data instanceof Float32Array)) throw new TypeError('createScatteringLutTexture: data must be a Float32Array')
  const texture = device.createTexture({
    label: 'mapspinner-atm-scattering-lut',
    size: { width, height, depthOrArrayLayers: layers },
    format: 'rgba32float',
    dimension: '2d',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
  })
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: width * 16, rowsPerImage: height },
    { width, height, depthOrArrayLayers: layers },
  )
  return texture
}

function samplerDescriptorFor(device) {
  const linear = atmosphereLutFloat32FilterOK(device)
  return {
    label: 'mapspinner-atm-lut-sampler',
    magFilter: linear ? 'linear' : 'nearest',
    minFilter: linear ? 'linear' : 'nearest',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
  }
}

export function createAtmosphereLutSampler(device) {
  return device.createSampler(samplerDescriptorFor(device))
}

export async function readBackLutTextureF32(device, texture, width, height, depthOrArrayLayers) {
  const unpaddedBytesPerRow = width * 16
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256
  const bufferSize = bytesPerRow * height * depthOrArrayLayers
  const readBuf = device.createBuffer({
    label: 'mapspinner-atm-lut-readback',
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const encoder = device.createCommandEncoder({ label: 'mapspinner-atm-lut-readback-encoder' })
  encoder.copyTextureToBuffer(
    { texture },
    { buffer: readBuf, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers },
  )
  device.queue.submit([encoder.finish()])
  await readBuf.mapAsync(GPUMapMode.READ)
  const mapped = new Float32Array(readBuf.getMappedRange().slice(0))
  readBuf.unmap()
  readBuf.destroy()
  if (bytesPerRow === unpaddedBytesPerRow) return mapped
  const rowFloats = width * 4
  const strideFloats = bytesPerRow / 4
  const out = new Float32Array(width * height * depthOrArrayLayers * 4)
  for (let layer = 0; layer < depthOrArrayLayers; layer++) {
    for (let y = 0; y < height; y++) {
      const srcOff = layer * strideFloats * height + y * strideFloats
      const dstOff = (layer * height + y) * rowFloats
      out.set(mapped.subarray(srcOff, srcOff + rowFloats), dstOff)
    }
  }
  return out
}

export function unpackTransmittanceRGBA(rgba, width, height) {
  const rgb = new Float32Array(width * height * 3)
  for (let i = 0, n = width * height; i < n; i++) {
    rgb[i * 3] = rgba[i * 4]
    rgb[i * 3 + 1] = rgba[i * 4 + 1]
    rgb[i * 3 + 2] = rgba[i * 4 + 2]
  }
  return rgb
}
