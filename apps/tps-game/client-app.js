import { EMOTE_WHEEL_SLOTS, predictHit, COMBAT_CONFIG, isFiniteVec3 } from './shared.js'

const TRACER_RANGE = 100
const DMG_DEALT_WINDOW_MS = 500
const PREDICTED_TONE_DEDUP_MS = 400
const KILL_CREDIT_DEDUP_MIN_MS = 2500
const KILL_CREDIT_RTT_FACTOR = 2.5
const MARKER_RTT_PAD_MAX_MS = 120
const HIT_MARKER_WINDOW_MS = 150
const HEADSHOT_MARKER_WINDOW_MS = 250
const KILL_CONFIRM_WINDOW_MS = 1200
const KILL_CONFIRM_WINDOW_MAX_MS = 2200
const STREAK_WINDOW_MS = 3000
const EXPRESSION_HOLD_MS = 500
const CROSSHAIR_RECOIL_WINDOW_MS = 130
const DMG_TAKEN_WINDOW_MS = 450
const DAMAGE_FLASH_WINDOW_MS = 220
const _expressionUntil = new Map()

const rttMs = (engine) => engine?.client?.getRTT?.() || 0
const markerRttPadMs = (engine) => Math.min(MARKER_RTT_PAD_MAX_MS, rttMs(engine))
const killConfirmWindowMs = (engine) => Math.min(KILL_CONFIRM_WINDOW_MAX_MS, KILL_CONFIRM_WINDOW_MS + rttMs(engine))
const remainingMs = (now, until) => (until || 0) - now
const withinMs = (now, at, windowMs) => remainingMs(now, (at || 0) + windowMs) > 0
const hitMarkerOn = (now, tps, engine) => withinMs(now, tps?.hitMarkerTime, HIT_MARKER_WINDOW_MS + markerRttPadMs(engine))
const headshotMarkerOn = (now, tps, engine) => withinMs(now, tps?.headshotMarkerTime, HEADSHOT_MARKER_WINDOW_MS + markerRttPadMs(engine))
const killConfirmOn = (now, tps, engine) => withinMs(now, tps?.killTime, killConfirmWindowMs(engine))

const localPlayerOf = (engine) => {
  const client = engine?.client
  const playerId = engine?.playerId ?? null
  const players = client?.state?.players
  const serverMirror = Array.isArray(players) ? players.find(p => p && p.id === playerId) ?? null : null
  const predicted = client?.getLocalState?.() ?? null
  const motionRecord = predicted ?? serverMirror
  const vitalsRecord = serverMirror ?? predicted
  return {
    id: motionRecord?.id ?? playerId,
    position: isFiniteVec3(motionRecord?.position) ? motionRecord.position : null,
    velocity: isFiniteVec3(motionRecord?.velocity) ? motionRecord.velocity : null,
    onGround: motionRecord?.onGround === true,
    health: Number.isFinite(vitalsRecord?.health) ? vitalsRecord.health : COMBAT_CONFIG.health
  }
}

function mobileVibrate(engine, pattern) {
  if (!engine?.mobileControls?.enabled) return
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  navigator.vibrate(pattern)
}

const NO_STREAK = Object.freeze({ known: false, streak: null })
const streakFromWire = (wire) =>
  Number.isInteger(wire) && wire >= 1 ? Object.freeze({ known: true, streak: wire }) : NO_STREAK

function creditKill(tps, streak) {
  const now = Date.now()
  tps.killTime = now; tps.kills += 1
  if (tps.juice) tps.juice.counters.kill++
  tps.streak = streak.known ? streak.streak : (withinMs(now, tps.lastKillTime, STREAK_WINDOW_MS) ? tps.streak + 1 : 1)
  tps.lastKillTime = now
  tps.juice?.tone(420, 0.28, 0.2, 760 + Math.min(4, tps.streak - 1) * 120)
}

function adoptStreak(tps, streak) {
  if (!streak.known) return
  const now = Date.now()
  tps.streak = streak.streak
  tps.killTime = now
  tps.lastKillTime = now
}

