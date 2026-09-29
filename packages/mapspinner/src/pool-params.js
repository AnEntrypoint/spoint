import { TERRAIN_DEFAULTS as TD } from './terrain-defaults.js';

const _win = () => (typeof window !== 'undefined' ? window : null);

function _vec4(name, fallback) {
  const w = _win();
  const v = w ? w['__' + name] : null;
  return (v && v.length === 4 && Array.prototype.every.call(v, Number.isFinite)) ? v : fallback;
}

function _num(name, fallback) {
  const w = _win();
  const v = w ? w['__' + name] : null;
  return (v != null && Number.isFinite(+v)) ? +v : fallback;
}

const _spec = [0, 0, 0, 0];
const _out = { lo: TD.poolDispLo, hi: TD.poolDispHi, spec: _spec, cover: TD.poolCover };

export function resolvePoolParams() {
  _out.lo = _vec4('poolDispLo', TD.poolDispLo);
  _out.hi = _vec4('poolDispHi', TD.poolDispHi);
  _spec[0] = _num('poolSpecExpRough', TD.poolSpecExpRough);
  _spec[1] = _num('poolSpecExpSharp', TD.poolSpecExpSharp);
  _spec[2] = _num('poolSlope0', TD.poolSlope0);
  _spec[3] = _num('poolSlope1', TD.poolSlope1);
  _out.cover = _num('poolCover', TD.poolCover);
  return _out;
}

export function resolveWetness() {
  return Math.min(1, Math.max(0, _num('wetness', 0)));
}
