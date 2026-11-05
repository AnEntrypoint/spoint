import { createFbm2D } from './NoiseTerrain.js'

const isPositiveInteger = (n) => Number.isInteger(n) && n > 0

function checkPixel(px, x, y) {
  if (!Array.isArray(px) || px.length !== 4) {
    throw new Error(`TextureScript: paint(${x}, ${y}) must return [r, g, b, a], got ${Array.isArray(px) ? `${px.length} values` : typeof px}`)
  }
  for (let i = 0; i < 4; i++) {
    if (typeof px[i] !== 'number' || !Number.isFinite(px[i])) {
      throw new Error(`TextureScript: paint(${x}, ${y}) channel ${i} is not a finite number (${px[i]})`)
    }
  }
}

export function paintTexture({ width, height, seed = 1337, paint } = {}) {
  if (!isPositiveInteger(width)) throw new Error(`TextureScript: width must be a positive integer, got ${width}`)
  if (!isPositiveInteger(height)) throw new Error(`TextureScript: height must be a positive integer, got ${height}`)
  if (!Number.isInteger(seed)) throw new Error(`TextureScript: seed must be an integer, got ${seed}`)
  if (typeof paint !== 'function') throw new Error('TextureScript: paint must be a function(x, y, u, v, noise) returning [r, g, b, a]')

  const noise = createFbm2D(seed, { octaves: 4 })
  const pixels = new Uint8ClampedArray(width * height * 4)
  const du = width > 1 ? 1 / (width - 1) : 0
  const dv = height > 1 ? 1 / (height - 1) : 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = paint(x, y, x * du, y * dv, noise)
      checkPixel(px, x, y)
      const o = (y * width + x) * 4
      pixels[o] = px[0]
      pixels[o + 1] = px[1]
      pixels[o + 2] = px[2]
      pixels[o + 3] = px[3]
    }
  }
  return { width, height, pixels }
}