function makeJuice() {
  const counters = { tones: [], hit: 0, headshot: 0, kill: 0, empty: 0, muted: false }
  let actx = null
  const ensure = () => {
    if (typeof window === 'undefined') return null
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)() } catch (e) { return null } }
    if (actx.state === 'suspended') { try { actx.resume() } catch (e) {} }
    return actx
  }
  const tone = (freq, dur, vol = 0.18, rampTo = freq) => {
    counters.tones.push({ freq, dur }); if (counters.muted) return
    const a = ensure(); if (!a) return
    const t0 = a.currentTime
    const osc = a.createOscillator(); const g = a.createGain()
    osc.frequency.setValueAtTime(freq, t0)
    if (rampTo !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, rampTo), t0 + dur)
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(Math.min(0.3, vol), t0 + Math.min(0.008, dur * 0.3))
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    osc.connect(g).connect(a.destination)
    osc.start(t0); osc.stop(t0 + dur + 0.02)
  }
  return { counters, tone }
}

function makeOverlay() {
  if (typeof document === 'undefined') return null
  let root = document.getElementById('tps-juice')
  if (root) return root
  root = document.createElement('div')
  root.id = 'tps-juice'
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:50;font-family:system-ui,sans-serif'
  root.innerHTML =
    '<div id="tps-cross" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(1);transition:transform .08s ease-out;width:18px;height:18px">' +
      '<span style="position:absolute;left:8px;top:0;width:2px;height:18px;background:rgba(255,255,255,.65)"></span>' +
      '<span style="position:absolute;left:0;top:8px;width:18px;height:2px;background:rgba(255,255,255,.65)"></span>' +
    '</div>' +
    '<div id="tps-hit" style="position:absolute;left:50%;top:50%;width:0;height:0;transform:translate(-50%,-50%) rotate(45deg);opacity:0;transition:opacity .05s">' +
      '<span class="hm" style="position:absolute;left:-1px;top:-13px;width:2px;height:8px"></span>' +
      '<span class="hm" style="position:absolute;left:-1px;top:5px;width:2px;height:8px"></span>' +
      '<span class="hm" style="position:absolute;left:-13px;top:-1px;width:8px;height:2px"></span>' +
      '<span class="hm" style="position:absolute;left:5px;top:-1px;width:8px;height:2px"></span>' +
    '</div>' +
    '<div id="tps-kill" style="position:absolute;left:50%;top:36%;transform:translate(-50%,-50%);color:#ffcc33;font-weight:800;font-size:34px;letter-spacing:2px;text-shadow:0 2px 8px #000;opacity:0;transition:opacity .15s"></div>' +
    '<div id="tps-dmg-dealt" style="position:absolute;left:52%;top:47%;color:#ffe27a;font-weight:700;font-size:17px;text-shadow:0 1px 3px #000;opacity:0;transition:opacity .05s"></div>' +
    '<div id="tps-dmg-taken" style="position:absolute;left:50%;top:41%;transform:translate(-50%,-50%);color:#ff7a7a;font-weight:800;font-size:24px;text-shadow:0 2px 6px #000;opacity:0;transition:opacity .1s"></div>' +
    '<div id="tps-shield" style="position:absolute;inset:0;opacity:0;transition:opacity .15s;box-shadow:inset 0 0 90px 18px rgba(80,180,255,0.45)"></div>' +
    '<div id="tps-vignette" style="position:absolute;inset:0;opacity:0;transition:opacity .12s;box-shadow:inset 0 0 140px 40px rgba(200,0,0,0.9);background:radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(160,0,0,0.35) 100%)"></div>'
  document.body.appendChild(root)
  return root
}

