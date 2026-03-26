import { detectVRMVersion, clamp, mapVisemes, mapEyes, mapEmotionsV0, mapEmotionsV1 } from './FacialMappings.js'

const MAGIC = 0x4146414E
export const ARKIT_NAMES = [
  'browInnerUp','browDownLeft','browDownRight','browOuterUpLeft','browOuterUpRight',
  'eyeLookUpLeft','eyeLookUpRight','eyeLookDownLeft','eyeLookDownRight',
  'eyeLookInLeft','eyeLookInRight','eyeLookOutLeft','eyeLookOutRight',
  'eyeBlinkLeft','eyeBlinkRight','eyeSquintLeft','eyeSquintRight',
  'eyeWideLeft','eyeWideRight','cheekPuff','cheekSquintLeft','cheekSquintRight',
  'noseSneerLeft','noseSneerRight','jawOpen','jawForward','jawLeft','jawRight',
  'mouthFunnel','mouthPucker','mouthLeft','mouthRight',
  'mouthRollUpper','mouthRollLower','mouthShrugUpper','mouthShrugLower',
  'mouthOpen','mouthClose','mouthSmileLeft','mouthSmileRight',
  'mouthFrownLeft','mouthFrownRight','mouthDimpleLeft','mouthDimpleRight',
  'mouthUpperUpLeft','mouthUpperUpRight','mouthLowerDownLeft','mouthLowerDownRight',
  'mouthPressLeft','mouthPressRight','mouthStretchLeft','mouthStretchRight'
]

export class AnimationReader {
  constructor() { this.fps=30; this.numBlendshapes=0; this.numFrames=0; this.names=ARKIT_NAMES; this.frames=[] }
  fromBuffer(buf) {
    let off=0; const v=new DataView(buf instanceof ArrayBuffer?buf:buf.buffer)
    if (v.getUint32(off,true)!==MAGIC) throw new Error('Invalid animation file'); off+=4
    const ver=v.getUint8(off); off+=1; if (ver<1||ver>2) throw new Error(`Unsupported version: ${ver}`)
    this.fps=v.getUint8(off); off+=1; this.numBlendshapes=v.getUint8(off); off+=2
    this.numFrames=v.getUint32(off,true); off+=4
    if (ver===1) { this.names=[]; for (let i=0;i<this.numBlendshapes;i++) { const l=v.getUint8(off++); this.names.push(new TextDecoder().decode(new Uint8Array(buf,off,l))); off+=l } }
    this.frames=[]
    for (let f=0;f<this.numFrames;f++) { const fr={}; for (let i=0;i<this.numBlendshapes;i++) fr[this.names[i]]=v.getUint8(off++)/255; this.frames.push({time:f/this.fps,blendshapes:fr}) }
    return this
  }
  getFrame(i) { return this.frames[Math.max(0,Math.min(i,this.frames.length-1))] }
  getFrameAtTime(t) { return this.getFrame(Math.floor(t*this.fps)) }
}

