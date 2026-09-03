export default {
  server: {
    setup(ctx) {
      console.log('[matrix-construct-room] server setup')
      const planeSize = 50
      const planeThickness = 0.5

      // Floor plane with physics
      ctx.physics.addColliderFromConfig({
        type: 'box',
        size: [planeSize / 2, planeThickness / 2, planeSize / 2],
        position: [0, -planeThickness / 2, 0],
        mass: 0,
        dynamic: false
      })

      ctx.state.planeSize = planeSize
      ctx.state.planeThickness = planeThickness
    }
  },
  client: {
    setup(engine) {
      console.log('[matrix-construct-room] client setup')
      this.createConstructPlane(engine)
    },
    render(ctx) {
      return {
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        custom: {}
      }
    },
    createConstructPlane(engine) {
      const { THREE, scene } = engine
      const planeSize = 50
      const gridSize = 2

      console.log('[matrix-construct-room] creating plane geometry')

      // Simple gray plane
      const planeMaterial = new THREE.MeshStandardMaterial({
        color: 0xcccccc,
        roughness: 0.8,
        metalness: 0,
        side: THREE.DoubleSide
      })

      // Main plane
      const planeGeo = new THREE.PlaneGeometry(planeSize, planeSize)
      const plane = new THREE.Mesh(planeGeo, planeMaterial)
      plane.rotation.x = -Math.PI / 2
      plane.position.y = -0.25
      plane.receiveShadow = true
      scene.add(plane)

      // Grid lines - blue X axis, red Z axis (matching original matrix room)
      const lineThickness = 0.05
      const halfSize = planeSize / 2

      const gridMat = new THREE.MeshBasicMaterial({ color: 0x888888 })
      const xMat = new THREE.MeshBasicMaterial({ color: 0x0000ff })  // blue X axis
      const zMat = new THREE.MeshBasicMaterial({ color: 0xff0000 })  // red Z axis

      for (let x = -halfSize; x <= halfSize; x += gridSize) {
        const mat = Math.abs(x) < 0.01 ? xMat : gridMat
        const geo = new THREE.BoxGeometry(lineThickness, lineThickness, planeSize)
        const line = new THREE.Mesh(geo, mat)
        line.position.set(x, lineThickness / 2, 0)
        scene.add(line)
      }
      for (let z = -halfSize; z <= halfSize; z += gridSize) {
        const mat = Math.abs(z) < 0.01 ? zMat : gridMat
        const geo = new THREE.BoxGeometry(planeSize, lineThickness, lineThickness)
        const line = new THREE.Mesh(geo, mat)
        line.position.set(0, lineThickness / 2, z)
        scene.add(line)
      }

      // Origin marker
      const originGeo = new THREE.RingGeometry(0.3, 0.5, 32)
      const originMat = new THREE.MeshBasicMaterial({
        color: 0x333333,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.4
      })
      const origin = new THREE.Mesh(originGeo, originMat)
      origin.rotation.x = -Math.PI / 2
      origin.position.y = lineThickness
      scene.add(origin)

      // Outer boundary ring
      const boundaryGeo = new THREE.RingGeometry(halfSize - 0.2, halfSize, 64)
      const boundaryMat = new THREE.MeshBasicMaterial({
        color: 0x666666,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.3
      })
      const boundary = new THREE.Mesh(boundaryGeo, boundaryMat)
      boundary.rotation.x = -Math.PI / 2
      boundary.position.y = lineThickness / 2
      scene.add(boundary)

      console.log('[matrix-construct-room] done creating plane and grid')
    }
  }
}