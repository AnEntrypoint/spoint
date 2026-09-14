const VRAM_UNLOAD_TRIGGER_FRACTION = 0.85;
const KEEP_PRIORITY_MEDIUM = 0;
const KEEP_PRIORITY_HIGH = 1;

function keepPriorityOf(lodIdx) {
  return lodIdx === 0 ? KEEP_PRIORITY_HIGH : KEEP_PRIORITY_MEDIUM;
}

export class LodUnloadManager {
  constructor(vramBudgetMB = 200) {
    this.vramBudgetMB = vramBudgetMB;
    this.vramBudgetBytes = vramBudgetMB * 1024 * 1024;
    this._visibleEntities = new Set();
    this._invisibleEntities = new Set();
    this._unloadedLods = new Map();
    this._stats = {
      visibleCount: 0,
      invisibleCount: 0,
      unloadedCount: 0,
      freedBytes: 0,
      estimatedVramMB: 0,
    };
    this.distanceThresholdFar = 150;
    this.distanceThresholdVeryFar = 200;
  }

  markVisible(entity) {
    if (!entity) return;
    this._visibleEntities.add(entity);
    this._invisibleEntities.delete(entity);
  }

  markInvisible(entity) {
    if (!entity) return;
    this._visibleEntities.delete(entity);
    this._invisibleEntities.add(entity);
  }

  _lodKeysInUseByVisible() {
    const keys = new Set();
    for (const entity of this._visibleEntities) {
      for (const tm of entity.trackedMeshes || []) {
        keys.add(`${entity.asset.url}:mesh:${tm.meshDescIdx}:${tm.currentLod}`);
        const texState = tm.texState || [];
        for (let ti = 0; ti < texState.length; ti++) keys.add(`${entity.asset.url}:tex:${ti}:${texState[ti].currentLod}`);
      }
    }
    return keys;
  }

  _nearestInvisibleDistanceByAsset() {
    const nearest = new Map();
    for (const entity of this._invisibleEntities) {
      const d = entity._currentDistance ?? Infinity;
      const prev = nearest.get(entity.asset);
      if (prev === undefined || d < prev) nearest.set(entity.asset, d);
    }
    return nearest;
  }

  _unloadThresholdFor(lodIdx) {
    return keepPriorityOf(lodIdx) === KEEP_PRIORITY_HIGH ? this.distanceThresholdVeryFar : this.distanceThresholdFar;
  }

  _collectCandidates(asset, kind, descs, nearest, inUse, out) {
    for (let descIdx = 0; descIdx < descs.length; descIdx++) {
      const desc = descs[descIdx];
      if (!desc) continue;
      for (let lodIdx = 0; lodIdx < desc.lods.length; lodIdx++) {
        const lod = desc.lods[lodIdx];
        if (lod.inline) continue;
        if (inUse.has(`${asset.url}:${kind}:${descIdx}:${lodIdx}`)) continue;
        if (!(nearest > this._unloadThresholdFor(lodIdx))) continue;
        out.push({ asset, kind, descIdx, lodIdx, keepPriority: keepPriorityOf(lodIdx), bytes: lod.bytes || 0 });
      }
    }
  }

  _evict(c) {
    return c.kind === 'mesh' ? c.asset.evictMeshLod(c.descIdx, c.lodIdx) : c.asset.evictTexLod(c.descIdx, c.lodIdx);
  }

  scanForUnload(assets, currentVramBytes) {
    this._stats.estimatedVramMB = currentVramBytes / (1024 * 1024);
    this._stats.visibleCount = this._visibleEntities.size;
    this._stats.invisibleCount = this._invisibleEntities.size;
    this._stats.unloadedCount = 0;
    this._stats.freedBytes = 0;

    const targetBytes = this.vramBudgetBytes * VRAM_UNLOAD_TRIGGER_FRACTION;
    if (currentVramBytes < targetBytes) return 0;

    const inUse = this._lodKeysInUseByVisible();
    const nearestByAsset = this._nearestInvisibleDistanceByAsset();
    const candidates = [];
    for (const asset of assets.values()) {
      const nearest = nearestByAsset.has(asset) ? nearestByAsset.get(asset) : Infinity;
      this._collectCandidates(asset, 'mesh', asset.meshLodDescs || [], nearest, inUse, candidates);
      this._collectCandidates(asset, 'tex', asset.texLodDescs || [], nearest, inUse, candidates);
    }
    candidates.sort((a, b) => (a.keepPriority - b.keepPriority) || (b.bytes - a.bytes));

    let remaining = currentVramBytes;
    for (const c of candidates) {
      if (remaining < targetBytes) break;
      const freed = this._evict(c);
      if (freed === null) continue;
      remaining -= freed;
      this._stats.unloadedCount++;
      this._stats.freedBytes += freed;
      if (!this._unloadedLods.has(c.asset.url)) this._unloadedLods.set(c.asset.url, new Set());
      this._unloadedLods.get(c.asset.url).add(`${c.kind}:${c.descIdx}:${c.lodIdx}`);
    }
    return this._stats.freedBytes;
  }

  resetVisibility() {
    this._visibleEntities.clear();
    this._invisibleEntities.clear();
  }

  getStats() {
    return {
      visibleEntities: this._visibleEntities.size,
      invisibleEntities: this._invisibleEntities.size,
      estimatedVramMB: this._stats.estimatedVramMB.toFixed(1),
      vramBudgetMB: this.vramBudgetMB,
      unloadedCount: this._stats.unloadedCount,
      freedMB: (this._stats.freedBytes / (1024 * 1024)).toFixed(2),
    };
  }
}