export class FacialAnimationPlayer {
  constructor(vrm, opts={}) {
    this.vrm=vrm; this.expressionManager=vrm.expressionManager; this.vrmVersion=detectVRMVersion(vrm)
    this.animation=null; this.audio=null; this.isPlaying=false; this.startTime=0; this.currentTime=0
    this.onComplete=null; this.volume=opts.volume??1.0
    this.availableExpressions=new Set(); this.storedExpressions=new Map(); this.lastApplied=new Map()
    if (this.expressionManager) this.expressionManager.expressions.forEach(e=>this.availableExpressions.add(e.expressionName))
  }
  loadAnimation(buf) { this.animation=new AnimationReader().fromBuffer(buf); return this.animation }
  loadAudio(buf,mime='audio/mpeg') {
    this.audio=new Audio(); this.audio.src=URL.createObjectURL(new Blob([buf],{type:mime})); this.audio.volume=this.volume
    return new Promise((res,rej)=>{this.audio.oncanplaythrough=()=>res(this);this.audio.onerror=()=>rej(new Error('Failed to load audio'))})
  }
  async load(anim,audio,mime) { if (anim) this.loadAnimation(anim); if (audio) await this.loadAudio(audio,mime); return this }
  play() {
    if (!this.animation) return
    this.storedExpressions.clear(); this.lastApplied.clear()
    if (this.expressionManager) for (const n of ['blink','blinkLeft','blinkRight']) { if (this.availableExpressions.has(n)) { const v=this.expressionManager.getValue(n); if (v>0) this.storedExpressions.set(n,v) } }
    this.isPlaying=true; this.startTime=performance.now()
    if (this.audio) { this.audio.currentTime=0; this.audio.play().catch(()=>{}) }
  }
  stop() { this.isPlaying=false; if (this.audio){this.audio.pause();this.audio.currentTime=0}; this.resetExpressions() }
  resetExpressions() {
    if (!this.expressionManager) return
    for (const n of this.availableExpressions) this.expressionManager.setValue(n,this.storedExpressions.has(n)?this.storedExpressions.get(n):0)
    this.lastApplied.clear()
  }
  update(dt) {
    if (!this.isPlaying||!this.animation) return
    const elapsed=(performance.now()-this.startTime)/1000; this.currentTime=elapsed
    const frame=this.animation.getFrameAtTime(elapsed); if (!frame) return
    this.applyFrame(frame.blendshapes)
    if (elapsed>=this.animation.frames.length/this.animation.fps) { this.isPlaying=false; if (this.onComplete) this.onComplete() }
  }
  applyFrame(bs) {
    if (!this.expressionManager) return
    const vals=new Map(), has=n=>this.availableExpressions.has(n), set=(n,v)=>{if(has(n)&&v>0.001)vals.set(n,clamp(v))}
    const vis=mapVisemes(bs); set('aa',vis.aa); set('ih',vis.ih); set('ou',vis.ou); set('ee',vis.ee); set('oh',vis.oh)
    const eyes=mapEyes(bs); set('blinkLeft',eyes.blinkLeft); set('blinkRight',eyes.blinkRight); set('blink',eyes.blink); set('lookUp',eyes.lookUp); set('lookDown',eyes.lookDown); set('lookLeft',eyes.lookLeft); set('lookRight',eyes.lookRight)
    const emo=this.vrmVersion==='0'?mapEmotionsV0(bs):mapEmotionsV1(bs)
    if (this.vrmVersion==='0'){set('joy',emo.joy);set('fun',emo.fun);set('angry',emo.angry);set('sorrow',emo.sorrow)}
    else{set('happy',emo.happy);set('sad',emo.sad);set('angry',emo.angry);set('relaxed',emo.relaxed);set('surprised',emo.surprised)}
    for (const [n,v] of vals) { if (!this.storedExpressions.has(n)){this.expressionManager.setValue(n,v);this.lastApplied.set(n,v)} }
    for (const n of this.lastApplied.keys()) { if (!vals.has(n)){const d=this.lastApplied.get(n)*0.6;if(d<0.01){this.expressionManager.setValue(n,0);this.lastApplied.delete(n)}else{this.expressionManager.setValue(n,d);this.lastApplied.set(n,d)}} }
  }
  getDuration() { return this.animation?this.animation.frames.length/this.animation.fps:0 }
  setVolume(v) { this.volume=Math.max(0,Math.min(1,v)); if (this.audio) this.audio.volume=this.volume }
  dispose() { this.stop(); if (this.audio){URL.revokeObjectURL(this.audio.src);this.audio=null}; this.animation=null }
}

const _facialPlayers = new Map()

export function initFacialSystem(engine) {
  engine.facial = {
    async load(id, animUrl, audioUrl) {
      const vrm=engine.playerVrms?.get(id); if (!vrm) return null
      let p=_facialPlayers.get(id); if (!p){p=new FacialAnimationPlayer(vrm);_facialPlayers.set(id,p)}
      const [ab,bb]=await Promise.all([fetch(animUrl).then(r=>r.ok?r.arrayBuffer():null).catch(()=>null),fetch(audioUrl).then(r=>r.ok?r.arrayBuffer():null).catch(()=>null)])
      if (!ab) return null; await p.load(ab,bb); return p
    },
    play(id){const p=_facialPlayers.get(id);if(p)p.play();return p},
    stop(id){const p=_facialPlayers.get(id);if(p)p.stop();return p},
    async playNow(id,a,b){const p=await this.load(id,a,b);if(p)p.play();return p},
    getPlayer(id){return _facialPlayers.get(id)},
    isPlaying(id){return _facialPlayers.get(id)?.isPlaying??false},
    update(dt){for(const p of _facialPlayers.values())p.update(dt)},
    dispose(id){const p=_facialPlayers.get(id);if(p){p.dispose();_facialPlayers.delete(id)}}
  }
  return engine.facial
}

export function createFacialPlayer(vrm, opts={}) { return new FacialAnimationPlayer(vrm, opts) }
export default FacialAnimationPlayer
