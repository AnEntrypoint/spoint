function refusal(reasonCode, message, field = null) {
  const err = new TypeError(`[define-spec] ${message}`)
  err.reasonCode = reasonCode
  err.field = field
  return err
}

function matches(rule, value, partial) {
  if (rule.nullable && value === null) return true
  let base = false
  switch (rule.type) {
    case 'number':
      base = typeof value === 'number' && Number.isFinite(value)
        && (rule.min === undefined || (rule.exclusiveMin ? value > rule.min : value >= rule.min))
        && (rule.max === undefined || value <= rule.max)
      break
    case 'boolean': base = typeof value === 'boolean'; break
    case 'string': base = typeof value === 'string' && (!rule.nonEmpty || value.length > 0); break
    case 'function': base = typeof value === 'function'; break
    case 'array': base = Array.isArray(value) && (!rule.nonEmpty || value.length > 0); break
    case 'custom': base = rule.check(value, partial) === true; break
    default: base = false
  }
  return base && (rule.check ? rule.check(value, partial) === true : true)
}

function assertSpecShape(name, spec) {
  const proto = Object.getPrototypeOf(spec)
  if (proto !== Object.prototype && proto !== null) throw refusal('define-spec-inherited-key', `${name} spec must not carry a prototype`)
  for (const key in spec) {
    if (!Object.hasOwn(spec, key)) throw refusal('define-spec-inherited-key', `${name} spec inherited key "${key}"`, key)
  }
  for (const key of Reflect.ownKeys(spec)) {
    if (typeof key === 'symbol') throw refusal('define-spec-symbol-key', `${name} spec must not use symbol keys`)
    if (!Object.prototype.propertyIsEnumerable.call(spec, key)) throw refusal('define-spec-hidden-key', `${name} spec has hidden key "${key}"`, key)
  }
}

export function parseDefineSpec(name, spec, schema) {
  if (!schema) throw refusal('define-spec-unknown-factory', `no spec schema is registered for ${name}`)
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw refusal('define-spec-invalid', `${name} spec must be a plain object`)
  assertSpecShape(name, spec)
  for (const key of Reflect.ownKeys(spec)) {
    if (!Object.hasOwn(schema, key)) throw refusal('define-spec-unknown-key', `${name} has no spec key "${key}"`, key)
  }
  const parsed = {}
  for (const [key, rule] of Object.entries(schema)) {
    const present = Object.hasOwn(spec, key)
    if (!present || spec[key] === undefined) {
      if (rule.required) throw refusal('define-spec-missing-field', `${name} requires spec.${key}`, key)
      const fallback = typeof rule.default === 'function' ? rule.default(parsed) : rule.default
      if (fallback !== undefined) parsed[key] = fallback
      continue
    }
    const value = spec[key]
    if (!matches(rule, value, parsed)) throw refusal('define-spec-invalid-field', `${name}.${key} failed its ${rule.type} rule`, key)
    parsed[key] = value
  }
  return Object.freeze(parsed)
}

const callback = () => ({ type: 'function' })

export const DEFINE_SPEC_SCHEMAS = Object.freeze({
  weapon: Object.freeze({
    damage: { type: 'number', min: 0, default: 25 },
    range: { type: 'number', min: 0, exclusiveMin: true, default: 100 },
    magazine: { type: 'number', min: 0, default: 0 },
    reloadMs: { type: 'number', min: 0, default: 1500 },
    fireRateMs: { type: 'number', min: 0, default: 120 },
    headshotMult: { type: 'number', min: 0, exclusiveMin: true, default: 2 },
    onFire: callback(), onHit: callback(), onKill: callback(), onReload: callback(),
  }),
  pickup: Object.freeze({
    radius: { type: 'number', min: 0, default: 1.5 },
    cooldown: { type: 'number', min: 0, default: 0 },
    oneShot: { type: 'boolean', default: false },
    onCollect: { type: 'function', required: true },
  }),
  health: Object.freeze({
    max: { type: 'number', min: 0, exclusiveMin: true, required: true },
    hp: { type: 'number', min: 0, default: partial => partial.max },
    invulnMs: { type: 'number', min: 0, default: 0 },
    onDeath: callback(), onDamage: callback(), onRespawn: callback(),
  }),
  teams: Object.freeze({
    teams: { type: 'array', nonEmpty: true, required: true },
    scoreLimit: { type: 'number', min: 0, exclusiveMin: true, nullable: true },
    autoBalance: { type: 'boolean', default: true },
    broadcast: { type: 'boolean', default: true },
    channel: { type: 'string', nonEmpty: true, default: 'scoreboard' },
    colorblindSafe: { type: 'boolean', default: false },
    onAssign: callback(), onScore: callback(), onWin: callback(),
  }),
  buoyancy: Object.freeze({
    halfHeight: { type: 'number', min: 0, exclusiveMin: true, default: 0.5 },
    floatFactor: { type: 'number', min: 0, default: 1.2 },
    linearDrag: { type: 'number', min: 0, default: 2.0 },
    buoyantForce: { type: 'number', min: 0, nullable: true, default: null },
  }),
  checkpoint: Object.freeze({
    spawn: { type: 'custom', required: true, check: v => Array.isArray(v) && v.length >= 3 },
    minY: { type: 'number', default: -50 },
    radius: { type: 'number', min: 0, exclusiveMin: true, default: 3 },
    checkpoints: { type: 'array', default: () => [], check: v => v.every(c => c && typeof c === 'object' && (c.radius === undefined || (Number.isFinite(c.radius) && c.radius > 0))) },
    onCheckpoint: callback(), onRespawn: callback(),
  }),
})

