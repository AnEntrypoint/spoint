// DeferredLoadQueue — priority-based async LOD loading with concurrent throttling.
//
// Responsibilities:
//  - Queue LOD load requests with distance-based priority scoring.
//  - Limit concurrent asset fetches to a configurable max (typically 2).
//  - Track pending and loaded LODs per asset to avoid re-queuing.
//  - Expose queue stats for HUD display (pending count, load time, etc).
//
// Design:
//  - Each request is { asset, lod, priority, entity, timestamp }.
//  - Priority = negative distance (closer = higher priority).
//  - Two heaps: PENDING (sorted by priority) and IN_FLIGHT (tracks active loads).
//  - Throttle: when a load completes, pop the next item from PENDING.

export class DeferredLoadQueue {
  constructor(maxConcurrent = 2, maxQueueSize = 50, requestTimeoutMs = 5000) {
    // A non-positive maxConcurrent would permanently satisfy _processNext's
    // `this._inFlight >= this.maxConcurrent` gate (0>=0 is true), silently
    // wedging the queue forever with no error -- nothing would ever load and
    // there'd be no hint why. Clamp to a sane minimum instead of failing open.
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
    this._pending = []; // min-heap of { asset, meshDescIdx, lodIdx, priority, entity, timestamp, abortController }
    this._pending_set = new Set(); // dedup key: `assetUrl:meshDescIdx:lodIdx`
    this._loading = new Map(); // meshDescIdx:lodIdx -> Promise
    this._loadedLods = new Map(); // assetUrl -> Set of loaded lodIdxs per meshDescIdx
    this._timeoutHandles = new Map(); // key -> timeoutId
    this._stats = {
      queued: 0,
      inFlight: 0,
      totalLoaded: 0,
      avgLoadTimeMs: 0,
      loadTimes: [], // rolling window of recent load times
      dropped: 0, // dropped due to timeout or queue overflow
    };
  }

  // Enqueue a LOD for loading. Returns true if queued, false if already loaded or pending.
  queueLoad(asset, meshDescIdx, lodIdx, priority = 0, entity = null) {
    if (!asset || meshDescIdx == null || lodIdx == null) return false;

    const key = `${asset.url}:${meshDescIdx}:${lodIdx}`;

    // Check if already loaded
    const assetLoads = this._loadedLods.get(asset.url);
    if (assetLoads?.has(key)) return false;

    // Check if already in pending queue
    if (this._pending_set.has(key)) return false;

    // Check if actively loading
    if (this._loading.has(key)) return false;

    // If queue is too large, drop oldest low-priority requests
    if (this._pending.length >= this.maxQueueSize) {
      const dropped = this._pending.pop(); // remove lowest priority (heap tail)
      this._pending_set.delete(dropped.key);
      clearTimeout(this._timeoutHandles.get(dropped.key));
      this._timeoutHandles.delete(dropped.key);
      this._stats.dropped++;
      console.warn(`[deferred-queue] Queue size exceeded ${this.maxQueueSize}, dropped lowest-priority LOD: ${dropped.key}`);
      if (this._pending.length > 0) this._bubbleDown(0); // maintain heap after removal
    }

    // Add to pending queue
    const item = {
      asset,
      meshDescIdx,
      lodIdx,
      priority, // negative distance (closer = higher priority)
      entity,
      timestamp: performance.now(),
      key,
    };
    this._pending.push(item);
    this._pending_set.add(key);
    this._stats.queued = this._pending.length;

    // Re-heapify to maintain min-heap property (higher priority at root)
    this._bubbleUp(this._pending.length - 1);

    // Set timeout to drop stale request
    const timeoutId = setTimeout(() => {
      this._removeRequest(key);
      console.warn(`[deferred-queue] LOD request timed out after ${this.requestTimeoutMs}ms: ${key}`);
    }, this.requestTimeoutMs);
    this._timeoutHandles.set(key, timeoutId);

    // Try to load immediately if under concurrent limit
    this._processNext();

    return true;
  }

  // Remove a request from the queue (called by timeout or cleanup)
  _removeRequest(key) {
    if (!this._pending_set.has(key)) return;

    this._pending_set.delete(key);
    this._stats.dropped++;

    // Find and remove from heap
    const idx = this._pending.findIndex(item => item.key === key);
    if (idx >= 0) {
      this._pending.splice(idx, 1);
      if (idx < this._pending.length) this._bubbleDown(idx);
    }

    clearTimeout(this._timeoutHandles.get(key));
    this._timeoutHandles.delete(key);
    this._stats.queued = this._pending.length;
  }

