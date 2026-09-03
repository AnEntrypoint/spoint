import * as THREE from 'three'

export class AnimationStreamingManager {
  constructor(options = {}) {
    this.clipCache = new Map()
    this.modelCache = new Map()
    this.pendingRequests = new Map()
    this.loader = options.loader || new THREE.ObjectLoader()
    this.maxCacheSize = options.maxCacheSize || 100
    this.debug = options.debug || false
  }

  async loadAnimationClips(url, cacheKey = url) {
    if (this.clipCache.has(cacheKey)) {
      if (this.debug) console.log(`[AnimationStreamingManager] Cache hit for ${cacheKey}`)
      return this.clipCache.get(cacheKey)
    }

    if (this.pendingRequests.has(cacheKey)) {
      if (this.debug) console.log(`[AnimationStreamingManager] Awaiting pending request for ${cacheKey}`)
      return this.pendingRequests.get(cacheKey)
    }

    const promise = this._fetchClips(url, cacheKey)
    this.pendingRequests.set(cacheKey, promise)

    try {
      const clips = await promise
      this.pendingRequests.delete(cacheKey)
      return clips
    } catch (error) {
      this.pendingRequests.delete(cacheKey)
      throw error
    }
  }

  async _fetchClips(url, cacheKey) {
    try {
      if (this.debug) console.log(`[AnimationStreamingManager] Loading animations from ${url}`)

      const gltf = await this._loadGLB(url)
      const clips = gltf.animations || []

      const clipMap = new Map()
      for (const clip of clips) {
        clipMap.set(clip.name, clip)
      }

      this._cachifyClips(cacheKey, clipMap)
      return clipMap
    } catch (error) {
      console.error(`[AnimationStreamingManager] Failed to load animations from ${url}:`, error)
      throw error
    }
  }

  async _loadGLB(url) {
    return fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
        return res.arrayBuffer()
      })
      .then(ab => this._parseGLB(ab))
  }

  _parseGLB(arrayBuffer) {
    const view = new DataView(arrayBuffer)
    const magic = view.getUint32(0, true)

    if (magic !== 0x46546c67) {
      throw new Error('Invalid GLB file (wrong magic number)')
    }

    const version = view.getUint32(4, true)
    if (version !== 2) {
      throw new Error(`GLB version ${version} not supported (expected 2)`)
    }

    const jsonLen = view.getUint32(12, true)
    const jsonStr = new TextDecoder().decode(new Uint8Array(arrayBuffer, 20, jsonLen))
    const json = JSON.parse(jsonStr)

    const gltf = {
      animations: [],
      scene: null,
    }

    if (json.animations) {
      for (let i = 0; i < json.animations.length; i++) {
        const animDef = json.animations[i]
        const clip = this._createAnimationClip(animDef, json, arrayBuffer, 20 + jsonLen + 8)
        if (clip) gltf.animations.push(clip)
      }
    }

    return gltf
  }

  _createAnimationClip(animDef, json, arrayBuffer, binOffset) {
    const name = animDef.name || 'Animation'
    const channels = animDef.channels || []
    const samplers = animDef.samplers || []

    if (channels.length === 0 || samplers.length === 0) {
      return null
    }

    const tracks = []

    for (const channel of channels) {
      const sampler = samplers[channel.sampler]
      if (!sampler) continue

      const targetNode = channel.target.node
      const property = channel.target.path

      const inputAccessor = json.accessors[sampler.input]
      const outputAccessor = json.accessors[sampler.output]

      if (!inputAccessor || !outputAccessor) continue

      const times = this._readAccessorData(inputAccessor, json, arrayBuffer, binOffset)
      const values = this._readAccessorData(outputAccessor, json, arrayBuffer, binOffset)

      if (times && values) {
        const nodeName = json.nodes[targetNode]?.name || `Node_${targetNode}`
        const trackName = `${nodeName}.${property}`

        let TrackConstructor = THREE.NumberKeyframeTrack
        if (property === 'quaternion') TrackConstructor = THREE.QuaternionKeyframeTrack
        if (property === 'position') TrackConstructor = THREE.VectorKeyframeTrack
        if (property === 'scale') TrackConstructor = THREE.VectorKeyframeTrack

        const track = new TrackConstructor(trackName, times, values)
        tracks.push(track)
      }
    }

    if (tracks.length === 0) return null

    const duration = Math.max(...tracks.map(t => Math.max(...t.times)))
    return new THREE.AnimationClip(name, duration, tracks)
  }

  _readAccessorData(accessor, json, arrayBuffer, binOffset) {
    const bufferView = json.bufferViews[accessor.bufferView]
    if (!bufferView) return null

    const offset = binOffset + (bufferView.byteOffset || 0) + (accessor.byteOffset || 0)
    const count = accessor.count
    const type = accessor.type
    const componentType = accessor.componentType

    const itemSize = this._getAccessorItemSize(type)
    if (!itemSize) return null

    const TypedArray = this._getComponentTypeArray(componentType)
    if (!TypedArray) return null

    const elementBytes = TypedArray.BYTES_PER_ELEMENT
    const itemBytes = elementBytes * itemSize
    const byteStride = (bufferView.byteStride || itemBytes)

    const array = new TypedArray(count * itemSize)

    for (let i = 0; i < count; i++) {
      const itemOffset = offset + i * byteStride
      const viewOffset = i * itemSize
      for (let j = 0; j < itemSize; j++) {
        const byteOffset = itemOffset + j * elementBytes
        const view = new TypedArray(arrayBuffer, byteOffset, 1)
        array[viewOffset + j] = view[0]
      }
    }

    return array
  }

  _getAccessorItemSize(type) {
    switch (type) {
      case 'SCALAR': return 1
      case 'VEC2': return 2
      case 'VEC3': return 3
      case 'VEC4': return 4
      case 'MAT2': return 4
      case 'MAT3': return 9
      case 'MAT4': return 16
      default: return null
    }
  }

  _getComponentTypeArray(type) {
    switch (type) {
      case 5120: return Int8Array
      case 5121: return Uint8Array
      case 5122: return Int16Array
      case 5125: return Uint32Array
      case 5126: return Float32Array
      default: return null
    }
  }

  _cachifyClips(cacheKey, clipMap) {
    this.clipCache.set(cacheKey, clipMap)

    if (this.clipCache.size > this.maxCacheSize) {
      const oldestKey = this.clipCache.keys().next().value
      this.clipCache.delete(oldestKey)
      if (this.debug) console.log(`[AnimationStreamingManager] Evicted cache entry: ${oldestKey}`)
    }
  }

  getClip(cacheKey, clipName) {
    const clipMap = this.clipCache.get(cacheKey)
    if (!clipMap) return null
    return clipMap.get(clipName) || null
  }

  clearCache() {
    this.clipCache.clear()
    if (this.debug) console.log('[AnimationStreamingManager] Cache cleared')
  }

  getCacheStats() {
    return {
      cacheSize: this.clipCache.size,
      pendingRequests: this.pendingRequests.size,
      totalClips: Array.from(this.clipCache.values()).reduce((sum, map) => sum + map.size, 0),
    }
  }
}

export default AnimationStreamingManager
