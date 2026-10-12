import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = process.env.LAG_COMPENSATOR_MODULE
  ? resolve(process.env.LAG_COMPENSATOR_MODULE)
  : resolve(REPO, 'src/netcode/LagCompensator.js');
const WINDOW_ENV = 'SPOINT_LAG_HISTORY_WINDOW';
const TOL = 1e-9;
const YAW_90 = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

let measurements = 0;
const failed = [];

function same(got, want) {
  if (want === null) return got === null;
  if (typeof want === 'number') {
    return typeof got === 'number' && Math.abs(got - want) <= TOL * Math.max(1, Math.abs(want));
  }
  if (Array.isArray(want)) {
    return Array.isArray(got) && got.length === want.length && want.every((w, i) => same(got[i], w));
  }
  return Object.is(got, want);
}

function expect(claim, got, want) {
  measurements++;
  const ok = same(got, want);
  if (!ok) failed.push(claim);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${claim}`);
  if (!ok) console.log(`     want ${JSON.stringify(want)}\n     got  ${JSON.stringify(got)}`);
}

const threwName = (fn) => { try { fn(); return 'no throw' } catch (err) { return err?.name ?? 'unknown' } };

const ringTicks = (lc, id) => {
  const ring = lc.playerHistory.get(id);
  if (!ring) return [];
  const ticks = [];
  for (let i = 0; i < ring.len; i++) ticks.push(ring.buf[(ring.head + i) % ring.buf.length].tick);
  return ticks;
};

const ascending = (ticks) => ticks.every((t, i) => i === 0 || ticks[i - 1] < t);

function arm(name, fn) {
  try {
    fn();
  } catch (err) {
    expect(`${name} runs without an exception`, `threw ${err?.message ?? err}`, 'no exception');
  }
}

const yawOf = q => 2 * Math.atan2(q[1], q[3]);

function record(lc, id, tick, pos, vel = [0, 0, 0], rot = [0, 0, 0, 1]) {
  lc.recordPlayerPosition(id, pos, rot, vel, tick);
}

async function main() {
  let sha;
  try {
    sha = createHash('sha256').update(readFileSync(MODULE)).digest('hex').slice(0, 16);
  } catch (err) {
    console.log(`RESULT: FAIL -- module source unreadable at ${MODULE}: ${err?.message ?? err}`);
    return 1;
  }
  console.log(`[lag-compensator] module=${MODULE} sha256_16=${sha}`);
  let LagCompensator;
  try {
    ({ LagCompensator } = await import(pathToFileURL(MODULE).href));
  } catch (err) {
    console.log(`RESULT: FAIL -- module failed to load: ${err?.message ?? err}`);
    return 1;
  }
  let hitscan;
  try {
    hitscan = await import(pathToFileURL(resolve(REPO, 'src/netcode/Hitscan.js')).href);
  } catch (err) {
    console.log(`RESULT: FAIL -- Hitscan module failed to load: ${err?.message ?? err}`);
    return 1;
  }

  arm('export', () => {
    expect('module exports LagCompensator as a class', typeof LagCompensator, 'function');
  });

  arm('window arithmetic', () => {
    const saved = process.env[WINDOW_ENV];
    delete process.env[WINDOW_ENV];
    try {
      const dflt = new LagCompensator();
      expect('default historyWindow is 1000 ms when SPOINT_LAG_HISTORY_WINDOW is unset', dflt.historyWindow, 1000);
      expect('default tickRate is 60 Hz', dflt.tickRate, 60);
      expect('default windowTicks is 60 (1000 ms at 60 Hz)', dflt.windowTicks, 60);
      expect('a fresh instance tracks no players', dflt.getStats().trackedPlayers, 0);
      expect('a fresh instance has latestTick 0', dflt.latestTick, 0);
      process.env[WINDOW_ENV] = '250';
      const fromEnv = new LagCompensator();
      expect('SPOINT_LAG_HISTORY_WINDOW=250 sets historyWindow to 250 ms', fromEnv.historyWindow, 250);
      expect('SPOINT_LAG_HISTORY_WINDOW=250 at 60 Hz gives windowTicks 15', fromEnv.windowTicks, 15);
      delete process.env[WINDOW_ENV];
      const explicit = new LagCompensator(500, 60);
      expect('historyWindow 500 ms at 60 Hz gives windowTicks 30', explicit.windowTicks, 30);
      explicit.setTickRate(30);
      expect('setTickRate(30) gives the same 500 ms window windowTicks 15', explicit.windowTicks, 15);
      explicit.setTickRate(0);
      explicit.setTickRate(-5);
      expect('setTickRate ignores zero and negative rates (tickRate stays 30)', explicit.tickRate, 30);
      expect('windowTicks is clamped to at least 1 (1 ms at 60 Hz rounds to 0)', new LagCompensator(1, 60).windowTicks, 1);
    } finally {
      if (saved === undefined) delete process.env[WINDOW_ENV];
      else process.env[WINDOW_ENV] = saved;
    }
  });

  arm('recording', () => {
    const lc = new LagCompensator(1000, 60);
    for (let t = 1; t <= 5; t++) record(lc, 'p', t, [t, 0, 0]);
    expect('five distinct ticks retain five samples', lc.getStats().totalSamples, 5);
    expect('latestTick follows the newest recorded tick', lc.latestTick, 5);
    record(lc, 'p', 5, [50, 0, 0]);
    expect('re-recording the newest tick overwrites instead of appending', lc.getStats().totalSamples, 5);
    expect('the overwritten sample holds the second position', lc.rewindAtTick('p', 5).position[0], 50);
    const live = [7, 0, 0];
    record(lc, 'c', 1, live);
    live[0] = 999;
    expect('recording copies position values (a later caller mutation does not leak in)', lc.rewindAtTick('c', 1).position[0], 7);

    const trimmed = new LagCompensator(1000, 60);
    for (let t = 0; t <= 200; t++) record(trimmed, 'p', t, [t, 0, 0]);
    expect('a 60-tick window at tick 200 retains ticks 139..200 (62 samples, oldest = 200-60-1)', trimmed.getStats().totalSamples, 62);
    expect('rewinding past the window clamps to the oldest retained sample (tick 139)', trimmed.rewindAtTick('p', 100).position[0], 139);

    const capped = new LagCompensator(1e9, 60);
    for (let t = 1; t <= 300; t++) record(capped, 'p', t, [t, 0, 0]);
    expect('the ring holds at most 256 samples per player', capped.getStats().totalSamples, 256);
    expect('after 300 records the oldest retained sample is tick 45', capped.rewindAtTick('p', 1).position[0], 45);
  });

  arm('recordPlayerPosition tick order', () => {
    const lc = new LagCompensator(1000, 60);
    for (const [t, x] of [[0, 0], [1, 10], [2, 20], [5, 50], [4, 999], [6, 60]]) record(lc, 'p', t, [x, 0, 0]);
    expect('the ring stays ascending by tick across an out-of-order record', ringTicks(lc, 'p'), [0, 1, 2, 4, 5, 6]);
    expect('a tick recorded out of order rewinds to its own sample', lc.rewindAtTick('p', 4).position, [999, 0, 0]);
    expect('the sample above an out-of-order tick is untouched', lc.rewindAtTick('p', 5).position, [50, 0, 0]);
    expect('the newest tick still rewinds to the newest sample', lc.rewindAtTick('p', 6).position, [60, 0, 0]);
    let skipped = 0;
    for (const [t, x] of [[0, 0], [1, 10], [2, 20], [4, 999], [5, 50], [6, 60]]) if (lc.rewindAtTick('p', t).position[0] !== x) skipped++;
    expect('every recorded tick rewinds to its own sample', skipped, 0);

    const rb = new LagCompensator(1000, 60);
    for (let t = 1; t <= 10; t++) record(rb, 'p', t, [t, 0, 0]);
    for (let t = 5; t <= 10; t++) record(rb, 'p', t, [t * 100, 0, 0]);
    expect('a re-simulation re-records its ticks in place instead of appending', rb.getStats().totalSamples, 10);
    expect('a re-simulated tick holds the corrected position', rb.rewindAtTick('p', 7).position, [700, 0, 0]);
    expect('the ring is still ascending after a re-simulation', ascending(ringTicks(rb, 'p')), true);

    const wrap = new LagCompensator(1e9, 60);
    for (let t = 1; t <= 300; t++) record(wrap, 'p', t, [t, 0, 0]);
    record(wrap, 'p', 40, [-1, 0, 0]);
    expect('a tick below the oldest retained sample enters a wrapped ring in order', ringTicks(wrap, 'p')[0], 40);
    expect('the wrapped ring is still ascending', ascending(ringTicks(wrap, 'p')), true);
    expect('the wrapped ring still holds 256 samples', wrap.getStats().totalSamples, 256);

    expect('a non-finite tick is a caller error, not a silent value', threwName(() => record(lc, 'p', NaN, [0, 0, 0])), 'RangeError');
    expect('a string tick is a caller error, not a silent value', threwName(() => record(lc, 'p', '7', [0, 0, 0])), 'RangeError');
    const fresh = new LagCompensator(1000, 60);
    expect('a non-finite tick is refused before the player is tracked', threwName(() => record(fresh, 'p', NaN, [0, 0, 0])), 'RangeError');
    expect('a refused record never tracks a new player', fresh.getStats().trackedPlayers, 0);
  });

  arm('rewindAtTick', () => {
    const lc = new LagCompensator(1000, 60);
    record(lc, 'p', 10, [10, 20, -10], [1, 0, 0], [0, 0, 0, 1]);
    record(lc, 'p', 20, [20, 40, -20], [3, 0, 0], YAW_90);
    record(lc, 'p', 30, [30, 60, -30], [5, 0, 0], YAW_90);
    expect('midpoint tick 15 interpolates position', lc.rewindAtTick('p', 15).position, [15, 30, -15]);
    expect('tick 12 (weight 0.2) interpolates position toward tick 10', lc.rewindAtTick('p', 12).position, [12, 24, -12]);
    expect('tick 27 (weight 0.7) interpolates position toward tick 30', lc.rewindAtTick('p', 27).position, [27, 54, -27]);
    expect('tick 12 interpolates velocity from 1 toward 3', lc.rewindAtTick('p', 12).velocity, [1.4, 0, 0]);
    expect('midpoint tick 15 interpolates velocity to 2', lc.rewindAtTick('p', 15).velocity, [2, 0, 0]);
    expect('midpoint tick 15 slerps yaw from 0 to 90 deg, giving 45 deg', yawOf(lc.rewindAtTick('p', 15).rotation), Math.PI / 4);
    expect('an exact sample tick returns that sample position', lc.rewindAtTick('p', 20).position, [20, 40, -20]);
    expect('an exact sample tick returns that sample velocity', lc.rewindAtTick('p', 20).velocity, [3, 0, 0]);
    expect('a tick past the newest sample clamps to the newest state (no extrapolation)', lc.rewindAtTick('p', 999).position, [30, 60, -30]);
    expect('a tick before the oldest sample clamps to the oldest state (no extrapolation)', lc.rewindAtTick('p', 5).position, [10, 20, -10]);
    expect('the returned sample echoes the requested tick', lc.rewindAtTick('p', 15).tick, 15);
    expect('an unknown player rewinds to null', lc.rewindAtTick('nobody', 15), null);
    const buf = { tick: -1, timestamp: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0] };
    const filled = lc.rewindAtTick('p', 15, buf);
    expect('a caller-supplied out sample is filled in place and returned', filled === buf, true);
    expect('the caller-supplied out sample holds the interpolated position', buf.position, [15, 30, -15]);

    const flip = new LagCompensator(1000, 60);
    record(flip, 'q', 1, [0, 0, 0], [0, 0, 0], [0, 0, 0, 1]);
    record(flip, 'q', 3, [0, 0, 0], [0, 0, 0], [0, 0, 0, -1]);
    expect('quaternions that differ only by sign take the short arc (same orientation stays unit)', flip.rewindAtTick('q', 2).rotation, [0, 0, 0, 1]);

    const stats = new LagCompensator(1000, 60);
    record(stats, 'p', 10, [0, 0, 0]);
    record(stats, 'p', 30, [0, 0, 0]);
    stats.rewindAtTick('p', 15);
    stats.rewindAtTick('p', 10);
    stats.rewindAtTick('nobody', 15);
    expect('rewinds counts successful rewinds only', stats.getStats().rewinds, 2);
    expect('maxRewindMs reports the deepest rewind (20 ticks at 60 Hz)', stats.getStats().maxRewindMs, 20 * 1000 / 60);
  });

  arm('rewindAtTick tick domain', () => {
    const lc = new LagCompensator(1000, 60);
    record(lc, 'p', 10, [10, 20, -10]);
    record(lc, 'p', 20, [20, 40, -20]);
    record(lc, 'p', 30, [30, 60, -30]);
    expect('a NaN tick is refused with null', lc.rewindAtTick('p', NaN), null);
    expect('an undefined tick is refused with null', lc.rewindAtTick('p', undefined), null);
    expect('an infinite tick is refused with null', lc.rewindAtTick('p', Infinity), null);
    expect('a numeric-string tick is refused with null', lc.rewindAtTick('p', '15'), null);
    expect('the four refused ticks are counted in rejected', lc.getStats().rejected, 4);
    expect('no refused tick is counted as a rewind', lc.getStats().rewinds, 0);
    const buf = { tick: -1, timestamp: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0] };
    expect('a refused tick returns null instead of filling out', lc.rewindAtTick('p', NaN, buf), null);
    expect('the caller out sample is left untouched by a refused tick', buf.tick, -1);
    expect('a tick below the oldest sample still clamps to the oldest state', lc.rewindAtTick('p', -100).position, [10, 20, -10]);
    expect('a clamped tick echoes the requested tick', lc.rewindAtTick('p', -100).tick, -100);
    expect('an untracked player with a finite tick is still null', lc.rewindAtTick('nobody', 15), null);
    expect('an untracked player with a finite tick is not counted as rejected', lc.getStats().rejected, 5);
    expect('getPlayerStateAtTime with a NaN millisAgo is refused with null', lc.getPlayerStateAtTime('p', NaN), null);
    expect('the refused millisAgo is counted in rejected', lc.getStats().rejected, 6);
  });

  arm('resolveViewTick', () => {
    const lc = new LagCompensator(1000, 60);
    expect('a NaN view tick is rejected', lc.resolveViewTick(NaN, 100), null);
    expect('a non-number view tick is rejected', lc.resolveViewTick('12', 100), null);
    expect('an infinite view tick is rejected', lc.resolveViewTick(Infinity, 100), null);
    expect('a view tick more than one tick ahead is rejected', lc.resolveViewTick(102, 100), null);
    expect('a view tick one tick ahead is accepted and capped at the current tick', lc.resolveViewTick(101, 100), 100);
    expect('a view tick older than the window is clamped to the oldest allowed tick (100-60=40)', lc.resolveViewTick(30, 100), 40);
    expect('a view tick exactly at the oldest allowed tick is kept', lc.resolveViewTick(40, 100), 40);
    expect('a view tick inside the window is kept', lc.resolveViewTick(70, 100), 70);
    expect('a view tick equal to the current tick is kept', lc.resolveViewTick(100, 100), 100);
    expect('resolving a view tick before any tick pass has opened is a caller error, not a silent value', threwName(() => lc.resolveViewTick(1)), 'RangeError');
    lc.beginTick(100);
    expect('currentTick defaults to the open tick pass (100): tick 1 is clamped to the oldest allowed tick (40)', lc.resolveViewTick(1), 40);
    expect('currentTick defaults to the open tick pass (100): tick 102 is rejected as future', lc.resolveViewTick(102), null);
    expect('rejected counts NaN, string, Infinity, future 102 explicit and future 102 by default', lc.getStats().rejected, 5);
    expect('clamped counts the stale view ticks 30 and 1', lc.getStats().clamped, 2);
  });

  arm('resolveViewTick arrival order', () => {
    const build = (order) => {
      const lc = new LagCompensator(1000, 60);
      lc.beginTick(6);
      for (const [id, tick, x] of order) record(lc, id, tick, [x, 0, 0]);
      lc.beginTick(6);
      return lc;
    };
    const threw = threwName;

    const a56 = build([['a', 5, 50], ['a', 6, 60]]);
    const a65 = build([['a', 6, 60], ['a', 5, 50]]);
    expect('{A@5,A@6} resolves one viewTick in both arrival orders', a65.resolveViewTick(6), a56.resolveViewTick(6));
    expect('that one viewTick is the newest tick of the set', a56.resolveViewTick(6), 6);
    expect('a fire one tick behind the newest resolves to that tick in both orders', a65.resolveViewTick(5), a56.resolveViewTick(5));
    expect('{A@5,A@6} rewinds to one sample in both arrival orders', a65.rewindAtTick('a', 6).position[0], a56.rewindAtTick('a', 6).position[0]);
    expect('that one sample is the tick-6 record (x 60), not the tick-5 one', a56.rewindAtTick('a', 6).position[0], 60);

    const ab = build([['a', 5, 50], ['b', 6, 60]]);
    const ba = build([['b', 6, 60], ['a', 5, 50]]);
    expect('{A@5,B@6} resolves one viewTick in both arrival orders', ba.resolveViewTick(6), ab.resolveViewTick(6));

    const lc = new LagCompensator(1000, 60);
    expect('a NaN currentTick is a caller error, not a silent value', threw(() => lc.resolveViewTick(6, NaN)), 'RangeError');
    expect('an infinite currentTick is a caller error, not a silent value', threw(() => lc.resolveViewTick(6, Infinity)), 'RangeError');
    expect('a string currentTick is a caller error, not a silent value', threw(() => lc.resolveViewTick(6, '12')), 'RangeError');
    expect('an explicit finite currentTick still resolves inside the window', lc.resolveViewTick(70, 100), 70);
  });

  arm('a fire resolves against the tick pass, not the arrival order', () => {
    const runPass = (order, shotTick) => {
      const lc = new LagCompensator(1000, 60);
      lc.beginTick(5);
      record(lc, 'a', 5, [50, 0, 0]);
      lc.beginTick(6);
      let out = null;
      for (const step of order) {
        if (step[0] === 'r') record(lc, step[1], step[2], [step[3], 0, 0]);
        else {
          const { viewTick } = hitscan.resolveFireRequest(lc, 'me', [0, 0, 0], { viewTick: shotTick });
          const { tp } = hitscan.resolveTargetPoint({ id: 'a', state: { position: [999, 0, 0] } }, lc, viewTick);
          out = { viewTick, tpX: tp[0] };
        }
      }
      return out;
    };
    const SHOT = ['s'];
    const A6 = ['r', 'a', 6, 60];
    const B6 = ['r', 'b', 6, 60];

    const p1 = runPass([SHOT, A6], 7);
    const p2 = runPass([A6, SHOT], 7);
    expect('P {A@5, shot@7, A@6} and {A@5, A@6, shot@7} resolve the same viewTick', p1.viewTick, p2.viewTick);
    expect('P: and the same rewound target point', p1.tpX, p2.tpX);
    expect('P: that viewTick is the tick-pass tick 6', p1.viewTick, 6);
    expect('P: that target point is the committed tick-5 sample (x 50)', p1.tpX, 50);

    const q1 = runPass([SHOT, B6], 7);
    const q2 = runPass([B6, SHOT], 7);
    expect('Q {A@5, shot@7, B@6} and {A@5, B@6, shot@7} resolve the same viewTick', q1.viewTick, q2.viewTick);
    expect('Q: and the same rewound target point', q1.tpX, q2.tpX);
    expect('Q: another player tick-6 record cannot move the target point', q1.tpX, 50);

    const c1 = runPass([SHOT, A6], 6);
    const c2 = runPass([A6, SHOT], 6);
    expect('C {A@5, shot@6, A@6} and {A@5, A@6, shot@6} resolve the same viewTick', c1.viewTick, c2.viewTick);
    expect('C: and the same rewound target point', c1.tpX, c2.tpX);
    expect('C: that viewTick is the tick-pass tick 6', c1.viewTick, 6);
    expect('C: that target point is the committed tick-5 sample (x 50)', c1.tpX, 50);

    const carried = new LagCompensator(1000, 60);
    carried.beginTick(5);
    record(carried, 'a', 5, [50, 0, 0]);
    carried.beginTick(6);
    record(carried, 'a', 6, [60, 0, 0]);
    expect('the tick-6 record stays invisible to the pass still recording it', carried.rewindAtTick('a', 7).position[0], 50);
    carried.beginTick(7);
    expect('the next pass commits it, so a view tick 7 rewinds to the tick-6 sample', carried.rewindAtTick('a', 7).position[0], 60);
  });

  arm('acceptRewind', () => {
    const lc = new LagCompensator();
    let burst = 0;
    for (let i = 0; i < 10; i++) if (lc.acceptRewind('a', 0)) burst++;
    expect('a fresh shooter gets a burst of 10 rewinds at one instant', burst, 10);
    expect('the 11th rewind at the same instant is refused', lc.acceptRewind('a', 0), false);
    expect('one refused rewind is counted in rateLimited', lc.getStats().rateLimited, 1);
    expect('another shooter has its own full bucket', lc.acceptRewind('b', 0), true);
    expect('100 ms later the bucket has refilled 2 tokens: first rewind accepted', lc.acceptRewind('a', 100), true);
    expect('100 ms later: second rewind accepted', lc.acceptRewind('a', 100), true);
    expect('100 ms later: third rewind refused', lc.acceptRewind('a', 100), false);
    let capped = 0;
    for (let i = 0; i < 12; i++) if (lc.acceptRewind('a', 1e6)) capped++;
    expect('after a long idle the bucket refills only to capacity 10', capped, 10);
    lc.clearPlayerHistory('a');
    expect('clearPlayerHistory forgets the shooter bucket, so it starts full again', lc.acceptRewind('a', 1e6), true);
  });

  arm('validateShotOrigin', () => {
    const lc = new LagCompensator();
    const shooter = [10, 2, -4];
    const eye = [10, 3.6, -4];
    const near = [10.5, 3.6, -4];
    expect('a client origin 0.5 m from the eye is kept', lc.validateShotOrigin(shooter, near, 1.6), near);
    expect('a client origin exactly 2 m from the eye is kept (bound is inclusive)', lc.validateShotOrigin(shooter, [10, 3.6, -2], 1.6), [10, 3.6, -2]);
    expect('a client origin 2.01 m from the eye falls back to the server eye', lc.validateShotOrigin(shooter, [10, 3.6, -1.99], 1.6), eye);
    expect('a null client origin falls back to the server eye', lc.validateShotOrigin(shooter, null, 1.6), eye);
    expect('a short client origin falls back to the server eye', lc.validateShotOrigin(shooter, [10, 3.6], 1.6), eye);
    expect('a NaN component falls back to the server eye', lc.validateShotOrigin(shooter, [10, NaN, -4], 1.6), eye);
    expect('a non-number component falls back to the server eye', lc.validateShotOrigin(shooter, ['10', 3.6, -4], 1.6), eye);
    expect('a custom maxDriftM of 0.25 rejects an origin 0.5 m away', lc.validateShotOrigin(shooter, near, 1.6, 0.25), eye);
    const kept = [10.5, 3.6, -4];
    expect('an accepted origin is returned as a fresh array, not the caller array', lc.validateShotOrigin(shooter, kept, 1.6) !== kept, true);
  });

  arm('getPlayerStateAtTime', () => {
    const lc = new LagCompensator(1000, 60);
    for (let t = 60; t <= 100; t++) record(lc, 'p', t, [t, 0, 0]);
    expect('500 ms ago at 60 Hz is 30 ticks back (tick 70)', lc.getPlayerStateAtTime('p', 500).position, [70, 0, 0]);
    expect('0 ms ago is the newest tick (100)', lc.getPlayerStateAtTime('p', 0).position, [100, 0, 0]);
    expect('100 ms ago is 6 ticks back (tick 94)', lc.getPlayerStateAtTime('p', 100).position, [94, 0, 0]);
    expect('an unknown player yields null', lc.getPlayerStateAtTime('nobody', 100), null);
    lc.setTickRate(30);
    expect('500 ms ago at 30 Hz is 15 ticks back (tick 85)', lc.getPlayerStateAtTime('p', 500).position, [85, 0, 0]);
  });

  arm('detectTeleport', () => {
    const lc = new LagCompensator(1000, 60);
    expect('no history means no teleport', lc.detectTeleport('nobody', [0, 0, 0]), false);
    record(lc, 'p', 1, [0, 0, 0]);
    expect('a single sample cannot show a teleport', lc.detectTeleport('p', [1000, 0, 0]), false);
    record(lc, 'p', 2, [0, 0, 0]);
    expect('a 49 m move is under the default 50 m threshold', lc.detectTeleport('p', [49, 0, 0]), false);
    expect('a move of exactly 50 m is not a teleport (strictly greater)', lc.detectTeleport('p', [50, 0, 0]), false);
    expect('a 50.5 m move is a teleport', lc.detectTeleport('p', [50.5, 0, 0]), true);
    expect('the distance is three-dimensional', lc.detectTeleport('p', [0, 0, -51]), true);
    expect('a custom threshold of 10 m is honoured', lc.detectTeleport('p', [11, 0, 0], 10), true);
    record(lc, 'p', 3, [1000, 0, 0]);
    expect('distance is measured from the newest sample, not the oldest', lc.detectTeleport('p', [1049, 0, 0]), false);
  });

  arm('applyChartTransfer', () => {
    const lc = new LagCompensator(1000, 60);
    const shift = {
      point(src, dst) { dst[0] = src[0] + 10; dst[1] = src[1]; dst[2] = src[2]; },
      vec(src, dst) { dst[0] = src[0] * 2; dst[1] = src[1]; dst[2] = src[2]; },
      look(yaw) { return { yaw: yaw + 0.25, pitch: 0 }; },
    };
    record(lc, 'p1', 10, [10, 0, 0], [1, 2, 3]);
    record(lc, 'p1', 20, [20, 0, 0], [4, 5, 6]);
    record(lc, 'p2', 10, [0, 0, 5], [0, 0, 1]);
    expect('applyChartTransfer reports the three stored samples it re-expressed', lc.applyChartTransfer(shift), 3);
    const s10 = lc.rewindAtTick('p1', 10);
    expect('position is re-expressed by transfer.point (+10 in x, applied once)', s10.position, [20, 0, 0]);
    expect('velocity is re-expressed by transfer.vec (x doubled)', s10.velocity, [2, 2, 3]);
    expect('yaw is re-expressed through transfer.look (0 rad -> 0.25 rad)', yawOf(s10.rotation), 0.25);
    expect('the second sample is re-expressed exactly once', lc.rewindAtTick('p1', 20).position, [30, 0, 0]);
    expect('a second player is re-expressed too', lc.rewindAtTick('p2', 10).position, [10, 0, 5]);
  });

  arm('clearPlayerHistory and getStats', () => {
    const lc = new LagCompensator(1000, 60);
    for (let t = 1; t <= 3; t++) record(lc, 'a', t, [t, 0, 0]);
    for (let t = 1; t <= 2; t++) record(lc, 'b', t, [t, 0, 0]);
    expect('getStats counts two tracked players', lc.getStats().trackedPlayers, 2);
    expect('getStats counts five retained samples in total', lc.getStats().totalSamples, 5);
    lc.clearPlayerHistory('a');
    expect('clearing a player leaves one tracked player', lc.getStats().trackedPlayers, 1);
    expect('clearing a player drops its samples (two remain)', lc.getStats().totalSamples, 2);
    expect('a cleared player rewinds to null', lc.rewindAtTick('a', 2), null);
    expect('the surviving player is untouched', lc.rewindAtTick('b', 2).position, [2, 0, 0]);

    const stale = new LagCompensator(1000, 60);
    for (let t = 1; t <= 6; t++) { stale.beginTick(t); record(stale, 'a', t, [t * 10, 0, 0]); }
    stale.beginTick(7);
    stale.clearPlayerHistory('a');
    record(stale, 'a', 3, [3, 0, 0]);
    stale.beginTick(8);
    expect('latestTick keeps its pre-clear value (this fix does not touch latestTick)', stale.latestTick, 6);
    expect('the reference a fire resolves against is the open pass tick, not the stale latestTick', stale.resolveViewTick(7), 7);
    expect('the newest retained sample is the tick-3 record, whatever latestTick says', stale.rewindAtTick('a', 1e9).position[0], 3);
  });

  if (failed.length === 0 && measurements > 0) {
    console.log(`RESULT: PASS (checks ${measurements}/${measurements}) -- LagCompensator contract, module sha256_16=${sha}`);
    return 0;
  }
  console.log(`RESULT: FAIL (checks ${measurements - failed.length}/${measurements}) -- ${failed.length} measurement(s) failed: ${failed.join(' | ')}`);
  return 1;
}

process.exitCode = await main();
