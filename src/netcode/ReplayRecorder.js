import { encodeReplay } from './ReplayFile.js'

export class ReplayRecorder {
  constructor({ playerManager, tickSystem, eventLog = null, worldName = 'unknown', tickRate = 60, collisionSteps = 2 }) {
    if (!playerManager || typeof playerManager.addInput !== 'function') throw new Error('ReplayRecorder requires a real playerManager (with addInput)')
    if (!tickSystem) throw new Error('ReplayRecorder requires a real tickSystem')
    this._playerManager = playerManager
    this._tickSystem = tickSystem
    this._eventLog = eventLog
    this._worldName = worldName
    this._tickRate = tickRate
    this._collisionSteps = collisionSteps
    this._recording = false
    this._inputs = []
    this._ticks = []
    this._playersSeen = new Map()
    this._startTick = null
    this._endTick = null
    this._recordedAt = 0
    this._origAddInput = playerManager.addInput.bind(playerManager)
    this._onTickRecord = (tick, dt) => {
      if (!this._recording) return
      this._ticks.push({ tick, dt })
    }
  }

  registerPlayer(playerId, name, spawnState) {
    this._playersSeen.set(playerId, {
      id: playerId,
      name: name || `Player ${playerId}`,
      spawn: {
        position: spawnState?.position ? [...spawnState.position] : [0, 0, 0],
        rotation: spawnState?.rotation ? [...spawnState.rotation] : [0, 0, 0, 1],
        health: spawnState?.health ?? 100,
      },
    })
  }

  start() {
    if (this._recording) return
    this._recording = true
    this._recordedAt = Date.now()
    this._inputs.length = 0
    this._ticks.length = 0
    const self = this
    this._playerManager.addInput = function (playerId, input, clientSeq) {
      if (self._recording) {
        const tick = self._tickSystem.currentTick
        if (self._startTick === null) self._startTick = tick
        self._endTick = tick
        self._inputs.push({ tick, playerId, sequence: clientSeq ?? null, data: input })
      }
      return self._origAddInput(playerId, input, clientSeq)
    }
    this._tickSystem.onTick(this._onTickRecord)
  }

  stop() {
    if (!this._recording) return null
    this._recording = false
    this._playerManager.addInput = this._origAddInput
    const header = {
      worldName: this._worldName,
      tickRate: this._tickRate,
      startTick: this._startTick ?? 0,
      endTick: this._endTick ?? 0,
      recordedAt: this._recordedAt,
      collisionSteps: this._collisionSteps,
      players: [...this._playersSeen.values()],
    }
    const events = this._eventLog && typeof this._eventLog._toArray === 'function' ? this._eventLog._toArray() : []
    return encodeReplay({ header, inputs: this._inputs, ticks: this._ticks, events })
  }

  get recording() { return this._recording }
  get inputCount() { return this._inputs.length }
  get tickCount() { return this._ticks.length }
}
