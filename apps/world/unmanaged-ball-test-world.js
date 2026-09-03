// TEMPORARY throwaway world for bug-otb-ball-sync-rootcause live investigation.
export default {
  spawnPoint: [0, 2, 5],
  gravity: [0, -9.81, 0],
  relevanceRadius: 200,
  entities: [
    { id: 'unmanaged-ball-1', app: 'unmanaged-ball-test', bodyType: 'dynamic', position: [0, 3, 0] }
  ],
  placeableApps: ['unmanaged-ball-test']
}