export const DEFINE_SPEC_KEYS = Object.freeze({
  "defineQuestSystem": Object.freeze(["channel","inventory","onObjectiveProgress","onQuestComplete","onQuestStart","quests","stats"]),
  "defineStatsSystem": Object.freeze(["baseStats","channel","equipment","maxLevel","onLevelUp","onLoadoutSwap","startLevel","startXP","statScaling","xpPerLevel"]),
  "defineProgression": Object.freeze(["abilities","hotkeys","onLevelUp","onLevelUpTick","progressionConfig","setup","tick"]),
  "defineGameFSM": Object.freeze(["context","id","initial","states"]),
  "defineGameMode": Object.freeze(["channel","countdownMs","id","intermissionMs","messages","minPlayers","onEnd","onLobbyEnter","onLobbyTick","onRoundEnd","onRoundStart","onRoundTick","onWarmupEnter","onWarmupTick","phaseNames","roundMs","roundsPerMatch","scoring","teams","winCondition"]),
  "defineBuffStack": Object.freeze(["decayPerSec","decayTarget","maxStack"]),
  "defineShrinkingZone": Object.freeze(["affectDynamicEntities","center","curve","damagePerSec","durationSec","endRadius","onComplete","onPhaseChange","outsidePenalty","phases","pushForce","ringColor","ringHeight","showRing","startDelaySec","startRadius"]),
  "defineHealth": Object.freeze(["hp","invulnMs","max","onDamage","onDeath","onRespawn"]),
  "defineCombat": Object.freeze(["$","config","onDeath","onHit","onKill","onPowerup","onRespawn","onWorldHit","powerupRespawnMs","powerups","scoreboardKey","shotBlocked","spawnPoints"]),
  "defineFire": Object.freeze(["gameplay","onExtinguish","onIgnite","radius","role"]),
  "defineSteering": Object.freeze(["arriveRadius","clampToTerrain","separation","speed","useNavCost","yOffset"]),
  "defineCameraRig": Object.freeze(["default","distance","eyeHeight","frames","height","init","layers","loop","maxPitch","minPitch","onInput","sensitivity","targetHeight","update"]),
  "defineCheckpoint": Object.freeze(["checkpoints","minY","onCheckpoint","onRespawn","radius","spawn"]),
  "definePickup": Object.freeze(["cooldown","onCollect","oneShot","radius"]),
  "defineDestructible": Object.freeze(["debrisCount","debrisFreezeAfter","debrisImpulsePattern","debrisLifetime","debrisSettleGrace","debrisShape","fracturedAsset","fracturedPieceCount","health","impactRadius","impactThreshold","onDestroyed","onRespawn","respawnDelay"]),
  "defineSoftbody": Object.freeze(["bendSprings","cols","damping","gravity","mass","pins","rows","spacing","stiffness","substeps","wind"]),
  "defineFluid": Object.freeze(["boundary","emitRate","gasConstant","gravity","initialCount","maxParticles","restDensity","smoothingRadius","viscosity","worldY"]),
  "defineFluid3D": Object.freeze(["boundary","emitRate","gasConstant","gravity","initialCount","maxParticles","restDensity","smoothingRadius","viscosity"]),
  "defineBuoyancy": Object.freeze(["buoyantForce","floatFactor","halfHeight","linearDrag"]),
  "defineTeams": Object.freeze(["autoBalance","broadcast","channel","colorblindSafe","onAssign","onScore","onWin","scoreLimit","teams"]),
  "defineWeapon": Object.freeze(["damage","excludeBodyId","fireRateMs","headshot","headshotMult","magazine","onFire","onHit","onKill","onReload","range","reloadMs"]),
  "definePlayerInventory": Object.freeze(["catalog","channel","itemDefs","onBuy","onChange","onDrop","startCurrency","startItems"]),
  "createTween": Object.freeze(["durationMs","easingName","from","onComplete","onUpdate","to"]),
  "definePathOptions": Object.freeze(["closed", "smooth", "spacing"]),
})

export function assertDefineSpecKeys(name, spec) {
  const keys = DEFINE_SPEC_KEYS[name]
  if (!keys) throw refusal('define-spec-unknown-factory', `no spec key list is registered for ${name}`)
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw refusal('define-spec-invalid', `${name} spec must be a plain object`)
  assertSpecShape(name, spec)
  for (const key of Reflect.ownKeys(spec)) {
    if (!keys.includes(key)) throw refusal('define-spec-unknown-key', `${name} has no spec key "${key}"`, key)
  }
  return spec
}

export function assertDefineNumber(name, key, value, { min = -Infinity, exclusiveMin = false, max = Infinity } = {}) {
  if (value === undefined || value === null) return
  const ok = typeof value === 'number' && Number.isFinite(value)
    && (exclusiveMin ? value > min : value >= min)
    && value <= max
  if (!ok) throw refusal('define-spec-invalid-field', `${name}.${key} must be a finite number in its allowed range`, key)
}
