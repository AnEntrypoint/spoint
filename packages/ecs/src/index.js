/**
 * @spoint/ecs -- Shared Entity-Component-System core.
 *
 * FIRST SLICE of cross-project-shared-ecs-package.
 *
 * This package provides the ECS primitives shared between spoint's app layer
 * and thebird's entity system. The thebird's lib/ecs.js has additional features
 * (tag components, prefab instantiation, reactive queries) that are being ported
 * in subsequent slices.
 *
 * Exports:
 *   createWorld()  -- entity lifecycle, component storage, system scheduling,
 *                     tag components, flat prefab instantiation
 *   createQuery()  -- archetype-based entity iteration
 */

export { createWorld } from './world.js'
export { createQuery } from './query.js'