export const EXPR_NEUTRAL = 0
export const EXPR_HAPPY = 1
export const EXPR_SAD = 2
export const EXPR_ANGRY = 3
export const EXPR_SURPRISED = 4
export const EXPR_RELAXED = 5
export const EXPR_AA = 6
export const EXPR_IH = 7
export const EXPR_OU = 8
export const EXPR_EE = 9
export const EXPR_OH = 10
export const EXPR_BLINK = 11

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

const CODE_TO_NAME = {
  [EXPR_NEUTRAL]: null,
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

const VISEME_CODES = new Set([EXPR_AA, EXPR_IH, EXPR_OU, EXPR_EE, EXPR_OH, EXPR_BLINK])

export function nameToCode(name) { return NAME_TO_CODE[name] ?? null }

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

export function applyExpressionCode(setExpressionFn, id, code, lastCode) {
  if (lastCode != null && lastCode !== code) {
    const prevName = CODE_TO_NAME[lastCode]
    if (prevName) setExpressionFn(id, prevName, 0)
  }
  const name = CODE_TO_NAME[code]
  if (name) setExpressionFn(id, name, 1)
}

export const EXPR_CODE_COUNT = 16
