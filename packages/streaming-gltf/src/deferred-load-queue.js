const LOAD_TIME_WINDOW = 20;

export class DeferredLoadQueue {
  constructor(maxConcurrent = 2, maxQueueSize = 50, requestTimeoutMs = 5000) {
    if (!(maxConcurrent > 0)) {
      console.warn(`[deferred-queue] maxConcurrent must be >0 (got ${maxConcurrent}); clamped to 1`);
      maxConcurrent = 1;
    }
    if (!(maxQueueSize > 0)) {
      console.warn(`[deferred-queue] maxQueueSize must be >0 (got ${maxQueueSize}); clamped to 1`);
      maxQueueSize = 1;
    }
    if (!(requestTimeoutMs > 0)) {
      console.warn(`[deferred-queue] requestTimeoutMs must be >0 (got ${requestTimeoutMs}); clamped to 1000`);
      requestTimeoutMs = 1000;
    }
    this.maxConcurrent = maxConcurrent;
    this.maxQueueSize = maxQueueSize;
    this.requestTimeoutMs = requestTimeoutMs;
    this._inFlight = 0;
    this._pending = [];
    this._pending_set = new Set();
    this._loading = new Map();
    this._loadedLods = new Map();
    this._timeoutHandles = new Map();
    this._stats = {
      queued: 0,
      inFlight: 0,
      totalLoaded: 0,
      avgLoadTimeMs: 0,
      loadTimes: [],
      dropped: 0,
      failed: 0,
    };
  }

  queueLoad(asset, meshDescIdx, lodIdx, priority = 0, entity = null) {
    if (!asset || meshDescIdx == null || lodIdx == null) return false;

    const key = `${asset.url}:${meshDescIdx}:${lodIdx}`;

    const assetLoads = this._loadedLods.get(asset.url);
    if (assetLoads?.has(key)) return false;

    if (this._pending_set.has(key)) return false;

    if (this._loading.has(key)) return false;

    if (this._pending.length >= this.maxQueueSize) {
      const lowestIdx = this._lowestPriorityIndex();
      const lowest = this._pending[lowestIdx];
      if (priority <= lowest.priority) {
        this._stats.dropped++;
        console.warn(`[deferred-queue] Queue size exceeded ${this.maxQueueSize}, dropped lowest-priority LOD: ${key}`);
        return false;
      }
      this._pending_set.delete(lowest.key);
      clearTimeout(this._timeoutHandles.get(lowest.key));
      this._timeoutHandles.delete(lowest.key);
      this._removeSlot(lowestIdx);
      this._stats.dropped++;
      console.warn(`[deferred-queue] Queue size exceeded ${this.maxQueueSize}, dropped lowest-priority LOD: ${lowest.key}`);
    }

    const item = {
      asset,
      meshDescIdx,
      lodIdx,
      priority,
      entity,
      timestamp: performance.now(),
      key,
    };
    this._pending.push(item);
    this._pending_set.add(key);
    this._stats.queued = this._pending.length;

    this._bubbleUp(this._pending.length - 1);

    const timeoutId = setTimeout(() => {
      this._removeRequest(key);
      console.warn(`[deferred-queue] LOD request timed out after ${this.requestTimeoutMs}ms: ${key}`);
    }, this.requestTimeoutMs);
    this._timeoutHandles.set(key, timeoutId);

    this._processNext();

    return true;
  }

  _removeRequest(key) {
    if (!this._pending_set.has(key)) return;

    this._pending_set.delete(key);
    this._stats.dropped++;

    const idx = this._pending.findIndex(item => item.key === key);
    if (idx >= 0) {
      this._removeSlot(idx);
    }

    clearTimeout(this._timeoutHandles.get(key));
    this._timeoutHandles.delete(key);
    this._stats.queued = this._pending.length;
  }

