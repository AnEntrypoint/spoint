function swapInstance(target, NewClass, constructArgs, stateKeys) {
  const oldProto = Object.getPrototypeOf(target)
  const oldOwnDescriptors = Object.getOwnPropertyDescriptors(target)
  try {
    const fresh = new NewClass(...constructArgs)
    Object.setPrototypeOf(target, NewClass.prototype)
    const freshDescriptors = Object.getOwnPropertyDescriptors(fresh)
    for (const key of Object.keys(freshDescriptors)) {
      if (!stateKeys.includes(key)) {
        Object.defineProperty(target, key, freshDescriptors[key])
      }
    }
    for (const key of Object.keys(oldOwnDescriptors)) {
      if (!(key in freshDescriptors) && !stateKeys.includes(key)) {
        delete target[key]
      }
    }
  } catch (e) {
    Object.setPrototypeOf(target, oldProto)
    for (const [key, desc] of Object.entries(oldOwnDescriptors)) {
      Object.defineProperty(target, key, desc)
    }
    for (const key of Object.keys(target)) {
      if (!(key in oldOwnDescriptors)) delete target[key]
    }
    throw e
  }
}

export function createReloadHandlers(deps) {
  const {
    networkState, playerManager, physicsIntegration,
    lagCompensator, physics, appRuntime, connections
  } = deps

  const reloadTickHandler = async () => {
    const { createTickHandler: refreshHandler } = await import('./TickHandler.js?' + Date.now())
    return refreshHandler(deps)
  }

  const reloadPhysicsIntegration = async () => {
    const { PhysicsIntegration: New } = await import('../netcode/PhysicsIntegration.js?' + Date.now())
    swapInstance(physicsIntegration, New, [{ ...physicsIntegration.config, physicsWorld: physics }], ['playerBodies'])
  }

  const reloadLagCompensator = async () => {
    const { LagCompensator: New } = await import('../netcode/LagCompensator.js?' + Date.now())
    swapInstance(lagCompensator, New, [lagCompensator.historyWindow], ['playerHistory'])
  }

  const reloadPlayerManager = async () => {
    const { PlayerManager: New } = await import('../netcode/PlayerManager.js?' + Date.now())
    swapInstance(playerManager, New, [], ['players', 'inputBuffers', 'nextPlayerId'])
  }

  const reloadNetworkState = async () => {
    const { NetworkState: New } = await import('../netcode/NetworkState.js?' + Date.now())
    swapInstance(networkState, New, [], ['players', 'tick', 'timestamp'])
  }

  return {
    reloadTickHandler,
    reloadPhysicsIntegration,
    reloadLagCompensator,
    reloadPlayerManager,
    reloadNetworkState
  }
}
