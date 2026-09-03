// Compact VRM viseme/emote expression wire codes (animation-vrm-spring-bone-lod-expression-wire).
//
// WHY: client/facial-animation.js already drives a VRM's expressionManager LOCALLY (audio-driven
// lipsync playback, or the live ctx.players.setExpression authoring API), but until this file existed
// there was zero network representation of a player's current expression -- a remote player's face
// always rendered neutral/idle-blink-only regardless of what the driving player's own face was doing.
// This table is the single source of truth both ends of the wire share: a driving client picks the
// single MOST SALIENT current expression (see pickExpressionCode below) and stamps its numeric CODE
// (a plain u8, 0..15) onto its own PLAYER_INPUT object as `input.expr` every input tick (same additive-
// piggyback discipline as the existing input._vsync stamp) -- the server stores the raw code
// (TickHandler.js st.expr, mirroring st.crouch from inp.crouch) and rebroadcasts it verbatim as p[7] on
// the FULL player wire record (SnapshotEncoder.js). Every OTHER connected client decodes the code back
// to a VRM expressionManager value via applyExpressionCode and calls pm.setVRMExpression -- the exact
// same authoring entrypoint apps already use for local/scripted expression control.
//
// Deliberately NOT a full continuous blendshape stream (that would need the AnimationReader's ~30fps
// per-blendshape stream this table's driving system, facial-animation.js, already plays back LOCALLY
// from a pre-baked file -- streaming that live over the wire for every player is a real feature but a
// much bigger wire-format problem, out of scope for this first slice). A single u8 code covering the
// broad viseme/emote buckets is enough for a REMOTE avatar to visibly react (mouth shape while talking,
// a visible emote) without materially growing PLAYER_INPUT's per-tick wire cost.
//
// NO VRM-VERSION BRANCHING NEEDED (live-verified, real 2-tab witness against a real VRM 0.x asset --
// see animation-vrm-spring-bone-lod-expression-wire): a first implementation of this file guessed that
// V0 (extensions.VRM) vs V1 (extensions.VRMC_vrm) source files need different expressionManager preset
// names applied at runtime (V0's joy/fun/sorrow vs V1's happy/relaxed/sad). That premise is FALSE --
// three-vrm's own loader plugin (VRMExpressionLoaderPlugin.v0v1PresetNameMap, see
// node_modules/@pixiv/three-vrm) remaps every V0 preset name to its V1 canonical name AT LOAD TIME,
// for BOTH loader plugins, regardless of source file version. A loaded vrm.expressionManager therefore
// ALWAYS exposes V1 canonical names (happy/sad/relaxed/surprised/angry/neutral) -- confirmed live by
// reading a real loaded cleetus.vrm (a real VRM 0.x file)'s expressionManager.expressions list, which
// contains 'happy'/'angry'/'sad'/'relaxed', never 'joy'/'fun'/'sorrow'. One name table, no version param.
export const EXPR_NEUTRAL = 0
export const EXPR_HAPPY = 1
export const EXPR_SAD = 2
export const EXPR_ANGRY = 3
export const EXPR_SURPRISED = 4
export const EXPR_RELAXED = 5
export const EXPR_AA = 6   // open-mouth viseme (ARKIT jawOpen/mouthOpen-driven)
export const EXPR_IH = 7
export const EXPR_OU = 8   // rounded-lip viseme (mouthPucker/mouthFunnel-driven)
export const EXPR_EE = 9
export const EXPR_OH = 10
export const EXPR_BLINK = 11

// name -> code. Accepts BOTH the raw V0 preset spelling (joy/fun/sorrow -- in case a caller reads an
// un-normalized source, e.g. straight off VRM extension JSON rather than a loaded expressionManager)
// and the V1/runtime canonical spelling (happy/relaxed/sad) on the ENCODE side, since a loaded VRM's
// expressionManager always reports the canonical name (see the module comment above) but this stays
// permissive for any caller working from raw preset data instead.
const NAME_TO_CODE = {
  neutral: EXPR_NEUTRAL,
  happy: EXPR_HAPPY, joy: EXPR_HAPPY,
  sad: EXPR_SAD, sorrow: EXPR_SAD,
  angry: EXPR_ANGRY,
  surprised: EXPR_SURPRISED,
  relaxed: EXPR_RELAXED, fun: EXPR_RELAXED,
  aa: EXPR_AA, ih: EXPR_IH, ou: EXPR_OU, ee: EXPR_EE, oh: EXPR_OH,
  blink: EXPR_BLINK
}

