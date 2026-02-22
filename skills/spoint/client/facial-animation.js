import * as THREE from 'three'

const MAGIC = 0x4146414E
const ARKIT_NAMES = [
  'browInnerUp', 'browDownLeft', 'browDownRight', 'browOuterUpLeft', 'browOuterUpRight',
  'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight',
  'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight', 'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'noseSneerLeft', 'noseSneerRight', 'jawOpen', 'jawForward', 'jawLeft', 'jawRight',
  'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight',
  'mouthRollUpper', 'mouthRollLower', 'mouthShrugUpper', 'mouthShrugLower',
  'mouthOpen', 'mouthClose', 'mouthSmileLeft', 'mouthSmileRight',
  'mouthFrownLeft', 'mouthFrownRight', 'mouthDimpleLeft', 'mouthDimpleRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight', 'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthPressLeft', 'mouthPressRight', 'mouthStretchLeft', 'mouthStretchRight'
]

function detectVRMVersion(vrm) {
  if (!vrm) return '1'
  if (vrm.meta?.version === '0' || vrm.meta?.specVersion?.startsWith('0')) return '0'
  if (vrm.expressionManager) {
    const names = vrm.expressionManager.expressions.map(e => e.expressionName)
    if (names.includes('fun') || names.includes('sorrow')) return '0'
    if (names.includes('happy') || names.includes('sad')) return '1'
  }
  return '1'
}

function clamp(v, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, v))
}

function mapVisemes(blendshapes) {
  const {
    jawOpen = 0, mouthClose = 0, mouthFunnel = 0, mouthPucker = 0,
    mouthSmileLeft = 0, mouthSmileRight = 0, mouthFrownLeft = 0, mouthFrownRight = 0,
    mouthUpperUpLeft = 0, mouthUpperUpRight = 0, mouthLowerDownLeft = 0, mouthLowerDownRight = 0,
    mouthStretchLeft = 0, mouthStretchRight = 0, mouthRollUpper = 0, mouthRollLower = 0,
    mouthPressLeft =  0, mouthPressRight = 0, mouthShrugUpper = 0, mouthShrugLower = 0,
    mouthDimpleLeft = 0, mouthDimpleRight = 0, mouthLeft = 0, mouthRight = 0
  } = blendshapes

  const smile = Math.max(mouthSmileLeft, mouthSmileRight)
  const stretch = Math.max(mouthStretchLeft, mouthStretchRight)
  const upperUp = Math.max(mouthUpperUpLeft, mouthUpperUpRight)
  const lowerDown = Math.max(mouthLowerDownLeft, mouthLowerDownRight)
  const frown = Math.max(mouthFrownLeft, mouthFrownRight)
  
  const aa = clamp(jawOpen * 0.7 + lowerDown * 0.3)
  const ih = clamp(upperUp * 0.6 + stretch * 0.4)
  const ou = clamp(mouthFunnel * 0.5 + mouthPucker * 0.5)
  const ee = clamp(stretch * 0.7 + (1 - jawOpen) * 0.3)
  const oh = clamp(mouthPucker * 0.4 + jawOpen * 0.4 + mouthFunnel * 0.2)

  return { aa, ih, ou, ee, oh }
}

function mapEyes(blendshapes) {
  const {
    eyeBlinkLeft = 0, eyeBlinkRight = 0, eyeSquintLeft = 0, eyeSquintRight = 0,
    eyeWideLeft = 0, eyeWideRight = 0, eyeLookUpLeft = 0, eyeLookUpRight = 0,
    eyeLookDownLeft = 0, eyeLookDownRight = 0, eyeLookInLeft = 0, eyeLookInRight = 0,
    eyeLookOutLeft = 0, eyeLookOutRight = 0
  } = blendshapes

  return {
    blinkLeft: clamp(eyeBlinkLeft + eyeSquintLeft * 0.3),
    blinkRight: clamp(eyeBlinkRight + eyeSquintRight * 0.3),
    blink: clamp((eyeBlinkLeft + eyeBlinkRight) / 2),
    lookUp: clamp(Math.max(eyeLookUpLeft, eyeLookUpRight)),
    lookDown: clamp(Math.max(eyeLookDownLeft, eyeLookDownRight)),
    lookLeft: clamp(Math.max(eyeLookInLeft, eyeLookOutRight)),
    lookRight: clamp(Math.max(eyeLookInRight, eyeLookOutLeft))
  }
}

