import { recordHit } from '../../src/netcode/OutlierDetector.js'

const PLAYER_HIT_ATTRIBUTION_RADIUS_SQ = 2 * 2

export function defineWeapon(spec = {}, appCtx) {
  if (!appCtx) throw new TypeError('[weapon] appCtx is required')
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : d
  const damage = num(spec.damage, 25)
  const range = num(spec.range, 100) || 100
  const magazine = num(spec.magazine, 0)
  const reloadMs = num(spec.reloadMs, 1500)
  const fireRateMs = num(spec.fireRateMs, 120)
  const headshotMult = num(spec.headshotMult, 2) || 1

  let _ammo = magazine > 0 ? magazine : Infinity
  let _lastFireAt = -Infinity
  let _reloadingUntil = 0

  const now = () => Date.now()
  const _fire = (name, arg) => { const fn = spec[name]; if (typeof fn === 'function') { try { fn(appCtx, arg) } catch (e) { appCtx.debug?.warn?.('[weapon] ' + name + ' threw: ' + e.message) } } }

  const weapon = {
    get ammo() { return _ammo === Infinity ? Infinity : _ammo },
    get magazine() { return magazine },
    get reloading() { return now() < _reloadingUntil },
    canFire() {
      if (weapon.reloading) return false
      if (now() - _lastFireAt < fireRateMs) return false
      return _ammo > 0
    },
    fire(shooterId, origin, dir, opts = {}) {
      if (weapon.reloading) return { fired: false, reason: 'reloading' }
      if (now() - _lastFireAt < fireRateMs) return { fired: false, reason: 'cooldown' }
      if (_ammo <= 0) return { fired: false, reason: 'empty' }
      _lastFireAt = now()
      if (_ammo !== Infinity) _ammo--
      _fire('onFire', { shooterId, origin, dir })
      const magazineRanDry = _ammo === 0 && magazine > 0
      if (magazineRanDry) weapon.reload(shooterId)

      const r = appCtx.raycast(origin, dir, range, opts.excludeBodyId ?? null)
      const result = { fired: true, hit: false, targetPlayerId: null, killed: false, ammo: weapon.ammo }
      if (!r || !r.hit) return result
      result.hit = true
      const hitPoint = r.position
      let victim = null
      if (hitPoint) {
        for (const p of appCtx.players.getAll()) {
          const pp = p.state?.position; if (!pp) continue
          if (p.id === shooterId) continue
          const dx = pp[0]-hitPoint[0], dy = pp[1]-hitPoint[1], dz = pp[2]-hitPoint[2]
          if (dx*dx + dy*dy + dz*dz <= PLAYER_HIT_ATTRIBUTION_RADIUS_SQ) { victim = p; break }
        }
      }
      const dmg = damage * (opts.headshot ? headshotMult : 1)
      if (victim && victim.state) {
        const before = victim.state.health ?? 100
        const after = Math.max(0, before - dmg)
        victim.state.health = after
        result.targetPlayerId = victim.id
        result.killed = before > 0 && after <= 0
        _fire('onHit', { shooterId, targetPlayerId: victim.id, targetEntityId: r.entityId, point: hitPoint, damage: dmg, killed: result.killed })
        if (result.killed) _fire('onKill', { shooterId, victimId: victim.id })
        recordHit(appCtx.eventLog, shooterId, { headshot: !!opts.headshot, timestampMs: Date.now(), targetId: victim.id })
      } else {
        _fire('onHit', { shooterId, targetPlayerId: null, targetEntityId: r.entityId, point: hitPoint, damage: dmg, killed: false })
      }
      return result
    },
    reload(shooterId) {
      if (magazine <= 0) return false
      if (weapon.reloading) return false
      _reloadingUntil = now() + reloadMs
      _fire('onReload', { shooterId })
      return true
    },
    setAmmo(n) {
      if (magazine <= 0) return _ammo
      _ammo = Math.max(0, Math.min(magazine, (typeof n === 'number' && Number.isFinite(n)) ? n : 0))
      return _ammo
    },
  }

  const _origCanFire = weapon.canFire
  weapon.canFire = () => { _finalizeReload(); return _origCanFire() }
  const _origFire = weapon.fire
  weapon.fire = (...a) => { _finalizeReload(); return _origFire(...a) }
  function _finalizeReload() {
    if (magazine > 0 && _reloadingUntil > 0 && now() >= _reloadingUntil) { _ammo = magazine; _reloadingUntil = 0 }
  }

  return weapon
}

export default defineWeapon