export const tpsGameClient = {
  _tps: null,
  setup(engine) {
    const flash = new engine.THREE.PointLight(0xffaa00, 0, 8)
    engine.scene.add(flash)
    engine._tps = { lastShootTime: 0, isAiming: false, boost: null, flash, flashOff: 0, ammo: 30, magazineSize: COMBAT_CONFIG.magazineSize, reloading: false, lastReloadTime: 0, hitMarkerTime: 0, headshotMarkerTime: 0, killTime: 0, lastKillTime: 0, kills: 0, streak: 0, reloadDuration: 2000 }
    this._tps = engine._tps
    engine._tps.juice = makeJuice()
    try { engine._tps.emoteWheel = engine.createEmoteWheel?.(EMOTE_WHEEL_SLOTS) } catch (_) {}
    engine._tps._lastEmoteDigit = 0
    const ov = engine._tps.overlay = makeOverlay()
    if (!ov) return
    engine._tps._elCross = ov.querySelector('#tps-cross')
    engine._tps._elHit = ov.querySelector('#tps-hit')
    engine._tps._elHitMarks = engine._tps._elHit ? Array.from(engine._tps._elHit.querySelectorAll('.hm')) : []
    engine._tps._elKill = ov.querySelector('#tps-kill')
    engine._tps._elDmgDealt = ov.querySelector('#tps-dmg-dealt')
    engine._tps._elDmgTaken = ov.querySelector('#tps-dmg-taken')
    engine._tps._elShield = ov.querySelector('#tps-shield')
    engine._tps._elVig = ov.querySelector('#tps-vignette')
  },
  onMouseDown(e, engine) { if (e.button === 2 && engine._tps) engine._tps.isAiming = true },
  onMouseUp(e, engine) { if (e.button === 2 && engine._tps) engine._tps.isAiming = false },
  onInput(input, engine) {
    const tps = engine._tps; if (!tps) return
    if (tps.emoteWheel) {
      const wasHeld = tps._wasEmoteWheelHeld || false
      const state = tps.emoteWheel.update(!!input.emoteWheelHeld, input.emoteDigit || 0)
      tps._lastEmoteDigit = state.digit
      if (wasHeld && !input.emoteWheelHeld && tps._lastEmoteDigit > 0) {
        const slot = EMOTE_WHEEL_SLOTS[tps._lastEmoteDigit - 1]
        if (slot) engine.client.sendEmote(slot.code)
      }
      tps._wasEmoteWheelHeld = !!input.emoteWheelHeld
    }
    if (input.reload && !tps.reloading && Date.now() - tps.lastReloadTime > 100) { tps.lastReloadTime = Date.now(); engine.client.sendReload() }
    if (input.shoot && !tps.reloading && tps.ammo > 0 && Date.now() - tps.lastShootTime > 100 / (tps.boost?.fireRate || 1)) {
      tps.lastShootTime = Date.now()
      const local = localPlayerOf(engine)
      if (local.position) {
        const pos = local.position
        const dir = engine.cam.getAimDirection(pos)
        engine.client.sendFire({ origin: [pos[0], pos[1] + 0.9, pos[2]], direction: dir })
        if (engine.cam?.punch) engine.cam.punch(0.15)
        mobileVibrate(engine, 12)
        const knockback = COMBAT_CONFIG.shootKnockback
        if (local.velocity && dir) { local.velocity[0] -= dir[0] * knockback; local.velocity[2] -= dir[2] * knockback }
        const animator = engine.players.getAnimator(engine.playerId)
        if (animator) animator.shoot()
        tps.flash.color.setHex(0xffaa00); tps.flash.position.set(pos[0], pos[1] + 0.5, pos[2]); tps.flash.intensity = 0; tps.flash.distance = 0; tps.flashOff = Date.now() + 60
        tps.ammo = Math.max(0, tps.ammo - 1)
        if (tps.juice) tps.juice.tone(160, 0.05, 0.22, 90)
        if (engine.decals) {
          const muzzle = [pos[0], pos[1] + 0.9, pos[2]]
          engine.decals.spawnTracer(muzzle, [muzzle[0] + dir[0] * TRACER_RANGE, muzzle[1] + dir[1] * TRACER_RANGE, muzzle[2] + dir[2] * TRACER_RANGE])
        }
        const pred = predictHit([pos[0], pos[1] + 0.9, pos[2]], dir, engine.client.state?.players, engine.playerId, COMBAT_CONFIG.headshotZone)
        if (pred) {
          const tnow = Date.now()
          tps.hitMarkerTime = tnow; tps._predHitAt = tnow
          if (pred.headshot) { tps.headshotMarkerTime = tnow; tps.juice?.tone(1100, 0.08, 0.2) }
          else tps.juice?.tone(820, 0.06, 0.18)
        }
        if (tps.ammo <= 3 && tps.ammo > 0 && Date.now() - (tps.lowAmmoTime || 0) > 300) { tps.lowAmmoTime = Date.now(); tps.juice?.tone(600, 0.04, 0.1) }
      }
    }
  },
  onEvent(payload, engine) {
    const tps = engine._tps
    const jz = tps?.juice?.counters ?? null
    const now = Date.now()
    if (payload.type === 'hit' && payload.target) {
      engine.players.setExpression(payload.target, 'angry', 0.6)
      const angryUntil = now + EXPRESSION_HOLD_MS
      _expressionUntil.set(payload.target, angryUntil)
      setTimeout(() => {
        if (_expressionUntil.get(payload.target) !== angryUntil) return
        _expressionUntil.delete(payload.target)
        engine.players.setExpression(payload.target, 'angry', 0)
      }, EXPRESSION_HOLD_MS)
    }
    if (payload.type === 'hit' && tps && payload.shooter === engine.playerId) {
      tps.hitMarkerTime = now
      const dmgFresh = !withinMs(now, tps.dmgDealtTime, DMG_DEALT_WINDOW_MS)
      tps.lastDamageDealt = (dmgFresh ? 0 : (tps.lastDamageDealt || 0)) + (payload.damage || 0); tps.dmgDealtTime = now
      const justPredicted = withinMs(now, tps._predHitAt, PREDICTED_TONE_DEDUP_MS)
      tps._predHitAt = 0
      if (payload.headshot) { tps.headshotMarkerTime = now; if (jz) jz.headshot++; if (!justPredicted) tps.juice?.tone(1100, 0.08, 0.2); mobileVibrate(engine, [15, 30, 15]) }
      else { if (jz) jz.hit++; if (!justPredicted) tps.juice?.tone(820, 0.06, 0.18); mobileVibrate(engine, 20) }
      if (payload.pos && tps.flash) { tps.flash.position.set(payload.pos[0], payload.pos[1], payload.pos[2]); tps.flash.color.setHex(0xffffff); tps.flash.intensity = 0; tps.flashOff = now + 80 }
      if (payload.health <= 0) { tps._killCreditVictim = payload.target; tps._killCreditAt = now; creditKill(tps, NO_STREAK) }
    }
    if (payload.type === 'hit' && tps && payload.target === engine.playerId) {
      tps.lastHitTime = Date.now(); tps.lastDamageTaken = payload.damage || 0
      mobileVibrate(engine, 35)
      const local = localPlayerOf(engine)
      if (local.velocity && payload.dir && payload.knockback) {
        local.velocity[0] += payload.dir[0] * payload.knockback
        local.velocity[2] += payload.dir[2] * payload.knockback
        engine.client.recordKnockback?.([payload.dir[0], 0, payload.dir[2]], payload.knockback, tps.lastHitTime)
      }
    }
    if (payload.type === 'hit' && tps && payload.shooter !== engine.playerId && payload.target !== engine.playerId && payload.pos) {
      const listener = localPlayerOf(engine)
      if (listener.position) {
        const d = Math.hypot(payload.pos[0] - listener.position[0], payload.pos[2] - listener.position[2])
        if (d < 60) tps.juice?.tone(140, 0.04, Math.max(0.04, 0.16 * (1 - d / 60)), 85)
      }
    }
    if (payload.type === 'world_hit' && engine.decals && payload.pos) engine.decals.spawnDecal(payload.pos, payload.normal)
    if (payload.type === 'aimpunch' && engine.cam?.punch) engine.cam.punch(payload.intensity || 0.3)
    if (payload.type === 'death' && payload.victim) engine.players.setExpression(payload.victim, 'sorrow', 1.0)
    if (payload.type === 'death' && tps && payload.killer === engine.playerId && payload.victim !== engine.playerId) {
      const dedupWin = Math.max(KILL_CREDIT_DEDUP_MIN_MS, rttMs(engine) * KILL_CREDIT_RTT_FACTOR)
      const alreadyCredited = tps._killCreditVictim === payload.victim && Date.now() - (tps._killCreditAt || 0) < dedupWin
      const streak = streakFromWire(payload.streak)
      if (!alreadyCredited) creditKill(tps, streak)
      else adoptStreak(tps, streak)
      tps._killCreditVictim = payload.victim
      tps._killCreditAt = Date.now()
      if (Number.isInteger(payload.killerKills)) tps.kills = payload.killerKills
      tps.lastKillWasHeadshot = !!payload.headshot
      tps.lastKilledPlayer = payload.killerName || 'Player'
    }
    if (payload.type === 'death' && tps && payload.victim === engine.playerId) tps.deathKiller = payload.killer || null
    if (payload.type === 'respawn' && tps) { tps.respawnFadeAt = Date.now(); tps.spawnShieldUntil = Date.now() + (payload.invulnMs || 0); if (typeof payload.ammo === 'number') tps.ammo = payload.ammo; tps.reloading = false; tps.reloadEndTime = null; tps.juice?.tone(420, 0.14, 0.16, 680) }
    if (payload.type === 'empty_click' && tps) { if (jz) jz.empty++; tps.juice?.tone(90, 0.08, 0.13) }
    if (payload.type === 'hazard_damage' && tps && payload.playerId === engine.playerId) { tps.lastHitTime = Date.now(); tps.juice?.tone(150, 0.1, 0.14) }
    if (payload.type === 'buff_applied' && tps) { tps.boost = { expiresAt: Date.now() + (payload.duration || 45) * 1000, fireRate: payload.fireRate || 1 }; tps.buffFlashAt = Date.now(); tps.juice?.tone(300, 0.18, 0.16, 600) }
    if (payload.type === 'buff_expired' && tps) { tps.boost = null; tps.juice?.tone(440, 0.16, 0.12, 200) }
    if (payload.type === 'reload_start' && tps) { tps.reloading = true; tps.reloadDuration = payload.duration || 2000; tps.reloadEndTime = Date.now() + tps.reloadDuration; tps.juice?.tone(280, 0.05, 0.13); const animator = engine.players?.getAnimator(engine.playerId); if (animator) animator.reload() }
    if (payload.type === 'reload_complete' && tps) { tps.reloading = false; tps.reloadEndTime = null; tps.ammo = payload.ammo ?? tps.magazineSize ?? 30; tps.juice?.tone(520, 0.05, 0.14) }
  },
  onFrame(dt, engine) {
    const tps = engine._tps; if (!tps) return
    const now = Date.now()
    engine.hud?.stat?.('ammo', `${tps.ammo}/${tps.magazineSize || 30}`)
    engine.hud?.stat?.('reloading', tps.reloading)
    if (tps.boost && remainingMs(now, tps.boost.expiresAt) <= 0) tps.boost = null
    if (tps.flash && tps.flashOff && remainingMs(now, tps.flashOff) <= 0) { tps.flash.intensity = 0; tps.flashOff = 0 }
    engine.players.setAiming(engine.playerId, tps.isAiming)
    const ov = tps.overlay; if (!ov) return
    const cross = tps._elCross
    if (cross) {
      const scale = withinMs(now, tps.lastShootTime, CROSSHAIR_RECOIL_WINDOW_MS) ? 1.6 : 1
      if (tps._lastCrossScale !== scale) { tps._lastCrossScale = scale; cross.style.transform = 'translate(-50%,-50%) scale(' + scale + ')' }
    }
    const hit = tps._elHit
    if (hit) {
      const onHs = headshotMarkerOn(now, tps, engine)
      const onHit = hitMarkerOn(now, tps, engine)
      const hitOn = (onHit || onHs) ? '1' : '0'
      if (tps._lastHitOn !== hitOn) { tps._lastHitOn = hitOn; hit.style.opacity = hitOn }
      const col = onHs ? '#ffcc33' : '#ffffff'
      if (tps._lastHitCol !== col) { tps._lastHitCol = col; for (const m of tps._elHitMarks) m.style.background = col }
    }
    const kill = tps._elKill
    if (kill) {
      const onKill = killConfirmOn(now, tps, engine)
      const streak = tps.streak
      const killText = onKill ? (streak >= 4 ? 'MULTI KILL' : streak === 3 ? 'TRIPLE KILL' : streak === 2 ? 'DOUBLE KILL' : 'KILL') : ''
      if (tps._lastKillText !== killText) { tps._lastKillText = killText; kill.textContent = killText; kill.style.opacity = onKill ? '1' : '0' }
    }
    const dd = tps._elDmgDealt
    if (dd) { const on = withinMs(now, tps.dmgDealtTime, DMG_DEALT_WINDOW_MS); const t = on ? ('+' + (tps.lastDamageDealt || 0)) : ''; if (tps._lastDdText !== t) { tps._lastDdText = t; dd.textContent = t; dd.style.opacity = on ? '1' : '0' } }
    const dtk = tps._elDmgTaken
    if (dtk) { const on = withinMs(now, tps.lastHitTime, DMG_TAKEN_WINDOW_MS); const t = on && tps.lastDamageTaken ? ('-' + tps.lastDamageTaken) : ''; if (tps._lastDtkText !== t) { tps._lastDtkText = t; dtk.textContent = t; dtk.style.opacity = on ? '1' : '0' } }
    const shield = tps._elShield
    if (shield) { const rem = remainingMs(now, tps.spawnShieldUntil); const op = rem > 0 ? String(Math.min(0.6, rem / COMBAT_CONFIG.spawnInvulnMs * 0.6)) : '0'; if (tps._lastShieldOp !== op) { tps._lastShieldOp = op; shield.style.opacity = op } }
    const lp = localPlayerOf(engine)
    const vig = tps._elVig
    {
      const vy = lp.velocity?.[1] ?? 0, og = lp.onGround
      if (og && tps._wasOnGround === false && (tps._fallVy || 0) < -9 && engine.cam?.punch) engine.cam.punch(0.18)
      tps._fallVy = og ? 0 : vy; tps._wasOnGround = og
    }
    if (vig) {
      const hp = lp.health
      const dmgFlash = withinMs(now, tps.lastHitTime, DAMAGE_FLASH_WINDOW_MS) ? 0.32 : 0
      const lowHp = hp > 0 && hp < 30 ? 0.12 + 0.06 * Math.sin(now / 180) : 0
      const op = String(Math.min(0.4, Math.max(dmgFlash, lowHp)))
      if (tps._lastVigOp !== op) { tps._lastVigOp = op; vig.style.opacity = op }
    }
  },
  render(ctx) {
    const h = ctx.h; if (!h) return { position: ctx.entity.position }
    const s = ctx.state || {}
    const local = localPlayerOf(ctx.engine)
    const hp = local.health
    const tps = ctx.engine?._tps
    const boostSec = tps?.boost ? Math.ceil((tps.boost.expiresAt - Date.now()) / 1000) : 0
    const ammo = tps?.ammo ?? 0
    const magazine = COMBAT_CONFIG.magazineSize
    const reloading = tps?.reloading ?? false
    const reloadDur = tps?.reloadDuration || 2000
    const reloadProgress = reloading && tps?.reloadEndTime ? Math.min(100, Math.round((1 - (tps.reloadEndTime - Date.now()) / reloadDur) * 100)) : 0
    const kills = tps?.kills ?? 0
    const now = Date.now()
    const hitMarkerActive = hitMarkerOn(now, tps, ctx.engine)
    const headshot = headshotMarkerOn(now, tps, ctx.engine)
    const killConfirm = killConfirmOn(now, tps, ctx.engine)
    const renderGameHud = ctx.kit?.renderGameHud
    return {
      position: ctx.entity.position,
      custom: { game: s.map, mode: s.mode, kills },
      ui: renderGameHud ? renderGameHud(h, { hp, ammo, magazine, reloading, reloadProgress, boostSec, kills, hitMarkerActive, headshot, killConfirm }) : null
    }
  }
}
