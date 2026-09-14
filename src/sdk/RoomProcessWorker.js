import { RoomDirectory } from './RoomDirectory.js'

let directory = null

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return
  try {
    switch (msg.type) {
      case 'INIT': {
        directory = new RoomDirectory({
          sdkRoot: msg.sdkRoot,
          projectRoot: msg.projectRoot,
          portRange: msg.portRange,
        })
        process.send({ type: 'WORKER_READY', pid: process.pid })
        return
      }
      case 'CREATE_ROOM': {
        if (!directory) throw new Error('RoomProcessWorker: CREATE_ROOM received before INIT')
        try {
          const handle = await directory.createRoom(msg.roomId, msg.worldName, msg.opts || {})
          process.send({ type: 'ROOM_CREATED', reqId: msg.reqId, roomId: msg.roomId, port: handle.port, worldName: handle.worldName })
        } catch (e) {
          process.send({ type: 'ROOM_CREATE_FAILED', reqId: msg.reqId, roomId: msg.roomId, error: e?.message || String(e) })
        }
        return
      }
      case 'STOP_ROOM': {
        if (!directory) throw new Error('RoomProcessWorker: STOP_ROOM received before INIT')
        const stopped = await directory.stopRoom(msg.roomId)
        process.send({ type: 'ROOM_STOPPED', reqId: msg.reqId, roomId: msg.roomId, stopped })
        return
      }
      case 'GET_STATUS': {
        const rooms = directory ? directory.getStatus() : []
        process.send({ type: 'STATUS', reqId: msg.reqId, rooms })
        return
      }
      case 'SHUTDOWN': {
        if (directory) await directory.stopAll()
        process.send({ type: 'SHUTDOWN_DONE', reqId: msg.reqId })
        process.exit(0)
        return
      }
      default:
        return
    }
  } catch (e) {
    console.error('[RoomProcessWorker] unhandled error:', e?.message || e)
  }
})

process.on('uncaughtException', (e) => {
  console.error('[RoomProcessWorker] uncaughtException (process stays up, error logged; a room-scoped throw should not be able to reach here since RoomDirectory/createServer isolate per-room state, but a genuinely process-fatal error should be visible, not silently swallowed):', e)
})
