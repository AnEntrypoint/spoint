const VRAM_UNLOAD_TRIGGER_FRACTION = 0.85;
const ESTIMATED_VRAM_FRACTION_AFTER_UNLOAD = 0.9;

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

  scanForUnload(assets, currentVramBytes) {
    this._stats.estimatedVramMB = currentVramBytes / (1024 * 1024);
    this._stats.visibleCount = this._visibleEntities.size;
    this._stats.invisibleCount = this._invisibleEntities.size;

    if (currentVramBytes < this.vramBudgetBytes * VRAM_UNLOAD_TRIGGER_FRACTION) {
      return;
    }

    const inUseByVisible = new Set();
    for (const entity of this._visibleEntities) {
      for (const tm of entity.trackedMeshes || []) {
        const key = `${entity.asset.url}:${tm.meshDescIdx}:${tm.currentLod}`;
        inUseByVisible.add(key);
      }
    }

    let unloadedCount = 0;
    for (const asset of assets.values()) {
      const farEntities = new Set();
      for (const entity of this._invisibleEntities) {
        if (entity.asset === asset && entity._currentDistance > this.distanceThresholdFar) {
          farEntities.add(entity);
        }
      }

      for (let meshDescIdx = 0; meshDescIdx < asset.meshLodDescs.length; meshDescIdx++) {
        const desc = asset.meshLodDescs[meshDescIdx];
        if (!desc) continue;

        for (let lodIdx = 0; lodIdx < desc.lods.length; lodIdx++) {
          const lod = desc.lods[lodIdx];
          if (lod.inline) continue;

          const key = `${asset.url}:${meshDescIdx}:${lodIdx}`;

          if (inUseByVisible.has(key)) continue;

          if (farEntities.size === 0) continue;

          const lodPriority = lodIdx === 0 ? 'high' : 'medium';
          const shouldUnload = (lodIdx === 0 && this.distanceThresholdFar >= 150) ||
                             (lodIdx >= 1 && this.distanceThresholdVeryFar >= 200);

          if (shouldUnload && asset.evictMeshLod(meshDescIdx, lodIdx)) {
            unloadedCount++;
            if (!this._unloadedLods.has(asset.url)) {
              this._unloadedLods.set(asset.url, new Set());
            }
            this._unloadedLods.get(asset.url).add(`${meshDescIdx}:${lodIdx}`);

            if (currentVramBytes * ESTIMATED_VRAM_FRACTION_AFTER_UNLOAD < this.vramBudgetBytes * VRAM_UNLOAD_TRIGGER_FRACTION) break;
          }
        }
      }

      for (let texDescIdx = 0; texDescIdx < asset.texLodDescs.length; texDescIdx++) {
        const desc = asset.texLodDescs[texDescIdx];
        if (!desc) continue;

        for (let lodIdx = 0; lodIdx < desc.lods.length; lodIdx++) {
          const lod = desc.lods[lodIdx];
          if (lod.inline) continue;

          const key = `${asset.url}:tex:${texDescIdx}:${lodIdx}`;
          if (inUseByVisible.has(key)) continue;

          if (farEntities.size > 0 && asset.evictTexLod(texDescIdx, lodIdx)) {
            unloadedCount++;
            if (!this._unloadedLods.has(asset.url)) {
              this._unloadedLods.set(asset.url, new Set());
            }
            this._unloadedLods.get(asset.url).add(`tex:${texDescIdx}:${lodIdx}`);

            if (currentVramBytes * ESTIMATED_VRAM_FRACTION_AFTER_UNLOAD < this.vramBudgetBytes * VRAM_UNLOAD_TRIGGER_FRACTION) break;
          }
        }
      }

      if (currentVramBytes * ESTIMATED_VRAM_FRACTION_AFTER_UNLOAD < this.vramBudgetBytes * VRAM_UNLOAD_TRIGGER_FRACTION) break;
    }

    this._stats.unloadedCount = unloadedCount;
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
    };
  }
}
