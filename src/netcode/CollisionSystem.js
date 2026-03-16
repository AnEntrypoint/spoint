export function applyPlayerCollisions(players, grid, gridCells, cellSz, minDist2, minDist, dt, physicsIntegration) {
  grid.clear()
  for (const p of players) {
    const cx=Math.floor(p.state.position[0]/cellSz), cz=Math.floor(p.state.position[2]/cellSz), ck=cx*65536+cz
    let cell=grid.get(ck); if (!cell){cell=gridCells.get(ck);if(!cell){cell=[];gridCells.set(ck,cell)}else{cell.length=0}grid.set(ck,cell)}; cell.push(p)
  }
  for (const player of players) {
    const px=player.state.position[0],py=player.state.position[1],pz=player.state.position[2]
    const cx=Math.floor(px/cellSz),cz=Math.floor(pz/cellSz)
    for (let ddx=-1;ddx<=1;ddx++) for (let ddz=-1;ddz<=1;ddz++) {
      const neighbors=grid.get((cx+ddx)*65536+(cz+ddz)); if (!neighbors) continue
      for (const other of neighbors) {
        if (other.id<=player.id) continue
        const ox=other.state.position[0],oy=other.state.position[1],oz=other.state.position[2]
        const dx=ox-px,dy=oy-py,dz=oz-pz,dist2=dx*dx+dy*dy+dz*dz
        if (dist2>=minDist2||dist2===0) continue
        const dist=Math.sqrt(dist2),nx=dx/dist,nz=dz/dist,overlap=minDist-dist,halfPush=overlap*0.5,pushVel=Math.min(halfPush/dt,3.0)
        player.state.position[0]-=nx*halfPush; player.state.position[2]-=nz*halfPush; player.state.velocity[0]-=nx*pushVel; player.state.velocity[2]-=nz*pushVel
        other.state.position[0]+=nx*halfPush; other.state.position[2]+=nz*halfPush; other.state.velocity[0]+=nx*pushVel; other.state.velocity[2]+=nz*pushVel
        physicsIntegration.setPlayerPosition(player.id,player.state.position); physicsIntegration.setPlayerPosition(other.id,other.state.position)
      }
    }
  }
}
