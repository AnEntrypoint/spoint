/**
 * dataset-viz.js — Freddie-bridge dataset visualization factory.
 *
 * Wraps FreddieBridge.computeLayout() so a world entity can spawn child 3D primitives
 * (box, sphere, capsule, etc.) at the computed layout positions, with color/size mapping
 * driven by each item's `value` field.
 *
 * Usage from a world app's setup(ctx):
 *   import { createDatasetViz } from '../_lib/dataset-viz.js'
 *   const viz = createDatasetViz({
 *     items: [
 *       { id: 'a', label: 'Alpha', value: 0.8 },
 *       { id: 'b', label: 'Beta',  value: 0.3 },
 *     ],
 *     layout: 'grid',
 *     config: { spacing: 2, colorLow: 0x3366ff, colorHigh: 0xff3333 },
 *   }, ctx)
 *   viz.spawn()  // spawns a child entity per item
 *   viz.clear()  // destroys all spawned children
 *   viz.update(items)  // replace dataset, respawn
 *
 * First slice: spawns box entities in a grid layout from a static items array.
 * Dataset update/clear/live-resize are deferred to follow-up slices.
 */

import { computeLayout } from '../../src/sdk/FreddieBridge.js'

/**
 * @param {object} spec
 * @param {Array<{id:string, label:string, value:number, position?:[number,number,number], color?:number, children?:Array}>} spec.items
 * @param {'grid'|'scatter'|'tree'|'graph'|'spiral'} [spec.layout='grid']
 * @param {object} [spec.config]
 * @param {number} [spec.config.spacing=1]
 * @param {[number,number]} [spec.config.sizeRange=[0.1,1]]
 * @param {[number,number]} [spec.config.colorRange=[0,1]]
 * @param {number} [spec.config.colorLow=0x3366ff]
 * @param {number} [spec.config.colorHigh=0xff3333]
 * @param {object} ctx — AppContext (provides ctx.world.spawnChild / ctx.world.destroyEntity)
 * @returns {{ spawn: () => string[], clear: () => void, update: (items:Array) => void, getChildIds: () => string[] }}
 */
export function createDatasetViz(spec, ctx) {
  const layout = spec.layout || 'grid'
  const config = spec.config || {}
  const spacing = config.spacing ?? 1
  const sizeRange = config.sizeRange || [0.1, 1]
  const colorRange = config.colorRange || [0, 1]
  const colorLow = config.colorLow ?? 0x3366ff
  const colorHigh = config.colorHigh ?? 0xff3333

  /** @type {string[]} */
  let _childIds = []

  /**
   * Map a value in [colorRange[0], colorRange[1]] to a hex color between colorLow and colorHigh.
   */
  function _mapColor(value) {
    const t = colorRange[1] === colorRange[0] ? 0.5 : Math.max(0, Math.min(1, (value - colorRange[0]) / (colorRange[1] - colorRange[0])))
    const r0 = (colorLow >> 16) & 0xff, g0 = (colorLow >> 8) & 0xff, b0 = colorLow & 0xff
    const r1 = (colorHigh >> 16) & 0xff, g1 = (colorHigh >> 8) & 0xff, b1 = colorHigh & 0xff
    const r = Math.round(r0 + (r1 - r0) * t)
    const g = Math.round(g0 + (g1 - g0) * t)
    const b = Math.round(b0 + (b1 - b0) * t)
    return (r << 16) | (g << 8) | b
  }

  /**
   * Map a value in [colorRange[0], colorRange[1]] to a uniform scale between sizeRange[0] and sizeRange[1].
   */
  function _mapSize(value) {
    const t = colorRange[1] === colorRange[0] ? 0.5 : Math.max(0, Math.min(1, (value - colorRange[0]) / (colorRange[1] - colorRange[0])))
    const s = sizeRange[0] + (sizeRange[1] - sizeRange[0]) * t
    return [s, s, s]
  }

  /**
   * Spawn child entities for all items. Returns the array of spawned entity IDs.
   * Idempotent: clears any existing children first.
   */
  function spawn() {
    clear()
    const items = spec.items || []
    const positions = computeLayout(items, layout, { spacing })
    const ids = []
    for (const item of items) {
      const pos = item.position || positions.get(item.id) || [0, 0, 0]
      const color = item.color ?? _mapColor(item.value ?? 0)
      const scale = _mapSize(item.value ?? 0)
      const childId = ctx.world.spawnChild(ctx.entity.id, {
        position: pos,
        scale,
        custom: {
          mesh: 'box',
          color,
          roughness: 0.5,
          metalness: 0.1,
          label: item.label || item.id,
          _freddieDatasetItem: true,
        },
      })
      ids.push(childId)
    }
    _childIds = ids
    return ids
  }

  /**
   * Destroy all spawned child entities.
   */
  function clear() {
    for (const id of _childIds) {
      ctx.world.destroyEntity(id)
    }
    _childIds = []
  }

  /**
   * Replace the dataset with new items and respawn.
   */
  function update(items) {
    spec.items = items
    spawn()
  }

  /**
   * Return the current child entity IDs.
   */
  function getChildIds() {
    return [..._childIds]
  }

  return { spawn, clear, update, getChildIds }
}