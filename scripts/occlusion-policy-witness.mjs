import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const moduleArg = process.argv.slice(2).find((a) => a.indexOf('--module=') === 0);
const modulePath = moduleArg
  ? path.resolve(moduleArg.slice('--module='.length))
  : path.join(repoRoot, 'client', 'core', 'OcclusionPolicy.js');
const checks = [];

function canonical(value) {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value);
}

function expectEqual(name, got, want) {
  const ok = canonical(got) === canonical(want);
  checks.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ' got=' + canonical(got) + ' want=' + canonical(want));
}

function traceAdvance(policy, rec, verdicts) {
  return verdicts.map((occluded, index) => {
    const out = policy.advance(rec, index + 1, occluded);
    return { hidden: out.hidden, flipped: out.flipped, failOpen: out.failOpen };
  });
}

function column(trace, key) {
  return trace.map((step) => step[key]);
}

function staleProbe(policy, startHidden, repeats) {
  const rec = policy.ensureRecord({ hidden: startHidden });
  policy.advance(rec, 1, startHidden);
  let firstFail = -1;
  for (let k = 1; k <= repeats; k++) {
    const out = policy.advance(rec, 1, startHidden);
    if (out.failOpen && firstFail < 0) firstFail = k;
  }
  return { firstFail: firstFail, hidden: rec.hidden };
}

function rebuildProbe(policy, hidden, frames, streak) {
  const rec = policy.ensureRecord({ hidden: hidden, streak: streak || 0 });
  const out = policy.checkRebuildStaleness(rec, frames);
  return { skipQuery: out.skipQuery, failOpen: out.failOpen, hidden: rec.hidden, streak: rec.streak };
}

const DEFAULTS = {
  HIDE_STREAK: 2,
  UNHIDE_STREAK: 2,
  ENABLE_EYE_EXPIRY: false,
  EXPIRE_MIN_M: 3,
  EXPIRE_SIZE_MULT: 1.5,
  STALE_RESOLVE_FRAMES: 90,
  REBUILD_STOP_QUERY_FRAMES: 8,
  REBUILD_FAIL_OPEN_FRAMES: 16,
  ANOMALY_FRACTION: 0.3,
  ANOMALY_MIN_CANDIDATES: 32,
};
const OVERRIDE_OPTIONS = {
  hideStreak: 3,
  unhideStreak: 4,
  enableEyeExpiry: true,
  expireMinM: 5,
  expireSizeMult: 2,
  staleResolveFrames: 60,
  rebuildStopQueryFrames: 4,
  rebuildFailOpenFrames: 9,
  anomalyFraction: 0.5,
  anomalyMinCandidates: 10,
};
const OVERRIDES = {
  HIDE_STREAK: 3,
  UNHIDE_STREAK: 4,
  ENABLE_EYE_EXPIRY: true,
  EXPIRE_MIN_M: 5,
  EXPIRE_SIZE_MULT: 2,
  STALE_RESOLVE_FRAMES: 60,
  REBUILD_STOP_QUERY_FRAMES: 4,
  REBUILD_FAIL_OPEN_FRAMES: 9,
  ANOMALY_FRACTION: 0.5,
  ANOMALY_MIN_CANDIDATES: 10,
};
const ALL_FALSE_8 = [false, false, false, false, false, false, false, false];