function mapBrows(blendshapes) {
  const {
    browInnerUp = 0, browDownLeft = 0, browDownRight = 0,
    browOuterUpLeft = 0, browOuterUpRight = 0
  } = blendshapes

  return {
    browInnerUp,
    browDown: Math.max(browDownLeft, browDownRight),
    browOuterUp: Math.max(browOuterUpLeft, browOuterUpRight)
  }
}

function mapEmotionsV0(blendshapes) {
  const {
    mouthSmileLeft = 0, mouthSmileRight = 0, mouthFrownLeft = 0, mouthFrownRight = 0,
    browInnerUp = 0, browDownLeft = 0, browDownRight = 0, browOuterUpLeft = 0, browOuterUpRight = 0,
    cheekPuff = 0, eyeSquintLeft = 0, eyeSquintRight = 0, noseSneerLeft = 0, noseSneerRight = 0,
    jawOpen = 0, mouthFunnel = 0, mouthPucker = 0, eyeWideLeft = 0, eyeWideRight = 0
  } = blendshapes

  const smile = Math.max(mouthSmileLeft, mouthSmileRight)
  const frown = Math.max(mouthFrownLeft, mouthFrownRight)
  const browUp = browInnerUp + Math.max(browOuterUpLeft, browOuterUpRight)
  const browDown = Math.max(browDownLeft, browDownRight)
  const squint = Math.max(eyeSquintLeft, eyeSquintRight)
  const wide = Math.max(eyeWideLeft, eyeWideRight)
  const sneer = Math.max(noseSneerLeft, noseSneerRight)

  const joy = clamp(smile * 0.8 + (1 - browDown) * 0.2)
  const fun = clamp(smile * 0.6 + cheekPuff * 0.3 + squint * 0.1)
  const angry = clamp(browDown * 0.6 + sneer * 0.3 + frown * 0.1)
  const sorrow = clamp(frown * 0.5 + browDown * 0.3 + (1 - smile) * 0.2)

  return { joy, angry, sorrow, fun }
}

function mapEmotionsV1(blendshapes) {
  const {
    mouthSmileLeft = 0, mouthSmileRight = 0, mouthFrownLeft = 0, mouthFrownRight = 0,
    browInnerUp = 0, browDownLeft = 0, browDownRight = 0, browOuterUpLeft = 0, browOuterUpRight = 0,
    cheekPuff = 0, eyeSquintLeft = 0, eyeSquintRight = 0, noseSneerLeft = 0, noseSneerRight = 0,
    jawOpen = 0, mouthFunnel = 0, mouthPucker = 0, eyeWideLeft = 0, eyeWideRight = 0
  } = blendshapes

  const smile = Math.max(mouthSmileLeft, mouthSmileRight)
  const frown = Math.max(mouthFrownLeft, mouthFrownRight)
  const browUp = browInnerUp + Math.max(browOuterUpLeft, browOuterUpRight)
  const browDown = Math.max(browDownLeft, browDownRight)
  const squint = Math.max(eyeSquintLeft, eyeSquintRight)
  const wide = Math.max(eyeWideLeft, eyeWideRight)
  const sneer = Math.max(noseSneerLeft, noseSneerRight)

  const happy = clamp(smile * 0.9 + squint * 0.1)
  const sad = clamp(frown * 0.6 + browDown * 0.3 + (1 - smile) * 0.1)
  const angry = clamp(browDown * 0.5 + sneer * 0.3 + frown * 0.2)
  const relaxed = clamp((1 - browDown) * 0.5 + smile * 0.3 + cheekPuff * 0.2)
  const surprised = clamp(browUp * 0.6 + wide * 0.3 + jawOpen * 0.1)

  return { happy, sad, angry, relaxed, surprised }
}

export class AnimationReader {
  constructor() {
    this.fps = 30
    this.numBlendshapes = 0
    this.numFrames = 0
    this.names = ARKIT_NAMES
    this.frames = []
  }

  fromBuffer(buf) {
    let offset = 0
    const view = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer)
    
