const C1 = 1.70158
const C3 = C1 + 1
const C4 = (2 * Math.PI) / 3
const C5 = (2 * Math.PI) / 4.5
const N1 = 7.5625
const D1 = 2.75

function bounceOut(t) {
  if (t < 1 / D1) return N1 * t * t
  if (t < 2 / D1) return N1 * (t -= 1.5 / D1) * t + 0.75
  if (t < 2.5 / D1) return N1 * (t -= 2.25 / D1) * t + 0.9375
  return N1 * (t -= 2.625 / D1) * t + 0.984375
}

function inOut(pair, t) {
  return t < 0.5 ? pair[0](t * 2) / 2 : pair[1]((t - 0.5) * 2) / 2 + 0.5
}

const quad = [t => t * t, t => t * (2 - t)]
const cubic = [t => t * t * t, t => 1 - (1 - t) ** 3]
const quart = [t => t ** 4, t => 1 - (1 - t) ** 4]
const quint = [t => t ** 5, t => 1 - (1 - t) ** 5]
const sine = [t => 1 - Math.cos(t * Math.PI / 2), t => Math.sin(t * Math.PI / 2)]
const expo = [
  t => t === 0 ? 0 : 2 ** (10 * t - 10),
  t => t === 1 ? 1 : 1 - 2 ** (-10 * t),
]
const circ = [t => 1 - Math.sqrt(1 - t * t), t => Math.sqrt(1 - (t - 1) ** 2)]
const back = [
  t => C3 * t ** 3 - C1 * t ** 2,
  t => 1 + C3 * (t - 1) ** 3 + C1 * (t - 1) ** 2,
]
const elastic = [
  t => t === 0 ? 0 : t === 1 ? 1 : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * C4),
  t => t === 0 ? 0 : t === 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * C4) + 1,
]

export const EASING = Object.freeze({
  linear: t => t,
  easeInQuad: quad[0],
  easeOutQuad: quad[1],
  easeInOutQuad: t => inOut(quad, t),
  easeInCubic: cubic[0],
  easeOutCubic: cubic[1],
  easeInOutCubic: t => inOut(cubic, t),
  easeInQuart: quart[0],
  easeOutQuart: quart[1],
  easeInOutQuart: t => inOut(quart, t),
  easeInQuint: quint[0],
  easeOutQuint: quint[1],
  easeInOutQuint: t => inOut(quint, t),
  easeInSine: sine[0],
  easeOutSine: sine[1],
  easeInOutSine: t => inOut(sine, t),
  easeInExpo: expo[0],
  easeOutExpo: expo[1],
  easeInOutExpo: t => t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2,
  easeInCirc: circ[0],
  easeOutCirc: circ[1],
  easeInOutCirc: t => inOut(circ, t),
  easeInBack: back[0],
  easeOutBack: back[1],
  easeInOutBack: t => t < 0.5
    ? (2 * t) ** 2 * ((C1 + 1) * 2 * t - C1) / 2
    : ((2 * t - 2) ** 2 * ((C1 + 1) * (2 * t - 2) + C1) + 2) / 2,
  easeInElastic: elastic[0],
  easeOutElastic: elastic[1],
  easeInOutElastic: t => t === 0 ? 0 : t === 1 ? 1 : t < 0.5
    ? -(2 ** (20 * t - 10)) * Math.sin((20 * t - 11.125) * C5) / 2
    : 2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * C5) / 2 + 1,
  easeInBounce: t => 1 - bounceOut(1 - t),
  easeOutBounce: bounceOut,
  easeInOutBounce: t => t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2,
})

export const EASING_NAMES = Object.freeze(Object.keys(EASING))

function refusal(code, message) {
  const err = new TypeError(`[easing] ${message}`)
  err.reasonCode = code
  return err
}

export function easing(name, t) {
  if (typeof name !== 'string' || !Object.hasOwn(EASING, name)) throw refusal('easing-unknown', `unknown easing ${JSON.stringify(name)}`)
  if (!Number.isFinite(t) || t < 0 || t > 1) throw refusal('easing-t-out-of-range', `t must be a finite number in [0,1], got ${t}`)
  return EASING[name](t)
}
