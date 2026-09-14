const DEFAULT_BROADCAST_INTERVAL_SEC = 5
const DEFAULT_DAY_LENGTH_SEC = 600
const DEFAULT_START_FRACTION = 0.3

export function createServerTimeOfDay(getConfig) {
  const _getConfig = typeof getConfig === 'function' ? getConfig : () => null
  let enabled = false
  let dayLengthSec = DEFAULT_DAY_LENGTH_SEC
  let t = DEFAULT_START_FRACTION
  let broadcastIntervalSec = DEFAULT_BROADCAST_INTERVAL_SEC
  let _initialized = false
  let _accumSec = 0

  function _resolve() {
    const cfg = _getConfig()
    const nowEnabled = !!(cfg && cfg.serverAuthoritative === true)
    if (nowEnabled && !_initialized) {
      dayLengthSec = Number.isFinite(cfg.dayLengthSec) && cfg.dayLengthSec > 0 ? cfg.dayLengthSec : DEFAULT_DAY_LENGTH_SEC
      const seed = cfg.seed
      if (seed && Number.isFinite(seed.t) && Number.isFinite(seed.atMs) && seed.dayLengthSec === dayLengthSec) {
        t = (((seed.t % 1) + 1) % 1 + (Date.now() - seed.atMs) / 1000 / dayLengthSec) % 1
        if (t < 0) t += 1
      } else {
        t = Number.isFinite(cfg.startFraction) ? ((cfg.startFraction % 1) + 1) % 1 : DEFAULT_START_FRACTION
      }
      broadcastIntervalSec = Number.isFinite(cfg.broadcastIntervalSec) && cfg.broadcastIntervalSec > 0 ? cfg.broadcastIntervalSec : DEFAULT_BROADCAST_INTERVAL_SEC
      _initialized = true
    }
    enabled = nowEnabled
  }

  function tick(dt) {
    _resolve()
    if (!enabled || !Number.isFinite(dt) || dt <= 0) return
    t += dt / dayLengthSec
    t -= Math.floor(t)
    _accumSec += dt
  }

  function shouldBroadcast() {
    if (!enabled) return false
    if (_accumSec < broadcastIntervalSec) return false
    _accumSec = 0
    return true
  }

  function getSyncPayload() { return { t, dayLengthSec } }
  function isEnabled() { _resolve(); return enabled }
  function getFraction() { return t }

  return { tick, shouldBroadcast, getSyncPayload, isEnabled, getFraction }
}