async function main() {
  console.log('occlusion-policy-witness module=' + modulePath);
  if (!fs.existsSync(modulePath)) {
    console.log('MISSING module=' + modulePath);
    console.log('RESULT: FAIL checks=0 failed=1');
    return 1;
  }
  console.log('module_sha256=' + crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex'));
  const mod = await import(pathToFileURL(modulePath).href);
  expectEqual('export.createOcclusionPolicy.isFunction', typeof mod.createOcclusionPolicy, 'function');
  if (typeof mod.createOcclusionPolicy !== 'function') {
    console.log('RESULT: FAIL checks=' + checks.length + ' failed=' + checks.filter((c) => !c).length);
    return 1;
  }
  const create = mod.createOcclusionPolicy;
  const pDefault = create();
  const pOver = create(OVERRIDE_OPTIONS);

  for (const key of Object.keys(DEFAULTS)) {
    expectEqual('config.default.' + key, pDefault.config[key], DEFAULTS[key]);
  }
  for (const key of Object.keys(OVERRIDES)) {
    expectEqual('config.override.' + key, pOver.config[key], OVERRIDES[key]);
  }

  expectEqual('record.ensure.defaults', pDefault.ensureRecord({}), { streak: 0, unstreak: 0, hidden: false, seen: 0, staleFrames: 0, stableCount: 0 });
  expectEqual('record.ensure.keepsExisting', pDefault.ensureRecord({ streak: 5, hidden: true, seen: 9 }), { streak: 5, unstreak: 0, hidden: true, seen: 9, staleFrames: 0, stableCount: 0 });

  const gate1 = create({ stabilityGate: 1 });
  const hideRun = traceAdvance(gate1, gate1.ensureRecord({}), [true, true, true, true]);
  expectEqual('hysteresis.gate1.hide.hidden', column(hideRun, 'hidden'), [false, true, true, true]);
  expectEqual('hysteresis.gate1.hide.flipped', column(hideRun, 'flipped'), [false, true, false, false]);
  const unhideRun = traceAdvance(gate1, gate1.ensureRecord({ hidden: true }), [false, false, false, false]);
  expectEqual('hysteresis.gate1.unhide.hidden', column(unhideRun, 'hidden'), [true, false, false, false]);
  expectEqual('hysteresis.gate1.unhide.flipped', column(unhideRun, 'flipped'), [false, true, false, false]);
  const alternating = traceAdvance(gate1, gate1.ensureRecord({}), [true, false, true, false, true, false]);
  expectEqual('hysteresis.gate1.alternating.hidden', column(alternating, 'hidden'), [false, false, false, false, false, false]);
  expectEqual('hysteresis.gate1.alternating.flipped', column(alternating, 'flipped'), [false, false, false, false, false, false]);
  const sustained = traceAdvance(gate1, gate1.ensureRecord({ hidden: true }), [true, true, true]);
  expectEqual('hysteresis.gate1.sustainedHidden.hidden', column(sustained, 'hidden'), [true, true, true]);
  expectEqual('hysteresis.gate1.sustainedHidden.flipped', column(sustained, 'flipped'), [false, false, false]);
  const slow = create({ stabilityGate: 1, hideStreak: 3 });
  const slowRun = traceAdvance(slow, slow.ensureRecord({}), [true, true, true, true]);
  expectEqual('hysteresis.gate1.hideStreak3.hidden', column(slowRun, 'hidden'), [false, false, true, true]);
  expectEqual('hysteresis.gate1.hideStreak3.flipped', column(slowRun, 'flipped'), [false, false, true, false]);
  const quiet = traceAdvance(pDefault, pDefault.ensureRecord({}), ALL_FALSE_8);
  expectEqual('hysteresis.defaultGate.visibleOnly.hidden', column(quiet, 'hidden'), ALL_FALSE_8);
  expectEqual('hysteresis.defaultGate.visibleOnly.flipped', column(quiet, 'flipped'), ALL_FALSE_8);

  const gate6 = create({ stabilityGate: 6 });
  const occludedRun = (length) => Array.from({ length: length }, () => true);
  const visibleRun = (length) => Array.from({ length: length }, () => false);
  const alternatingRun = (length) => Array.from({ length: length }, (_, index) => index % 2 === 0);
  const hideAtGate2 = traceAdvance(pDefault, pDefault.ensureRecord({}), occludedRun(8));
  expectEqual('hysteresis.stabilityGate2.hide.hidden', column(hideAtGate2, 'hidden'), [false, false, true, true, true, true, true, true]);
  expectEqual('hysteresis.stabilityGate2.hide.flipped', column(hideAtGate2, 'flipped'), [false, false, true, false, false, false, false, false]);
  const singleOccluded = traceAdvance(pDefault, pDefault.ensureRecord({}), [true]);
  expectEqual('hysteresis.stabilityGate2.singleOccluded.hidden', column(singleOccluded, 'hidden'), [false]);
  const mixedRunGate2 = traceAdvance(pDefault, pDefault.ensureRecord({}), [true, true, false, true, true, true]);
  expectEqual('hysteresis.stabilityGate2.mixedRun.hidden', column(mixedRunGate2, 'hidden'), [false, false, false, false, false, true]);
  expectEqual('hysteresis.stabilityGate2.mixedRun.flipped', column(mixedRunGate2, 'flipped'), [false, false, false, false, false, true]);
  const unhideAtGate2 = traceAdvance(pDefault, pDefault.ensureRecord({ hidden: true }), visibleRun(8));
  expectEqual('hysteresis.stabilityGate2.unhide.hidden', column(unhideAtGate2, 'hidden'), [true, true, false, false, false, false, false, false]);
  expectEqual('hysteresis.stabilityGate2.unhide.flipped', column(unhideAtGate2, 'flipped'), [false, false, true, false, false, false, false, false]);
  const unhideMixedGate2 = traceAdvance(pDefault, pDefault.ensureRecord({ hidden: true }), [false, false, true, false, false, false]);
  expectEqual('hysteresis.stabilityGate2.unhideMixed.hidden', column(unhideMixedGate2, 'hidden'), [true, true, true, true, true, false]);
  const jitterAtGate2 = traceAdvance(pDefault, pDefault.ensureRecord({}), alternatingRun(8));
  expectEqual('hysteresis.stabilityGate2.jitter.hidden', column(jitterAtGate2, 'hidden'), ALL_FALSE_8);
  const hideAtGate6 = traceAdvance(gate6, gate6.ensureRecord({}), occludedRun(12));
  expectEqual('hysteresis.stabilityGate6.hide.hidden', column(hideAtGate6, 'hidden'), [false, false, false, false, false, false, true, true, true, true, true, true]);
  expectEqual('hysteresis.stabilityGate6.hide.flipped', column(hideAtGate6, 'flipped'), [false, false, false, false, false, false, true, false, false, false, false, false]);
  const belowGate6 = traceAdvance(gate6, gate6.ensureRecord({}), occludedRun(5));
  expectEqual('hysteresis.stabilityGate6.belowGate.hidden', column(belowGate6, 'hidden'), [false, false, false, false, false]);
  const unhideAtGate6 = traceAdvance(gate6, gate6.ensureRecord({ hidden: true }), visibleRun(12));
  expectEqual('hysteresis.stabilityGate6.unhide.hidden', column(unhideAtGate6, 'hidden'), [true, true, true, true, true, true, false, false, false, false, false, false]);
  expectEqual('hysteresis.stabilityGate6.unhide.flipped', column(unhideAtGate6, 'flipped'), [false, false, false, false, false, false, true, false, false, false, false, false]);
  const jitterAtGate6 = traceAdvance(gate6, gate6.ensureRecord({}), alternatingRun(12));
  expectEqual('hysteresis.stabilityGate6.jitter.hidden', column(jitterAtGate6, 'hidden'), [false, false, false, false, false, false, false, false, false, false, false, false]);

  const staleDefault = staleProbe(pDefault, true, 95);
  expectEqual('stale.default.firstFailOpenAtRepeat', staleDefault.firstFail, 91);
  expectEqual('stale.default.hiddenAfterFailOpen', staleDefault.hidden, false);
  const staleNever = staleProbe(create({ staleResolveFrames: Infinity }), true, 200);
  expectEqual('stale.infinity.firstFailOpenAtRepeat', staleNever.firstFail, -1);
  expectEqual('stale.infinity.stillHidden', staleNever.hidden, true);
  const staleSixty = staleProbe(create({ staleResolveFrames: 60 }), true, 80);
  expectEqual('stale.sixty.firstFailOpenAtRepeat', staleSixty.firstFail, 61);
  const staleVisible = staleProbe(pDefault, false, 200);
  expectEqual('stale.visibleRecord.firstFailOpenAtRepeat', staleVisible.firstFail, -1);

  const eyeOff = pDefault.ensureRecord({ hidden: true, eyeAtIssue: [0, 0, 0] });
  expectEqual('eye.disabled.noExpiry', pDefault.checkEyeExpiry(eyeOff, [100, 0, 0], 1), false);
  expectEqual('eye.disabled.stillHidden', eyeOff.hidden, true);
  const pEye = create({ enableEyeExpiry: true, expireMinM: 3, expireSizeMult: 1.5 });
  const eyeRec = pEye.ensureRecord({ hidden: true, eyeAtIssue: [0, 0, 0] });
  expectEqual('eye.enabled.at2.9.noExpiry', pEye.checkEyeExpiry(eyeRec, [2.9, 0, 0], 1), false);
  expectEqual('eye.enabled.at3.0.noExpiry', pEye.checkEyeExpiry(eyeRec, [3.0, 0, 0], 1), false);
  expectEqual('eye.enabled.at3.1.expires', pEye.checkEyeExpiry(eyeRec, [3.1, 0, 0], 1), true);
  expectEqual('eye.enabled.at3.1.unhides', eyeRec.hidden, false);
  const sized = pEye.ensureRecord({ hidden: true, eyeAtIssue: [0, 0, 0] });
  expectEqual('eye.sizeHint4.at5.9.noExpiry', pEye.checkEyeExpiry(sized, [5.9, 0, 0], 4), false);
  expectEqual('eye.sizeHint4.at6.1.expires', pEye.checkEyeExpiry(sized, [6.1, 0, 0], 4), true);
  const pure = pEye.ensureRecord({ hidden: true, eyeAtIssue: [0, 0, 0] });
  expectEqual('eye.predicate.past3.1', pEye.eyeMovedPastExpiry(pure, [3.1, 0, 0], 1), true);
  expectEqual('eye.predicate.noMutation', pure.hidden, true);
  expectEqual('eye.enabled.noIssueEye', pEye.checkEyeExpiry(pEye.ensureRecord({ hidden: true }), [100, 0, 0], 1), false);
  expectEqual('eye.enabled.notHidden', pEye.checkEyeExpiry(pEye.ensureRecord({ eyeAtIssue: [0, 0, 0] }), [100, 0, 0], 1), false);

  expectEqual('rebuild.f8.boundaryNoSkip', rebuildProbe(pDefault, true, 8), { skipQuery: false, failOpen: false, hidden: true, streak: 0 });
  expectEqual('rebuild.f9.skipQuery', rebuildProbe(pDefault, true, 9), { skipQuery: true, failOpen: false, hidden: true, streak: 0 });
  expectEqual('rebuild.f16.noFailOpenAtBoundary', rebuildProbe(pDefault, true, 16), { skipQuery: true, failOpen: false, hidden: true, streak: 0 });
  expectEqual('rebuild.f17.failOpenResetsStreak', rebuildProbe(pDefault, true, 17, 3), { skipQuery: true, failOpen: true, hidden: false, streak: 0 });
  expectEqual('rebuild.f100.visibleRecord', rebuildProbe(pDefault, false, 100), { skipQuery: true, failOpen: false, hidden: false, streak: 0 });

  expectEqual('anomaly.belowMinCandidates', pDefault.isAnomalousBatch(31, 10, 9), false);
  expectEqual('anomaly.atFractionThreshold', pDefault.isAnomalousBatch(32, 10, 3), true);
  expectEqual('anomaly.justBelowFraction', pDefault.isAnomalousBatch(32, 10, 2.9), false);
  expectEqual('anomaly.zeroLiveWeight', pDefault.isAnomalousBatch(100, 0, 5), false);
  expectEqual('anomaly.weightedAboveFraction', pDefault.isAnomalousBatch(40, 100, 30), true);
  expectEqual('anomaly.override.atThreshold', pOver.isAnomalousBatch(10, 10, 5), true);
  expectEqual('anomaly.override.justBelow', pOver.isAnomalousBatch(10, 10, 4.9), false);

  const resetRec = pDefault.ensureRecord({ hidden: true, streak: 3, unstreak: 2, staleFrames: 5, stableCount: 4, seen: 7 });
  pDefault.resetRecord(resetRec);
  expectEqual('reset.clearsVerdictState', { hidden: resetRec.hidden, streak: resetRec.streak, unstreak: resetRec.unstreak, staleFrames: resetRec.staleFrames, stableCount: resetRec.stableCount }, { hidden: false, streak: 0, unstreak: 0, staleFrames: 0, stableCount: 0 });
  expectEqual('reset.keepsSeenCounter', resetRec.seen, 7);
  const fresh = pDefault.ensureRecord({ hidden: true, staleFrames: 5, seen: 3 });
  pDefault.advance(fresh, 4, true);
  expectEqual('advance.freshResolve.clearsStaleFrames', fresh.staleFrames, 0);
  expectEqual('advance.freshResolve.recordsSeen', fresh.seen, 4);

  const failed = checks.filter((c) => !c).length;
  console.log('RESULT: ' + (failed === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' failed=' + failed);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.log('ERROR ' + ((err && err.stack) || err));
    console.log('RESULT: FAIL checks=' + checks.length + ' failed=' + (checks.filter((c) => !c).length + 1));
    process.exitCode = 1;
  }
);
