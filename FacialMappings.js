export function detectVRMVersion(vrm) {
  if (!vrm) return '1'
  if (vrm.meta?.version === '0' || vrm.meta?.specVersion?.startsWith('0')) return '0'
  if (vrm.expressionManager) {
    const names = vrm.expressionManager.expressions.map(e => e.expressionName)
    if (names.includes('fun') || names.includes('sorrow')) return '0'
    if (names.includes('happy') || names.includes('sad')) return '1'
  }
  return '1'
}

export function clamp(v, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, v))
}

export function mapVisemes(bs) {
  const { jawOpen=0, mouthFunnel=0, mouthPucker=0, mouthSmileLeft=0, mouthSmileRight=0,
    mouthUpperUpLeft=0, mouthUpperUpRight=0, mouthLowerDownLeft=0, mouthLowerDownRight=0,
    mouthStretchLeft=0, mouthStretchRight=0 } = bs
  const stretch = Math.max(mouthStretchLeft, mouthStretchRight)
  const upperUp = Math.max(mouthUpperUpLeft, mouthUpperUpRight)
  const lowerDown = Math.max(mouthLowerDownLeft, mouthLowerDownRight)
  return {
    aa: clamp(jawOpen * 0.7 + lowerDown * 0.3),
    ih: clamp(upperUp * 0.6 + stretch * 0.4),
    ou: clamp(mouthFunnel * 0.5 + mouthPucker * 0.5),
    ee: clamp(stretch * 0.7 + (1 - jawOpen) * 0.3),
    oh: clamp(mouthPucker * 0.4 + jawOpen * 0.4 + mouthFunnel * 0.2)
  }
}

export function mapEyes(bs) {
  const { eyeBlinkLeft=0, eyeBlinkRight=0, eyeSquintLeft=0, eyeSquintRight=0,
    eyeLookUpLeft=0, eyeLookUpRight=0, eyeLookDownLeft=0, eyeLookDownRight=0,
    eyeLookInLeft=0, eyeLookInRight=0, eyeLookOutLeft=0, eyeLookOutRight=0 } = bs
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

export function mapBrows(bs) {
  const { browInnerUp=0, browDownLeft=0, browDownRight=0, browOuterUpLeft=0, browOuterUpRight=0 } = bs
  return { browInnerUp, browDown: Math.max(browDownLeft, browDownRight), browOuterUp: Math.max(browOuterUpLeft, browOuterUpRight) }
}

export function mapEmotionsV0(bs) {
  const { mouthSmileLeft=0, mouthSmileRight=0, mouthFrownLeft=0, mouthFrownRight=0,
    browInnerUp=0, browDownLeft=0, browDownRight=0, browOuterUpLeft=0, browOuterUpRight=0,
    cheekPuff=0, eyeSquintLeft=0, eyeSquintRight=0, noseSneerLeft=0, noseSneerRight=0 } = bs
  const smile = Math.max(mouthSmileLeft, mouthSmileRight)
  const frown = Math.max(mouthFrownLeft, mouthFrownRight)
  const browDown = Math.max(browDownLeft, browDownRight)
  const squint = Math.max(eyeSquintLeft, eyeSquintRight)
  const sneer = Math.max(noseSneerLeft, noseSneerRight)
  return {
    joy: clamp(smile * 0.8 + (1 - browDown) * 0.2),
    fun: clamp(smile * 0.6 + cheekPuff * 0.3 + squint * 0.1),
    angry: clamp(browDown * 0.6 + sneer * 0.3 + frown * 0.1),
    sorrow: clamp(frown * 0.5 + browDown * 0.3 + (1 - smile) * 0.2)
  }
}

export function mapEmotionsV1(bs) {
  const { mouthSmileLeft=0, mouthSmileRight=0, mouthFrownLeft=0, mouthFrownRight=0,
    browInnerUp=0, browDownLeft=0, browDownRight=0, browOuterUpLeft=0, browOuterUpRight=0,
    cheekPuff=0, eyeSquintLeft=0, eyeSquintRight=0, noseSneerLeft=0, noseSneerRight=0,
    jawOpen=0, eyeWideLeft=0, eyeWideRight=0 } = bs
  const smile = Math.max(mouthSmileLeft, mouthSmileRight)
  const frown = Math.max(mouthFrownLeft, mouthFrownRight)
  const browUp = browInnerUp + Math.max(browOuterUpLeft, browOuterUpRight)
  const browDown = Math.max(browDownLeft, browDownRight)
  const squint = Math.max(eyeSquintLeft, eyeSquintRight)
  const wide = Math.max(eyeWideLeft, eyeWideRight)
  const sneer = Math.max(noseSneerLeft, noseSneerRight)
  return {
    happy: clamp(smile * 0.9 + squint * 0.1),
    sad: clamp(frown * 0.6 + browDown * 0.3 + (1 - smile) * 0.1),
    angry: clamp(browDown * 0.5 + sneer * 0.3 + frown * 0.2),
    relaxed: clamp((1 - browDown) * 0.5 + smile * 0.3 + cheekPuff * 0.2),
    surprised: clamp(browUp * 0.6 + wide * 0.3 + jawOpen * 0.1)
  }
}
