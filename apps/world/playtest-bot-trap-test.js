const WALL_HALF_THICKNESS = 0.5
const ROOM_HALF_EXTENT = 3

export default {
  spawnPoint: [0, 2, 0],
  gravity: [0, -9.81, 0],
  entities: [
    { id: 'floor', app: 'box-static', position: [0, -WALL_HALF_THICKNESS, 0], config: { hx: ROOM_HALF_EXTENT + WALL_HALF_THICKNESS, hy: WALL_HALF_THICKNESS, hz: ROOM_HALF_EXTENT + WALL_HALF_THICKNESS, color: '#555555' } },
    { id: 'ceiling', app: 'box-static', position: [0, ROOM_HALF_EXTENT * 2 + WALL_HALF_THICKNESS, 0], config: { hx: ROOM_HALF_EXTENT + WALL_HALF_THICKNESS, hy: WALL_HALF_THICKNESS, hz: ROOM_HALF_EXTENT + WALL_HALF_THICKNESS, color: '#555555' } },
    { id: 'wall-north', app: 'box-static', position: [0, ROOM_HALF_EXTENT, ROOM_HALF_EXTENT + WALL_HALF_THICKNESS], config: { hx: ROOM_HALF_EXTENT + WALL_HALF_THICKNESS, hy: ROOM_HALF_EXTENT, hz: WALL_HALF_THICKNESS, color: '#775555' } },
    { id: 'wall-south', app: 'box-static', position: [0, ROOM_HALF_EXTENT, -ROOM_HALF_EXTENT - WALL_HALF_THICKNESS], config: { hx: ROOM_HALF_EXTENT + WALL_HALF_THICKNESS, hy: ROOM_HALF_EXTENT, hz: WALL_HALF_THICKNESS, color: '#775555' } },
    { id: 'wall-east', app: 'box-static', position: [ROOM_HALF_EXTENT + WALL_HALF_THICKNESS, ROOM_HALF_EXTENT, 0], config: { hx: WALL_HALF_THICKNESS, hy: ROOM_HALF_EXTENT, hz: ROOM_HALF_EXTENT + WALL_HALF_THICKNESS, color: '#557755' } },
    { id: 'wall-west', app: 'box-static', position: [-ROOM_HALF_EXTENT - WALL_HALF_THICKNESS, ROOM_HALF_EXTENT, 0], config: { hx: WALL_HALF_THICKNESS, hy: ROOM_HALF_EXTENT, hz: ROOM_HALF_EXTENT + WALL_HALF_THICKNESS, color: '#557755' } },
    { id: 'trapped-bot', app: 'playtest-bot', position: [0, 1, 0], config: { wanderRadius: 20, stuckTicks: 15, speed: 3 } },
  ],
}
