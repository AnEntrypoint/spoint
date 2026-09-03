// defineWeapon(spec, appCtx) -> a server-authoritative hitscan-weapon primitive: fire (raycast + damage),
// ammo + magazine + reload, and fire-rate cooldown. Deathmatch / TDM / gun-game / arena / zombie all
// re-implement the same "cast a ray, find who I hit, subtract HP, count ammo, block while reloading" loop;
// this wraps it once. Pure server logic over ctx.raycast + player.state.health + a fire/hit/kill event --
// nothing here draws a tracer (that is a client render() concern the events drive).
//
// spec = {
//   damage?: number,            // HP per hit (default 25)
//   range?: number,             // max hitscan distance in m (default 100)
//   magazine?: number,          // rounds per magazine; 0/undefined = infinite ammo, no reload (default 0)
//   reloadMs?: number,          // reload duration (default 1500)
//   fireRateMs?: number,        // min ms between shots (default 120)
//   headshotMult?: number,      // damage multiplier when opts.headshot is passed to fire() (default 2)
//   onFire?(ctx, { shooterId, origin, dir }),
//   onHit?(ctx, { shooterId, targetPlayerId, targetEntityId, point, damage, killed }),
//   onKill?(ctx, { shooterId, victimId }),   // fired when a hit brings a player to <= 0 HP
//   onReload?(ctx, { shooterId }),
// }
// Returns { fire(shooterId, origin, dir, opts?), reload(shooterId?), ammo, magazine, reloading,
//           canFire(), setAmmo(n) }.  fire() returns { fired, hit, targetPlayerId, killed, ammo } or a
//   { fired:false, reason } when blocked (cooldown / reloading / empty).

import { recordHit } from '../../src/netcode/OutlierDetector.js'

export function defineWeapon(spec = {}, appCtx) {
  if (!appCtx) throw new TypeError('[weapon] appCtx is required')
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : d
  const damage = num(spec.damage, 25)
  const range = num(spec.range, 100) || 100
  const magazine = num(spec.magazine, 0)          // 0 => infinite
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
    // Ready to fire? (not cooling down, not reloading, has ammo)
    canFire() {
      if (weapon.reloading) return false
      if (now() - _lastFireAt < fireRateMs) return false
      return _ammo > 0
    },
    // Fire one hitscan shot from `origin` along `dir`. opts.headshot applies headshotMult; opts.excludeBodyId
    // skips the shooter's own body. Applies damage to the hit player, fires onHit/onKill.
    fire(shooterId, origin, dir, opts = {}) {
      if (weapon.reloading) return { fired: false, reason: 'reloading' }
      if (now() - _lastFireAt < fireRateMs) return { fired: false, reason: 'cooldown' }
      if (_ammo <= 0) return { fired: false, reason: 'empty' }
      _lastFireAt = now()
      if (_ammo !== Infinity) _ammo--
      _fire('onFire', { shooterId, origin, dir })
      // auto-reload when the magazine runs dry
      if (_ammo === 0 && magazine > 0) weapon.reload(shooterId)

      const r = appCtx.raycast(origin, dir, range, opts.excludeBodyId ?? null)
      const result = { fired: true, hit: false, targetPlayerId: null, killed: false, ammo: weapon.ammo }
      if (!r || !r.hit) return result
      result.hit = true
      // Did we hit a player? Players are not entities in _physicsBodyToEntityId; match the hit point to the
      // nearest player within a small radius (the shooter-facing hitbox). Falls back to entity attribution.
      const hitPoint = r.position
      let victim = null
      if (hitPoint) {
        for (const p of appCtx.players.getAll()) {
          const pp = p.state?.position; if (!pp) continue
          if (p.id === shooterId) continue
          const dx = pp[0]-hitPoint[0], dy = pp[1]-hitPoint[1], dz = pp[2]-hitPoint[2]
          if (dx*dx + dy*dy + dz*dz <= 4) { victim = p; break }   // within 2m of the hit point
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
        // Statistical outlier flags (anticheat-server-envelope-checks, docs/anticheat.md): non-blocking,
        // operator-review-only rolling headshot%/fast-headshot-streak signal -- see OutlierDetector.js.
        // appCtx.eventLog is the AppContext getter (always present, may be null pre-runtime-init).
        recordHit(appCtx.eventLog, shooterId, { headshot: !!opts.headshot, timestampMs: Date.now(), targetId: victim.id })
      } else {
        _fire('onHit', { shooterId, targetPlayerId: null, targetEntityId: r.entityId, point: hitPoint, damage: dmg, killed: false })
      }
      return result
    },
    // Begin a reload (no-op for infinite-ammo weapons or while already reloading). Refills after reloadMs.
    reload(shooterId) {
      if (magazine <= 0) return false
      if (weapon.reloading) return false
      _reloadingUntil = now() + reloadMs
      _fire('onReload', { shooterId })
      // The refill is time-based; a caller polling .reloading sees the state, and ammo tops up on the first
      // canFire()/fire() after the window. We finalize lazily so no timer is required.
      return true
    },
    setAmmo(n) {
      if (magazine <= 0) return _ammo
      _ammo = Math.max(0, Math.min(magazine, (typeof n === 'number' && Number.isFinite(n)) ? n : 0))
      return _ammo
    },
  }

  // Lazy reload finalize: wrap canFire/fire to top up ammo once the reload window has elapsed.
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
