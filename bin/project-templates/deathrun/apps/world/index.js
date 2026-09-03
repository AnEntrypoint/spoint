// deathrun template world-def: a start platform, a short authored obstacle course (ordered
// checkpoint-marker entities -- apps/checkpoint-marker, ships inside the spoint package itself, resolves
// from node_modules/spoint/apps/checkpoint-marker with zero project-side copy needed) with one
// moving-platform obstacle in the middle (apps/moving-platform, same zero-copy resolution), and a
// deathrun-course controller (template-local apps/deathrun-course) that reads the markers and respawns a
// fallen player at their last reached checkpoint instead of the course start. Add more `checkpoint-marker`
// entities (increasing `order`) in the editor to extend the course toward the finish line.
export default {
  spawnPoint: [0, 3, 0],
  gravity: [0, -9.81, 0],
  entities: [
    { id: 'course', app: 'deathrun-course', position: [0, 0, 0], config: { minY: -50, spawn: [0, 3, 0] } },

    { id: 'start-pad', app: 'floor', position: [0, 0, 0], config: { width: 8, depth: 8, thickness: 1, color: '#33cc88' } },
    { id: 'cp-0-start', app: 'checkpoint-marker', position: [0, 1, 0], config: { order: 0, radius: 5, color: '#33ccff' } },

    { id: 'jump-1', app: 'floor', position: [0, 2, 10], config: { width: 3, depth: 3, thickness: 0.5, color: '#8899aa' } },
    { id: 'cp-1', app: 'checkpoint-marker', position: [0, 2.5, 10], config: { order: 1, radius: 2.5, color: '#33ccff' } },

    { id: 'moving-obstacle', app: 'moving-platform', position: [0, 3, 20], config: { offset: [6, 0, 0], period: 3, sx: 3, sz: 3 } },
    { id: 'cp-2', app: 'checkpoint-marker', position: [0, 3.5, 20], config: { order: 2, radius: 4, color: '#33ccff' } },

    { id: 'jump-2', app: 'floor', position: [0, 4, 30], config: { width: 3, depth: 3, thickness: 0.5, color: '#8899aa' } },
    { id: 'cp-3', app: 'checkpoint-marker', position: [0, 4.5, 30], config: { order: 3, radius: 2.5, color: '#33ccff' } },

    { id: 'finish-pad', app: 'floor', position: [0, 5, 40], config: { width: 8, depth: 8, thickness: 1, color: '#ffcc33' } },
    { id: 'cp-4-finish', app: 'checkpoint-marker', position: [0, 6, 40], config: { order: 4, radius: 5, color: '#ffcc33' } },
  ]
}
