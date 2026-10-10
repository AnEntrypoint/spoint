import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WITNESS_NAME = 'StreamingGltfDeferredLoadQueue';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const defaultModulePath = path.resolve(repoRoot, 'packages', 'streaming-gltf', 'src', 'deferred-load-queue.js');
const defaultOutDir = path.resolve(repoRoot, '.gm', 'witness-out');

const claims = [];
const pins = [];
const warnings = [];
const output = [];

console.warn = (...parts) => {
  warnings.push(parts.map((part) => String(part)).join(' '));
};

function emit(line) {
  output.push(line);
  process.stdout.write(line + '\n');
}

function claim(title, check) {
  claims.push({ title: title, check: check });
}

function pin(title, check) {
  pins.push({ title: title, check: check });
}

function expectEqual(actual, expected, what) {
  if (!Object.is(actual, expected)) {
    throw new Error(what + ': expected ' + JSON.stringify(expected) + ' but got ' + JSON.stringify(actual));
  }
}

function expectTrue(condition, what) {
  if (!condition) {
    throw new Error(what + ': condition is false');
  }
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeAsset(url, gated) {
  const asset = { url: url, calls: [], outstanding: 0, maxOutstanding: 0, releases: [] };
  asset.ensureMeshLod = (meshDescIdx, lodIdx) => {
    asset.calls.push(meshDescIdx + ':' + lodIdx);
    asset.outstanding += 1;
    asset.maxOutstanding = Math.max(asset.maxOutstanding, asset.outstanding);
    const settle = () => {
      asset.outstanding -= 1;
      return { meshDescIdx: meshDescIdx, lodIdx: lodIdx };
    };
    if (!gated) {
      return Promise.resolve().then(settle);
    }
    return new Promise((resolve) => {
      asset.releases.push(() => resolve(settle()));
    });
  };
  return asset;
}

async function releaseOne(asset) {
  const release = asset.releases.shift();
  expectTrue(typeof release === 'function', 'a gated load is pending on ' + asset.url);
  release();
  await flush();
}

async function releaseAll(asset) {
  while (asset.releases.length > 0) {
    await releaseOne(asset);
  }
}

function dispatchedIndices(asset) {
  return asset.calls.map((call) => call.split(':')[0]).join(',');
}

function loadedCountIn(queue, url, indices) {
  return indices.filter((index) => queue.isLodLoaded(url, index, 0)).length;
}

claim('the module exports DeferredLoadQueue with the queue methods', (api) => {
  expectEqual(typeof api.DeferredLoadQueue, 'function', 'DeferredLoadQueue export type');
  const queue = new api.DeferredLoadQueue();
  ['queueLoad', 'isLodLoaded', 'getLoadedLods', 'unloadLod', 'getStats', 'updatePriorities'].forEach((name) => {
    expectEqual(typeof queue[name], 'function', 'method ' + name);
  });
});

claim('a default queue has concurrency 2, queue size 50, a 5000 ms timeout and empty counters', (api) => {
  const queue = new api.DeferredLoadQueue();
  const stats = queue.getStats();
  expectEqual(stats.maxConcurrency, 2, 'maxConcurrency');
  expectEqual(queue.maxQueueSize, 50, 'maxQueueSize');
  expectEqual(queue.requestTimeoutMs, 5000, 'requestTimeoutMs');
  expectEqual(stats.queued, 0, 'queued');
  expectEqual(stats.inFlight, 0, 'inFlight');
  expectEqual(stats.totalLoaded, 0, 'totalLoaded');
  expectEqual(stats.dropped, 0, 'dropped');
  expectEqual(stats.avgLoadTimeMs, '0.0', 'avgLoadTimeMs');
});

claim('zero, negative and NaN constructor arguments clamp to 1, 1 and 1000 ms with one warning each', (api) => {
  const queue = new api.DeferredLoadQueue(0, -1, Number.NaN);
  expectEqual(queue.maxConcurrent, 1, 'clamped maxConcurrent');
  expectEqual(queue.maxQueueSize, 1, 'clamped maxQueueSize');
  expectEqual(queue.requestTimeoutMs, 1000, 'clamped requestTimeoutMs');
  expectEqual(warnings.length, 3, 'clamp warnings');
  expectTrue(warnings.every((line) => line.indexOf('clamped to') >= 0), 'clamp warning text');
});

claim('queueLoad refuses a missing asset or a missing mesh or lod index and queues nothing', (api) => {
  const queue = new api.DeferredLoadQueue(1, 50, 5000);
  const asset = makeAsset('asset://refusals', false);
  expectEqual(queue.queueLoad(null, 0, 0), false, 'null asset');
  expectEqual(queue.queueLoad(asset, null, 0), false, 'null meshDescIdx');
  expectEqual(queue.queueLoad(asset, 0, undefined), false, 'undefined lodIdx');
  expectEqual(queue.getStats().queued, 0, 'queued after refusals');
  expectEqual(asset.calls.length, 0, 'ensureMeshLod calls after refusals');
});

claim('index 0 is a valid request and an identical request is refused while the first is loading', async (api) => {
  const queue = new api.DeferredLoadQueue(1, 50, 5000);
  const asset = makeAsset('asset://zero', true);
  expectEqual(queue.queueLoad(asset, 0, 0, 0), true, 'first queueLoad(0, 0)');
  expectEqual(queue.queueLoad(asset, 0, 0, 0), false, 'second queueLoad(0, 0) while loading');
  await releaseAll(asset);
  expectEqual(queue.isLodLoaded('asset://zero', 0, 0), true, 'loaded after release');
});

claim('a key is refused while pending, while loading and once it is loaded', async (api) => {
  const queue = new api.DeferredLoadQueue(1, 50, 5000);
  const asset = makeAsset('asset://dedup', true);
  expectEqual(queue.queueLoad(asset, 0, 0, 0), true, 'first key starts loading');
  expectEqual(queue.queueLoad(asset, 0, 0, 0), false, 'same key while loading');
  expectEqual(queue.queueLoad(asset, 1, 0, 0), true, 'second key queues behind the single slot');
  expectEqual(queue.queueLoad(asset, 1, 0, 0), false, 'same key while pending');
  await releaseAll(asset);
  expectEqual(queue.queueLoad(asset, 0, 0, 0), false, 'loaded first key');
  expectEqual(queue.queueLoad(asset, 1, 0, 0), false, 'loaded second key');
  expectEqual(asset.calls.length, 2, 'ensureMeshLod calls');
});

claim('no more than maxConcurrent loads are outstanding and the totals settle after every load', async (api) => {
  const queue = new api.DeferredLoadQueue(2, 50, 5000);
  const asset = makeAsset('asset://concurrency', true);
  for (let index = 0; index < 6; index += 1) {
    expectEqual(queue.queueLoad(asset, index, 0, 0), true, 'queueLoad ' + index);
  }
  expectEqual(asset.outstanding, 2, 'outstanding loads right after queueing');
  expectEqual(queue.getStats().queued, 4, 'queued right after queueing');
  await releaseAll(asset);
  expectEqual(asset.maxOutstanding, 2, 'maximum outstanding loads');
  expectEqual(asset.calls.length, 6, 'ensureMeshLod calls');
  const stats = queue.getStats();
  expectEqual(stats.totalLoaded, 6, 'totalLoaded');
  expectEqual(stats.inFlight, 0, 'inFlight at rest');
  expectEqual(stats.queued, 0, 'queued at rest');
  const average = Number(stats.avgLoadTimeMs);
  expectTrue(Number.isFinite(average) && average >= 0, 'avgLoadTimeMs is a finite non-negative number string');
});

claim('a settled load is reported as loaded for its own asset only', async (api) => {
  const queue = new api.DeferredLoadQueue(2, 50, 5000);
  const asset = makeAsset('asset://registry', true);
  queue.queueLoad(asset, 3, 1, 0);
  queue.queueLoad(asset, 4, 0, 0);
  await releaseAll(asset);
  expectEqual(queue.isLodLoaded('asset://registry', 3, 1), true, 'loaded (3, 1)');
  expectEqual(queue.isLodLoaded('asset://registry', 4, 0), true, 'loaded (4, 0)');
  expectEqual(queue.isLodLoaded('asset://registry', 3, 0), false, 'unrequested lod of a loaded mesh');
  expectEqual(queue.isLodLoaded('asset://other', 3, 1), false, 'same indices on another asset');
  expectEqual(queue.getLoadedLods(asset).size, 2, 'getLoadedLods size');
  expectEqual(queue.getLoadedLods({ url: 'asset://unknown' }).size, 0, 'getLoadedLods for an unknown asset');
});

claim('unloadLod forgets a loaded key so the same request queues and loads again', async (api) => {
  const queue = new api.DeferredLoadQueue(1, 50, 5000);
  const asset = makeAsset('asset://unload', false);
  queue.queueLoad(asset, 0, 0, 0);
  await flush();
  expectEqual(queue.isLodLoaded('asset://unload', 0, 0), true, 'loaded before unload');
  queue.unloadLod(asset, 0, 0);
  expectEqual(queue.isLodLoaded('asset://unload', 0, 0), false, 'loaded after unload');
  expectEqual(queue.queueLoad(asset, 0, 0, 0), true, 'queueLoad after unload');
  await flush();
  expectEqual(queue.isLodLoaded('asset://unload', 0, 0), true, 'loaded after the second load');
  expectEqual(asset.calls.length, 2, 'ensureMeshLod calls across both loads');
  queue.unloadLod({ url: 'asset://never-loaded' }, 0, 0);
});

claim('a full queue drops one request per overflow, keeps maxQueueSize pending and warns once per drop', async (api) => {
  const queue = new api.DeferredLoadQueue(1, 3, 5000);
  const asset = makeAsset('asset://bounded', true);
  for (let index = 0; index < 10; index += 1) {
    expectEqual(queue.queueLoad(asset, index, 0, index), true, 'queueLoad ' + index);
  }
  const flooded = queue.getStats();
  expectEqual(flooded.queued, 3, 'queued after the flood');
  expectEqual(flooded.dropped, 6, 'dropped after the flood');
  expectEqual(warnings.length, 6, 'overflow warnings');
  expectTrue(warnings.every((line) => line.indexOf('Queue size exceeded') >= 0), 'overflow warning text');
  await releaseAll(asset);
  const indices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  expectEqual(loadedCountIn(queue, 'asset://bounded', indices), 4, 'loaded requests: one in flight and three pending');
  expectEqual(queue.getStats().totalLoaded, 4, 'totalLoaded');
  const dropped = indices.find((index) => !queue.isLodLoaded('asset://bounded', index, 0));
  expectEqual(queue.queueLoad(asset, dropped, 0, 0), true, 'a dropped request can be queued again');
  await releaseAll(asset);
  expectEqual(queue.isLodLoaded('asset://bounded', dropped, 0), true, 'the re-queued request loads');
});

claim('a queued request that outlives requestTimeoutMs is removed and never reaches ensureMeshLod', async (api) => {
  const queue = new api.DeferredLoadQueue(1, 50, 30);
  const asset = makeAsset('asset://timeout', true);
  queue.queueLoad(asset, 0, 0, 0);
  queue.queueLoad(asset, 1, 0, 0);
  await pause(90);
  const stats = queue.getStats();
  expectEqual(stats.queued, 0, 'queued after the timeout');
  expectEqual(stats.dropped, 1, 'dropped after the timeout');
  await releaseAll(asset);
  expectEqual(asset.calls.join(','), '0:0', 'calls after releasing the in-flight load');
  expectEqual(queue.isLodLoaded('asset://timeout', 1, 0), false, 'timed-out request loaded');
});

claim('a request dispatched before its timeout is not counted as dropped', async (api) => {
  const queue = new api.DeferredLoadQueue(1, 50, 30);
  const asset = makeAsset('asset://no-expiry', false);
  queue.queueLoad(asset, 0, 0, 0);
  await pause(90);
  expectEqual(queue.getStats().dropped, 0, 'dropped');
  expectEqual(queue.isLodLoaded('asset://no-expiry', 0, 0), true, 'loaded');
});

claim('updatePriorities keeps every pending request and then dispatches the nearest entity first', async (api) => {
  const queue = new api.DeferredLoadQueue(1, 50, 5000);
  const blocker = makeAsset('asset://priority-blocker', true);
  const subject = makeAsset('asset://priority', false);
  queue.queueLoad(blocker, 0, 0, 0);
  [5, 1, 9, 3].forEach((distance, position) => {
    queue.queueLoad(subject, position + 1, 0, 0, { _currentDistance: distance });
  });
  queue.updatePriorities([]);
  expectEqual(queue.getStats().queued, 4, 'queued after updatePriorities');
  await releaseAll(blocker);
  expectEqual(dispatchedIndices(subject), '2,4,1,3', 'nearest-first dispatch order');
});

claim('small pending queues dispatch the highest priority first for two insertion orders', async (api) => {
  const insertionOrders = [[1, 2, 3], [2, 3, 1]];
  for (const priorities of insertionOrders) {
    const queue = new api.DeferredLoadQueue(1, 50, 5000);
    const blocker = makeAsset('asset://order-blocker', true);
    const subject = makeAsset('asset://order', false);
    queue.queueLoad(blocker, 0, 0, 0);
    for (const priority of priorities) {
      queue.queueLoad(subject, priority, 0, priority);
    }
    await releaseAll(blocker);
    expectEqual(dispatchedIndices(subject), '3,2,1', 'dispatch order for insertion ' + priorities.join(','));
  }
});

claim('a synchronous throw from ensureMeshLod is handled like a rejection: queueLoad returns, the slot is released and the next queued load loads', async (api) => {
  const queue = new api.DeferredLoadQueue(1, 50, 5000);
  const asset = { url: 'asset://sync-throw', calls: [], ensureMeshLod: null };
  let throwNext = true;
  asset.ensureMeshLod = (meshDescIdx, lodIdx) => {
    asset.calls.push(meshDescIdx + ':' + lodIdx);
    if (throwNext) {
      throwNext = false;
      throw new Error('sync-throw');
    }
    return Promise.resolve({ meshDescIdx: meshDescIdx, lodIdx: lodIdx });
  };
  let thrown = null;
  let queued = false;
  try {
    queued = queue.queueLoad(asset, 0, 0, 0);
  } catch (error) {
    thrown = error;
  }
  expectTrue(thrown === null, 'queueLoad threw on a synchronous ensureMeshLod throw: ' + (thrown && thrown.message));
  expectEqual(queued, true, 'queueLoad result');
  await flush();
  expectEqual(queue.getStats().inFlight, 0, 'inFlight after the synchronous throw');
  expectEqual(queue.getStats().failed, 1, 'failed count after the synchronous throw');
  expectEqual(queue.queueLoad(asset, 1, 0, 0), true, 'queueLoad of the next request');
  await flush();
  expectEqual(queue.isLodLoaded('asset://sync-throw', 1, 0), true, 'the next request loaded');
  expectEqual(queue.isLodLoaded('asset://sync-throw', 0, 0), false, 'the thrown request loaded');
  expectEqual(asset.calls.join(','), '0:0,1:0', 'ensureMeshLod calls');
});

async function withManualTimers(run) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, ms) => {
    const handle = { fn: fn, ms: ms, cleared: false };
    timers.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (handle) handle.cleared = true;
  };
  try {
    await run(timers);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

function expectHeapOrder(queue, what) {
  const pending = queue._pending;
  for (let index = 1; index < pending.length; index += 1) {
    const parent = Math.floor((index - 1) / 2);
    expectTrue(pending[parent].priority >= pending[index].priority, what + ': slot ' + index + ' outranks its parent ' + parent);
  }
}

claim('a non-root request removed through its timeout path leaves a heap in priority order: the remaining requests dispatch in priority order', async (api) => {
  const priorities = [50, 80, 30, 95, 10, 70, 60, 20, 90, 40, 5, 85, 75, 15, 65];
  const top = Math.max(...priorities);
  for (const victim of priorities.filter((priority) => priority !== top)) {
    await withManualTimers(async (timers) => {
      const queue = new api.DeferredLoadQueue(1, 50, 5000);
      const blocker = makeAsset('asset://heap-timeout-blocker', true);
      const subject = makeAsset('asset://heap-timeout', false);
      queue.queueLoad(blocker, 0, 0, 0);
      priorities.forEach((priority) => {
        queue.queueLoad(subject, priority, 0, priority);
      });
      expectTrue(Math.floor(Math.log2(queue._pending.length)) >= 3, 'heap is at least three levels deep before removing ' + victim);
      expectEqual(queue.getStats().queued, priorities.length, 'queued before removing ' + victim);
      expectHeapOrder(queue, 'heap before removing ' + victim);
      const handle = timers[1 + priorities.indexOf(victim)];
      expectEqual(handle.cleared, false, 'timeout armed for ' + victim);
      handle.fn();
      expectEqual(queue.getStats().queued, priorities.length - 1, 'queued after the timeout of ' + victim);
      expectEqual(queue.getStats().dropped, 1, 'dropped after the timeout of ' + victim);
      expectHeapOrder(queue, 'heap after the timeout of ' + victim);
      await releaseAll(blocker);
      const expected = priorities.filter((priority) => priority !== victim).sort((a, b) => b - a).join(',');
      expectEqual(dispatchedIndices(subject), expected, 'dispatch order after the timeout of ' + victim);
    });
  }
});

pin('streaming-gltf-dlq-heap-splice-dispatch-order (fixed): eight pending requests dispatch in priority order 100,60,50,45,40,10,9,8', async (api) => {
  const queue = new api.DeferredLoadQueue(1, 50, 5000);
  const blocker = makeAsset('asset://pin-heap-blocker', true);
  const subject = makeAsset('asset://pin-heap', false);
  queue.queueLoad(blocker, 0, 0, 0);
  [100, 60, 10, 50, 40, 9, 8, 45].forEach((priority) => {
    queue.queueLoad(subject, priority, 0, priority);
  });
  await releaseAll(blocker);
  expectEqual(dispatchedIndices(subject), '100,60,50,45,40,10,9,8', 'priority dispatch order');
});

pin('streaming-gltf-dlq-overflow-drops-last-slot (fixed): a full queue drops the lowest-priority pending request (priority 2), so dispatch follows priority order 10,9,5 with one drop', async (api) => {
  const queue = new api.DeferredLoadQueue(1, 3, 5000);
  const blocker = makeAsset('asset://pin-overflow-blocker', true);
  const subject = makeAsset('asset://pin-overflow', false);
  queue.queueLoad(blocker, 0, 0, 0);
  [10, 2, 9].forEach((priority) => {
    queue.queueLoad(subject, priority, 0, priority);
  });
  queue.queueLoad(subject, 5, 0, 5);
  await releaseAll(blocker);
  expectEqual(dispatchedIndices(subject), '10,9,5', 'priority dispatch order after the overflow');
  expectEqual(queue.getStats().dropped, 1, 'dropped count');
});

pin('streaming-gltf-dlq-rejected-load-unhandled (fixed): a rejected ensureMeshLod is caught inside the queue, so no unhandledRejection is emitted; the in-flight slot is released, the key stays unloaded and the failure is counted in stats.failed', async (api) => {
  const queue = new api.DeferredLoadQueue(1, 50, 5000);
  const failing = { url: 'asset://pin-rejected', ensureMeshLod: () => Promise.reject(new Error('gate-rejected')) };
  const reasons = [];
  const onUnhandled = (reason) => {
    reasons.push(reason && reason.message);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    queue.queueLoad(failing, 0, 0, 0);
    await pause(5);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  expectEqual(reasons.join('|'), '', 'unhandled rejection reasons');
  expectEqual(queue.getStats().inFlight, 0, 'inFlight after the rejection');
  expectEqual(queue.isLodLoaded('asset://pin-rejected', 0, 0), false, 'loaded flag after the rejection');
  expectEqual(queue.getStats().failed, 1, 'failed count after the rejection');
});

function readFlag(argv, name) {
  const prefix = '--' + name + '=';
  const hit = argv.find((arg) => arg.indexOf(prefix) === 0);
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

function resolveModulePath(argv) {
  const flagged = readFlag(argv, 'module');
  if (flagged !== undefined) {
    return path.resolve(process.cwd(), flagged);
  }
  const positional = argv.find((arg) => arg.indexOf('--') !== 0);
  if (positional !== undefined) {
    return path.resolve(process.cwd(), positional);
  }
  return defaultModulePath;
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function labelFor(prefix, index) {
  return prefix + String(index + 1).padStart(2, '0');
}

async function runChecks(api) {
  let failedClaims = 0;
  for (let index = 0; index < claims.length; index += 1) {
    warnings.length = 0;
    try {
      await claims[index].check(api);
      emit('CLAIM ' + labelFor('C', index) + ' PASS ' + claims[index].title);
    } catch (error) {
      failedClaims += 1;
      emit('CLAIM ' + labelFor('C', index) + ' FAIL ' + claims[index].title + ' :: ' + (error && error.message));
    }
  }
  let failedPins = 0;
  for (let index = 0; index < pins.length; index += 1) {
    warnings.length = 0;
    try {
      await pins[index].check(api);
      emit('PIN ' + labelFor('K', index) + ' MATCH ' + pins[index].title);
    } catch (error) {
      failedPins += 1;
      emit('PIN ' + labelFor('K', index) + ' CHANGED ' + pins[index].title + ' :: ' + (error && error.message));
    }
  }
  return { failedClaims: failedClaims, failedPins: failedPins };
}

async function main(argv, runId) {
  const modulePath = resolveModulePath(argv);
  const moduleExists = fs.existsSync(modulePath);
  const moduleSha = moduleExists ? sha256Hex(fs.readFileSync(modulePath)) : 'none';
  emit('RUN_IDENTITY utc=' + new Date().toISOString() + ' run_id=' + runId + ' witness=' + WITNESS_NAME + ' module=' + modulePath + ' module_sha256=' + moduleSha);
  if (!moduleExists) {
    emit('MODULE_MISSING ' + modulePath);
    emit('RESULT: FAIL checks=0 failed=1 correct=0 characterized=0');
    return 1;
  }
  let api;
  try {
    api = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    emit('MODULE_LOAD_ERROR ' + (error && error.message));
    emit('RESULT: FAIL checks=0 failed=1 correct=0 characterized=0');
    return 1;
  }
  const outcome = await runChecks(api);
  const correct = claims.length;
  const characterized = pins.length;
  const failed = outcome.failedClaims + outcome.failedPins;
  emit('CLAIMS ' + (correct - outcome.failedClaims) + '/' + correct + ' passed');
  emit('PINS ' + (characterized - outcome.failedPins) + '/' + characterized + ' matched');
  emit('RESULT: ' + (failed === 0 ? 'PASS' : 'FAIL') + ' checks=' + (correct + characterized) + ' failed=' + failed + ' correct=' + correct + ' characterized=' + characterized);
  return failed === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
const compactUtc = new Date().toISOString().replace(/[-:]/g, '').replace(/\.[0-9]{3}Z$/, 'Z');
const runId = (readFlag(argv, 'run-id') || process.env.WITNESS_RUN_ID || crypto.randomUUID()).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
const outFlag = readFlag(argv, 'out');
const outPath = outFlag !== undefined
  ? path.resolve(process.cwd(), outFlag)
  : path.join(defaultOutDir, WITNESS_NAME + '-' + compactUtc + '-' + runId.slice(0, 8) + '.txt');

main(argv, runId)
  .catch((error) => {
    emit('WITNESS_ERROR ' + (error && error.message));
    emit('RESULT: FAIL checks=0 failed=1 correct=0 characterized=0');
    return 1;
  })
  .then((code) => {
    const text = output.join('\n') + '\n';
    let exitCode = code;
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, text, { flag: 'wx' });
      process.stdout.write('OUT ' + outPath + ' sha256=' + sha256Hex(Buffer.from(text, 'utf8')) + '\n');
    } catch (error) {
      process.stderr.write('OUT_WRITE_FAILED ' + (error && error.message) + '\n');
      exitCode = 1;
    }
    process.exitCode = exitCode;
  });