    const magic = view.getUint32(offset, true); offset += 4
    if (magic !== MAGIC) throw new Error('Invalid animation file')
    
    const version = view.getUint8(offset); offset += 1
    if (version < 1 || version > 2) throw new Error(`Unsupported version: ${version}`)
    
    this.fps = view.getUint8(offset); offset += 1
    this.numBlendshapes = view.getUint8(offset); offset += 1
    offset += 1
    this.numFrames = view.getUint32(offset, true); offset += 4
    
    if (version === 1) {
      this.names = []
      for (let i = 0; i < this.numBlendshapes; i++) {
        const len = view.getUint8(offset++)
        this.names.push(new TextDecoder().decode(new Uint8Array(buf, offset, len)))
        offset += len
      }
    }
    
    this.frames = []
    for (let f = 0; f < this.numFrames; f++) {
      const frame = {}
      for (let i = 0; i < this.numBlendshapes; i++) {
        frame[this.names[i]] = view.getUint8(offset++) / 255
      }
      this.frames.push({ time: f / this.fps, blendshapes: frame })
    }
    
    return this
  }

  getFrame(index) {
    return this.frames[Math.max(0, Math.min(index, this.frames.length - 1))]
  }

  getFrameAtTime(time) {
    return this.getFrame(Math.floor(time * this.fps))
  }
}

export class FacialAnimationPlayer {
  constructor(vrm, options = {}) {
    this.vrm = vrm
    this.expressionManager = vrm.expressionManager
    this.vrmVersion = detectVRMVersion(vrm)
    this.animation = null
    this.audio = null
    this.isPlaying = false
    this.startTime = 0
    this.currentTime = 0
    this.onComplete = null
    this.volume = options.volume ?? 1.0
    this.availableExpressions = new Set()
    this.storedExpressions = new Map()
    this.lastApplied = new Map()
    
    if (this.expressionManager) {
      this.expressionManager.expressions.forEach(e => {
        this.availableExpressions.add(e.expressionName)
      })
    }
  }

  loadAnimation(buffer) {
    this.animation = new AnimationReader().fromBuffer(buffer)
    return this.animation
  }

  loadAudio(buffer, mimeType = 'audio/mpeg') {
    this.audio = new Audio()
    this.audio.src = URL.createObjectURL(new Blob([buffer], { type: mimeType }))
    this.audio.volume = this.volume
    return new Promise((resolve, reject) => {
      this.audio.oncanplaythrough = () => resolve(this)
      this.audio.onerror = () => reject(new Error('Failed to load audio'))
    })
  }

  async load(animBuffer, audioBuffer, mimeType) {
    if (animBuffer) this.loadAnimation(animBuffer)
    if (audioBuffer) await this.loadAudio(audioBuffer, mimeType)
    return this
  }

  play() {
    if (!this.animation) return
    
    this.storedExpressions.clear()
    this.lastApplied.clear()
    
    if (this.expressionManager) {
      for (const name of ['blink', 'blinkLeft', 'blinkRight']) {
        if (this.availableExpressions.has(name)) {
          const val = this.expressionManager.getValue(name)
          if (val > 0) this.storedExpressions.set(name, val)
        }
      }
    }
    
    this.isPlaying = true
    this.startTime = performance.now()
    
    if (this.audio) {
      this.audio.currentTime = 0
      this.audio.play().catch(() => {})
    }
  }

  stop() {
    this.isPlaying = false
    if (this.audio) {
      this.audio.pause()
      this.audio.currentTime = 0
    }
    this.resetExpressions()
  }

  resetExpressions() {
    if (!this.expressionManager) return
    
    for (const name of this.availableExpressions) {
      if (this.storedExpressions.has(name)) {
        this.expressionManager.setValue(name, this.storedExpressions.get(name))
      } else {
        this.expressionManager.setValue(name, 0)
      }
    }
    this.lastApplied.clear()
  }

  update(dt) {
    if (!this.isPlaying || !this.animation) return
    
    const elapsed = (performance.now() - this.startTime) / 1000
    this.currentTime = elapsed
    
    const frame = this.animation.getFrameAtTime(elapsed)
    if (!frame) return
    
    this.applyFrame(frame.blendshapes)
    
    if (elapsed >= this.animation.frames.length / this.animation.fps) {
      this.isPlaying = false
      if (this.onComplete) this.onComplete()
    }
  }