  _processNext() {
    if (this._inFlight >= this.maxConcurrent || !this._pending.length) return;

    const item = this._popHighestPriority();
    if (!item) return;

    this._inFlight++;
    this._stats.inFlight = this._inFlight;
    const tLoad0 = performance.now();
    const key = item.key;

    clearTimeout(this._timeoutHandles.get(key));
    this._timeoutHandles.delete(key);

    const promise = item.asset.ensureMeshLod(item.meshDescIdx, item.lodIdx)
      .then((geo) => {
        const tLoad1 = performance.now();
        const loadTime = tLoad1 - item.timestamp;

        this._stats.loadTimes.push(loadTime);
        if (this._stats.loadTimes.length > LOAD_TIME_WINDOW) this._stats.loadTimes.shift();
        this._stats.avgLoadTimeMs = this._stats.loadTimes.reduce((a, b) => a + b, 0) / this._stats.loadTimes.length;
        this._stats.totalLoaded++;

        if (!this._loadedLods.has(item.asset.url)) {
          this._loadedLods.set(item.asset.url, new Set());
        }
        this._loadedLods.get(item.asset.url).add(key);

        return geo;
      })
      .catch((error) => {
        this._stats.failed++;
        console.warn(`[deferred-queue] LOD load failed: ${key}: ${error && error.message ? error.message : error}`);
      })
      .finally(() => {
        this._inFlight--;
        this._stats.inFlight = this._inFlight;
        this._loading.delete(key);
        this._processNext();
      });

    this._loading.set(key, promise);
  }

  _bubbleUp(idx) {
    if (idx <= 0) return;
    const parent = Math.floor((idx - 1) / 2);
    if (this._pending[idx].priority > this._pending[parent].priority) {
      [this._pending[idx], this._pending[parent]] = [this._pending[parent], this._pending[idx]];
      this._bubbleUp(parent);
    }
  }

  _bubbleDown(idx) {
    const left = 2 * idx + 1;
    const right = 2 * idx + 2;
    let highest = idx;

    if (left < this._pending.length && this._pending[left].priority > this._pending[highest].priority) {
      highest = left;
    }
    if (right < this._pending.length && this._pending[right].priority > this._pending[highest].priority) {
      highest = right;
    }

    if (highest !== idx) {
      [this._pending[idx], this._pending[highest]] = [this._pending[highest], this._pending[idx]];
      this._bubbleDown(highest);
    }
  }

  _popHighestPriority() {
    if (!this._pending.length) return null;

    const root = this._pending[0];
    this._pending_set.delete(root.key);
    this._removeSlot(0);
    this._stats.queued = this._pending.length;

    return root;
  }

  _removeSlot(idx) {
    const last = this._pending.pop();
    if (idx >= this._pending.length) return;
    this._pending[idx] = last;
    this._bubbleUp(idx);
    this._bubbleDown(idx);
  }

  _lowestPriorityIndex() {
    let lowest = 0;
    for (let i = 1; i < this._pending.length; i++) {
      if (this._pending[i].priority < this._pending[lowest].priority) lowest = i;
    }
    return lowest;
  }

  getLoadedLods(asset) {
    return this._loadedLods.get(asset.url) || new Set();
  }

  isLodLoaded(assetUrl, meshDescIdx, lodIdx) {
    const key = `${assetUrl}:${meshDescIdx}:${lodIdx}`;
    return this._loadedLods.get(assetUrl)?.has(key) ?? false;
  }

  unloadLod(asset, meshDescIdx, lodIdx) {
    const key = `${asset.url}:${meshDescIdx}:${lodIdx}`;
    const loads = this._loadedLods.get(asset.url);
    if (loads) {
      loads.delete(key);
    }
  }

  getStats() {
    return {
      queued: this._pending.length,
      inFlight: this._inFlight,
      totalLoaded: this._stats.totalLoaded,
      avgLoadTimeMs: this._stats.avgLoadTimeMs.toFixed(1),
      concurrency: this._inFlight,
      maxConcurrency: this.maxConcurrent,
      dropped: this._stats.dropped,
      failed: this._stats.failed,
    };
  }

  updatePriorities(entities) {
    if (!this._pending.length) return;

    for (const item of this._pending) {
      if (item.entity) {
        const dist = item.entity._currentDistance ?? Infinity;
        item.priority = -dist;
      }
    }

    for (let i = Math.floor(this._pending.length / 2) - 1; i >= 0; i--) {
      this._bubbleDown(i);
    }
  }
}
