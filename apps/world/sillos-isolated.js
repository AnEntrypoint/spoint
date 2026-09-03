// Isolation harness for the sillos vert-collapse investigation: ONLY the sillos model is placed,
// no terrain, no vegetation, no other entities -- eliminates every other subsystem (mapspinner
// terrain/water raw-GL draws, InstancedMesh2 vegetation/rocks, occlusion queries against terrain
// depth, other ClusterLodMesh instances competing for GPU state) as a variable, so any remaining
// GL error or visual defect is attributable to sillos's own ModelPool/ClusterLodMesh path alone.
export default {
  port: 3002,
  tickRate: 64,
  entityTickRate: 15,
  gravity: [0, -18.0, 0],
  spawnPoint: [0, 15.3, 0],
  placeableApps: [],
  entities: [
    { id: 'env-sillos', model: './apps/maps/aim_sillos.glb', position: [0, 10.31, 0], scale: [1, 1, 1], app: 'placed-model', config: { collider: 'trimesh' }, custom: { _interior: true } },
    // Kill-plane safety floor, far below sillos: this isolated world has no terrain, so a player
    // who spawns/falls outside sillos's own trimesh collider would otherwise fall forever (no
    // kill-plane rescue exists without terrain) -- purely a test-harness convenience, not part of
    // what's under investigation.
    { id: 'floor', app: 'box-static', position: [0, -20, 0], config: { hx: 200, hy: 1, hz: 200 } },
  ],
}
