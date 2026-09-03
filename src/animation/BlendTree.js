import * as THREE from 'three'

export class BlendTree1D {
  constructor(clips = []) {
    this.clips = clips
    this.weights = new Array(clips.length).fill(0)
    this.parameter = 0
  }

  addClip(clip, threshold = 0) {
    this.clips.push({ clip, threshold })
    this.weights.push(0)
    return this
  }

  setParameter(value) {
    this.parameter = value
    this._updateWeights()
    return this
  }

  _updateWeights() {
    const n = this.clips.length
    if (n === 0) return

    for (let i = 0; i < n; i++) {
      this.weights[i] = 0
    }

    let leftIdx = -1
    let rightIdx = -1

    for (let i = 0; i < n; i++) {
      const threshold = this.clips[i].threshold
      if (threshold <= this.parameter) {
        leftIdx = i
      }
      if (threshold >= this.parameter && rightIdx === -1) {
        rightIdx = i
      }
    }

    if (leftIdx === -1) {
      this.weights[0] = 1
      return
    }
    if (rightIdx === -1 || leftIdx === rightIdx) {
      this.weights[leftIdx] = 1
      return
    }

    const leftThreshold = this.clips[leftIdx].threshold
    const rightThreshold = this.clips[rightIdx].threshold
    const range = rightThreshold - leftThreshold

    if (range <= 0) {
      this.weights[leftIdx] = 1
      return
    }

    const t = (this.parameter - leftThreshold) / range
    this.weights[leftIdx] = 1 - t
    this.weights[rightIdx] = t
  }

  getWeight(index) {
    return this.weights[index] || 0
  }

  getWeights() {
    return [...this.weights]
  }
}

export class BlendTree2D {
  constructor(clips = []) {
    this.clips = clips
    this.weights = new Array(clips.length).fill(0)
    this.posX = 0
    this.posY = 0
  }

  addClip(clip, x = 0, y = 0) {
    this.clips.push({ clip, x, y })
    this.weights.push(0)
    return this
  }

  setParameter(x, y) {
    this.posX = x
    this.posY = y
    this._updateWeights()
    return this
  }

  _updateWeights() {
    const n = this.clips.length
    if (n === 0) return

    for (let i = 0; i < n; i++) {
      this.weights[i] = 0
    }

    const x = this.posX
    const y = this.posY

    const distances = this.clips.map((c, i) => ({
      index: i,
      dist: Math.sqrt((c.x - x) ** 2 + (c.y - y) ** 2),
    }))

    distances.sort((a, b) => a.dist - b.dist)

    if (distances[0].dist === 0) {
      this.weights[distances[0].index] = 1
      return
    }

    let totalInverse = 0
    const influences = []

    for (let i = 0; i < Math.min(3, distances.length); i++) {
      const inv = 1 / Math.max(distances[i].dist, 0.01)
      influences.push({ index: distances[i].index, inv })
      totalInverse += inv
    }

    for (const { index, inv } of influences) {
      this.weights[index] = inv / totalInverse
    }
  }

  getWeight(index) {
    return this.weights[index] || 0
  }

  getWeights() {
    return [...this.weights]
  }
}

export class BlendTreeNode {
  constructor(name = '', children = []) {
    this.name = name
    this.children = children
    this.output = 0
  }

  addChild(node) {
    this.children.push(node)
    return this
  }

  update(dt) {
    for (const child of this.children) {
      if (typeof child.update === 'function') {
        child.update(dt)
      }
    }
  }
}

export class AnimationBlender {
  constructor(mixer, clips = []) {
    this.mixer = mixer
    this.clips = new Map()
    this.actions = new Map()
    this.blendTree = null
    this.currentBlend = 'idle'
    this.fadeTime = 0.3
    this.playbackSpeed = 1.0

    for (const clip of clips) {
      this.registerClip(clip.name, clip)
    }
  }

  registerClip(name, clip) {
    if (!clip) return
    this.clips.set(name, clip)
    const action = this.mixer.clipAction(clip)
    action.clampWhenFinished = true
    this.actions.set(name, action)
    return this
  }

  playClip(name, fadeTime = this.fadeTime) {
    const action = this.actions.get(name)
    if (!action) {
      console.warn(`[AnimationBlender] Clip not found: ${name}`)
      return
    }

    const currentAction = this.actions.get(this.currentBlend)
    if (currentAction && currentAction !== action) {
      currentAction.fadeOut(fadeTime)
    }

    action.reset()
    action.fadeIn(fadeTime)
    action.play()
    this.currentBlend = name
    return this
  }

  crossFade(fromName, toName, fadeTime = this.fadeTime) {
    const fromAction = this.actions.get(fromName)
    const toAction = this.actions.get(toName)

    if (!toAction) {
      console.warn(`[AnimationBlender] Target clip not found: ${toName}`)
      return
    }

    if (fromAction) {
      fromAction.fadeOut(fadeTime)
    }

    toAction.reset()
    toAction.fadeIn(fadeTime)
    toAction.play()
    this.currentBlend = toName
    return this
  }

  setBlendTree(tree) {
    this.blendTree = tree
    return this
  }

  updateBlend(dt = 0) {
    this.mixer.update(dt)
    return this
  }

  setPlaybackSpeed(speed) {
    this.playbackSpeed = speed
    this.mixer.timeScale = speed
    return this
  }

  stop() {
    const action = this.actions.get(this.currentBlend)
    if (action) {
      action.stop()
    }
  }

  isPlaying(name) {
    const action = this.actions.get(name)
    return action ? action.isRunning() : false
  }

  getClipDuration(name) {
    const clip = this.clips.get(name)
    return clip ? clip.duration : 0
  }
}

export default { BlendTree1D, BlendTree2D, BlendTreeNode, AnimationBlender }