  applyFrame(blendshapes) {
    if (!this.expressionManager) return

    const values = new Map()
    const has = (name) => this.availableExpressions.has(name)
    const set = (name, val) => {
      if (has(name) && val > 0.001) values.set(name, clamp(val))
    }

    const visemes = mapVisemes(blendshapes)
    set('aa', visemes.aa)
    set('ih', visemes.ih)
    set('ou', visemes.ou)
    set('ee', visemes.ee)
    set('oh', visemes.oh)

    const eyes = mapEyes(blendshapes)
    set('blinkLeft', eyes.blinkLeft)
    set('blinkRight', eyes.blinkRight)
    set('blink', eyes.blink)
    set('lookUp', eyes.lookUp)
    set('lookDown', eyes.lookDown)
    set('lookLeft', eyes.lookLeft)
    set('lookRight', eyes.lookRight)

    if (this.vrmVersion === '0') {
      const emotions = mapEmotionsV0(blendshapes)
      set('joy', emotions.joy)
      set('fun', emotions.fun)
      set('angry', emotions.angry)
      set('sorrow', emotions.sorrow)
    } else {
      const emotions = mapEmotionsV1(blendshapes)
      set('happy', emotions.happy)
      set('sad', emotions.sad)
      set('angry', emotions.angry)
      set('relaxed', emotions.relaxed)
      set('surprised', emotions.surprised)
    }

    for (const [name, val] of values) {
      if (!this.storedExpressions.has(name)) {
        this.expressionManager.setValue(name, val)
        this.lastApplied.set(name, val)
      }
    }

    for (const name of this.lastApplied.keys()) {
      if (!values.has(name)) {
        const last = this.lastApplied.get(name)
        const decayed = last * 0.6
        if (decayed < 0.01) {
          this.expressionManager.setValue(name, 0)
          this.lastApplied.delete(name)
        } else {
          this.expressionManager.setValue(name, decayed)
          this.lastApplied.set(name, decayed)
        }
      }
    }
  }

  getDuration() {
    return this.animation ? this.animation.frames.length / this.animation.fps : 0
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v))
    if (this.audio) this.audio.volume = this.volume
  }

  dispose() {
    this.stop()
    if (this.audio) {
      URL.revokeObjectURL(this.audio.src)
      this.audio = null
    }
    this.animation = null
  }
}

const playerFacialPlayers = new Map()

export function initFacialSystem(engine) {
  engine.facial = {
    async load(playerId, animUrl, audioUrl) {
      const vrm = engine.playerVrms?.get(playerId)
      if (!vrm) return null
      
      let player = playerFacialPlayers.get(playerId)
      if (!player) {
        player = new FacialAnimationPlayer(vrm)
        playerFacialPlayers.set(playerId, player)
      }
      
      const [animResp, audioResp] = await Promise.all([
        fetch(animUrl).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null),
        fetch(audioUrl).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null)
      ])
      
      if (!animResp) return null
      
      await player.load(animResp, audioResp)
      return player
    },
    
    play(playerId) {
      const player = playerFacialPlayers.get(playerId)
      if (player) player.play()
      return player
    },
    
    stop(playerId) {
      const player = playerFacialPlayers.get(playerId)
      if (player) player.stop()
      return player
    },
    
    async playNow(playerId, animUrl, audioUrl) {
      const player = await this.load(playerId, animUrl, audioUrl)
      if (player) player.play()
      return player
    },
    
    getPlayer(playerId) {
      return playerFacialPlayers.get(playerId)
    },
    
    isPlaying(playerId) {
      return playerFacialPlayers.get(playerId)?.isPlaying ?? false
    },
    
    update(dt) {
      for (const player of playerFacialPlayers.values()) {
        player.update(dt)
      }
    },
    
    dispose(playerId) {
      const player = playerFacialPlayers.get(playerId)
      if (player) {
        player.dispose()
        playerFacialPlayers.delete(playerId)
      }
    }
  }
  
  return engine.facial
}

export function createFacialPlayer(vrm, options = {}) {
  return new FacialAnimationPlayer(vrm, options)
}

export default FacialAnimationPlayer