  // Process next pending load if under concurrent limit
  _processNext() {
    if (this._inFlight >= this.maxConcurrent || !this._pending.length) return;

    const item = this._popHighestPriority();
    if (!item) return;

    this._inFlight++;
    this._stats.inFlight = this._inFlight;
    const tLoad0 = performance.now();
    const key = item.key;

    // Clear timeout since load is starting
    clearTimeout(this._timeoutHandles.get(key));
    this._timeoutHandles.delete(key);

    // Track this load in flight
    const promise = item.asset.ensureMeshLod(item.meshDescIdx, item.lodIdx)
      .then((geo) => {
        const tLoad1 = performance.now();
        const loadTime = tLoad1 - item.timestamp;

        // Record load time for stats
        this._stats.loadTimes.push(loadTime);
        if (this._stats.loadTimes.length > 20) this._stats.loadTimes.shift(); // rolling window
        this._stats.avgLoadTimeMs = this._stats.loadTimes.reduce((a, b) => a + b, 0) / this._stats.loadTimes.length;
        this._stats.totalLoaded++;

        // Mark as loaded
        if (!this._loadedLods.has(item.asset.url)) {
          this._loadedLods.set(item.asset.url, new Set());
        }
        this._loadedLods.get(item.asset.url).add(key);

        return geo;
      })
      .finally(() => {
        this._inFlight--;
        this._stats.inFlight = this._inFlight;
        this._loading.delete(key);
        // Process next pending load
        this._processNext();
      });

    this._loading.set(key, promise);
  }

  // Min-heap: bubble up (used when inserting)
  _bubbleUp(idx) {
    if (idx <= 0) return;
    const parent = Math.floor((idx - 1) / 2);
    if (this._pending[idx].priority > this._pending[parent].priority) {
      [this._pending[idx], this._pending[parent]] = [this._pending[parent], this._pending[idx]];
      this._bubbleUp(parent);
    }
  }

  // Min-heap: bubble down (used when removing root)
  _bubbleDown(idx) {
    const left = 2 * idx + 1;
    const right = 2 * idx + 2;
    let smallest = idx;

    if (left < this._pending.length && this._pending[left].priority > this._pending[smallest].priority) {
      smallest = left;
    }
    if (right < this._pending.length && this._pending[right].priority > this._pending[smallest].priority) {
      smallest = right;
    }

    if (smallest !== idx) {
      [this._pending[idx], this._pending[smallest]] = [this._pending[smallest], this._pending[idx]];
      this._bubbleDown(smallest);
    }
  }

  // Extract and return the highest-priority item
  _popHighestPriority() {
    if (!this._pending.length) return null;

    const root = this._pending[0];
    this._pending_set.delete(root.key);
    this._pending.splice(0, 1);
    if (this._pending.length > 0) this._bubbleDown(0);
    this._stats.queued = this._pending.length;

    return root;
  }

  // Get the list of loaded LODs for an asset
  getLoadedLods(asset) {
    return this._loadedLods.get(asset.url) || new Set();
  }

  // Check if a specific LOD is loaded
  isLodLoaded(assetUrl, meshDescIdx, lodIdx) {
    const key = `${assetUrl}:${meshDescIdx}:${lodIdx}`;
    return this._loadedLods.get(assetUrl)?.has(key) ?? false;
  }

  // Unload a LOD from memory (called by unload manager)
  unloadLod(asset, meshDescIdx, lodIdx) {
    const key = `${asset.url}:${meshDescIdx}:${lodIdx}`;
    const loads = this._loadedLods.get(asset.url);
    if (loads) {
      loads.delete(key);
    }
    // Geometry disposal is handled by the Asset itself via evictMeshLod
  }

  // Get current queue stats
  getStats() {
    return {
      queued: this._pending.length,
      inFlight: this._inFlight,
      totalLoaded: this._stats.totalLoaded,
      avgLoadTimeMs: this._stats.avgLoadTimeMs.toFixed(1),
      concurrency: this._inFlight,
      maxConcurrency: this.maxConcurrent,
      dropped: this._stats.dropped,
    };
  }

  // Update priorities for pending items based on new entity positions
  // Called when entity moves or camera changes to re-sort the queue
  updatePriorities(entities) {
    if (!this._pending.length) return;

    // Recalculate priorities based on current entity positions
    for (const item of this._pending) {
      if (item.entity) {
        const dist = item.entity._currentDistance ?? Infinity;
        item.priority = -dist; // negative distance (closer = higher priority)
      }
    }

    // Re-heapify entire array (simpler than selective bubbling)
    for (let i = Math.floor(this._pending.length / 2) - 1; i >= 0; i--) {
      this._bubbleDown(i);
    }
  }
}
