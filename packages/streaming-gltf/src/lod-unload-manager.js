// LodUnloadManager — tracks entity visibility and triggers aggressive unloading.
//
// Responsibilities:
//  - Track which entities are visible (in-frustum, close to camera).
//  - Monitor total VRAM usage against a budget.
//  - Scan for unloadable LODs: prefer evicting high-quality LODs (LOD 0) from
//    far entities (distance > threshold).
//  - Expose unload stats for HUD display.
//
// Design:
//  - Maintain a visible set: entities currently in frustum + close enough.
//  - Per-frame, scan all assets for LODs not in the visible set.
//  - Trigger unload when VRAM usage exceeds budget (e.g., 85% of capacity).
//  - Prioritize unloading: LOD 0 from entities > 150m away.

export class LodUnloadManager {
  constructor(vramBudgetMB = 200) {
    this.vramBudgetMB = vramBudgetMB;
    this.vramBudgetBytes = vramBudgetMB * 1024 * 1024;
    this._visibleEntities = new Set();
    this._invisibleEntities = new Set();
    this._unloadedLods = new Map(); // assetUrl -> Set of { meshDescIdx, lodIdx }
    this._stats = {
      visibleCount: 0,
      invisibleCount: 0,
      unloadedCount: 0,
      estimatedVramMB: 0,
    };
    // Distance thresholds for unload decisions
    this.distanceThresholdFar = 150; // unload LOD 0 from entities > 150m
    this.distanceThresholdVeryFar = 200; // unload LOD 1-2 from entities > 200m (extreme)
  }

  // Mark an entity as visible
  markVisible(entity) {
    if (!entity) return;
    this._visibleEntities.add(entity);
    this._invisibleEntities.delete(entity);
  }

  // Mark an entity as invisible
  markInvisible(entity) {
    if (!entity) return;
    this._visibleEntities.delete(entity);
    this._invisibleEntities.add(entity);
  }

  // Scan for unloadable LODs and trigger unloads if needed
  scanForUnload(assets, currentVramBytes) {
    // Estimate current VRAM usage
    this._stats.estimatedVramMB = currentVramBytes / (1024 * 1024);
    this._stats.visibleCount = this._visibleEntities.size;
    this._stats.invisibleCount = this._invisibleEntities.size;

    // If VRAM is below 85% budget, skip unloading
    if (currentVramBytes < this.vramBudgetBytes * 0.85) {
      return; // plenty of headroom
    }

    // Collect all LODs currently in use by visible entities
    const inUseByVisible = new Set();
    for (const entity of this._visibleEntities) {
      for (const tm of entity.trackedMeshes || []) {
        const key = `${entity.asset.url}:${tm.meshDescIdx}:${tm.currentLod}`;
        inUseByVisible.add(key);
      }
    }

    // Scan all assets for unloadable LODs
    let unloadedCount = 0;
    for (const asset of assets.values()) {
      // Build a list of far entities (> threshold) using this asset
      const farEntities = new Set();
      for (const entity of this._invisibleEntities) {
        if (entity.asset === asset && entity._currentDistance > this.distanceThresholdFar) {
          farEntities.add(entity);
        }
      }

      // For each mesh descriptor, try to unload high-quality LODs from far entities
      for (let meshDescIdx = 0; meshDescIdx < asset.meshLodDescs.length; meshDescIdx++) {
        const desc = asset.meshLodDescs[meshDescIdx];
        if (!desc) continue;

        // Prefer unloading LOD 0 (highest quality) first
        for (let lodIdx = 0; lodIdx < desc.lods.length; lodIdx++) {
          const lod = desc.lods[lodIdx];
          if (lod.inline) continue; // never unload inline geometry

          const key = `${asset.url}:${meshDescIdx}:${lodIdx}`;

          // Skip if any entity is using this LOD
          if (inUseByVisible.has(key)) continue;

          // Skip if no far entity exists for this asset
          if (farEntities.size === 0) continue;

          // Unload logic: LOD 0 from far entities, LOD 1-2 from very far
          const lodPriority = lodIdx === 0 ? 'high' : 'medium';
          const shouldUnload = (lodIdx === 0 && this.distanceThresholdFar >= 150) ||
                             (lodIdx >= 1 && this.distanceThresholdVeryFar >= 200);

          if (shouldUnload && asset.evictMeshLod(meshDescIdx, lodIdx)) {
            unloadedCount++;
            if (!this._unloadedLods.has(asset.url)) {
              this._unloadedLods.set(asset.url, new Set());
            }
            this._unloadedLods.get(asset.url).add(`${meshDescIdx}:${lodIdx}`);

            // If we've freed enough, stop here
            if (currentVramBytes * 0.9 < this.vramBudgetBytes * 0.85) break;
          }
        }
      }

      // Likewise for textures
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

            if (currentVramBytes * 0.9 < this.vramBudgetBytes * 0.85) break;
          }
        }
      }

      if (currentVramBytes * 0.9 < this.vramBudgetBytes * 0.85) break;
    }

    this._stats.unloadedCount = unloadedCount;
  }

  // Reset visibility tracking (called at start of each frame)
  resetVisibility() {
    this._visibleEntities.clear();
    this._invisibleEntities.clear();
  }

  // Get unload stats
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