// code -> canonical expressionManager value name, applied via pm.setVRMExpression(id, name, 1). Always
// the V1 canonical spelling -- see module comment: this is what a LOADED vrm.expressionManager always
// exposes, regardless of source file's VRM version.
const CODE_TO_NAME = {
  [EXPR_NEUTRAL]: null,   // neutral = "clear whatever this code space controls", not a settable expression name
  [EXPR_HAPPY]: 'happy',
  [EXPR_SAD]: 'sad',
  [EXPR_ANGRY]: 'angry',
  [EXPR_SURPRISED]: 'surprised',
  [EXPR_RELAXED]: 'relaxed',
  [EXPR_AA]: 'aa',
  [EXPR_IH]: 'ih',
  [EXPR_OU]: 'ou',
  [EXPR_EE]: 'ee',
  [EXPR_OH]: 'oh',
  [EXPR_BLINK]: 'blink'
}

// The two mutually-exclusive expression "channels" this code space multiplexes across one u8: an EMOTE
// (happy/sad/angry/surprised/relaxed) is a slower, longer-held state; a VISEME/blink (aa/ih/ou/ee/oh/
// blink) is a fast, per-frame mouth-shape/eye-state change while talking. Only one can be on the wire
// at once (a single u8 code), so pickExpressionCode below prioritizes viseme/blink (the higher-frequency,
// more visually load-bearing-while-speaking signal) over a held emote when both are simultaneously
// active locally -- an emote is still visible the instant speech stops.
const VISEME_CODES = new Set([EXPR_AA, EXPR_IH, EXPR_OU, EXPR_EE, EXPR_OH, EXPR_BLINK])

export function nameToCode(name) { return NAME_TO_CODE[name] ?? null }

// Reads the CURRENT strongest viseme/emote off a live VRMExpressionManager and returns a single u8 code
// (EXPR_NEUTRAL if nothing is active above the threshold). Pure read -- has no side effect on the vrm,
// safe to call every input-sample tick (client/app.js startInputLoop, 60Hz). Candidate list uses the
// canonical (post-load) names only -- see module comment on why the V0 spellings never appear at runtime.
const _CANDIDATE_NAMES = ['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'happy', 'sad', 'angry', 'surprised', 'relaxed']
const THRESHOLD = 0.35
export function pickExpressionCode(expressionManager) {
  if (!expressionManager || typeof expressionManager.getValue !== 'function') return EXPR_NEUTRAL
  let bestViseme = null, bestVisemeV = 0, bestEmote = null, bestEmoteV = 0
  for (const name of _CANDIDATE_NAMES) {
    let v = 0
    try { v = expressionManager.getValue(name) || 0 } catch (_e) { continue }
    if (v < THRESHOLD) continue
    const code = nameToCode(name); if (code === null) continue
    if (VISEME_CODES.has(code)) { if (v > bestVisemeV) { bestVisemeV = v; bestViseme = code } }
    else { if (v > bestEmoteV) { bestEmoteV = v; bestEmote = code } }
  }
  return bestViseme !== null ? bestViseme : (bestEmote !== null ? bestEmote : EXPR_NEUTRAL)
}

// Applies a received u8 code to a REMOTE player's VRM via setExpressionFn (pm.setVRMExpression(id,name,
// value), the exact same authoring entrypoint apps/ctx.players.setExpression already uses locally --
// no second expression-application code path). Clears the PREVIOUS code's expression to 0 first
// (lastCode, caller-tracked) so codes don't visually stack (e.g. leftover 'aa' viseme staying at 1.0
// forever after the driver's mouth closes back to EXPR_NEUTRAL).
export function applyExpressionCode(setExpressionFn, id, code, lastCode) {
  if (lastCode != null && lastCode !== code) {
    const prevName = CODE_TO_NAME[lastCode]
    if (prevName) setExpressionFn(id, prevName, 0)
  }
  const name = CODE_TO_NAME[code]
  if (name) setExpressionFn(id, name, 1)
}

export const EXPR_CODE_COUNT = 16   // wire budget: 4 bits used today (0-11), room to grow within one u8 byte
