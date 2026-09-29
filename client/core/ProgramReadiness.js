const READY_POLL_MS = 16

export function renderDeferringUnreadyPrograms(renderer, scene, camera) {
  const prev = renderer.deferUnreadyPrograms
  renderer.deferredProgramDraws = renderer.deferredProgramDraws || 0
  renderer.deferUnreadyPrograms = true
  try { renderer.render(scene, camera) } finally { renderer.deferUnreadyPrograms = prev }
}

export function pendingProgramCount(renderer) {
  const programs = renderer.info && renderer.info.programs
  if (!programs) return 0
  let n = 0
  for (const p of programs) if (typeof p.isReady === 'function' && !p.isReady()) n++
  return n
}

export function whenProgramsReady(renderer, maxWaitMs) {
  const t0 = performance.now()
  return new Promise((resolve) => {
    const poll = () => {
      const pending = pendingProgramCount(renderer)
      if (pending === 0) { resolve(0); return }
      if (performance.now() - t0 >= maxWaitMs) { console.warn(`[shader] ${pending} program(s) still compiling after ${maxWaitMs}ms`); resolve(pending); return }
      setTimeout(poll, READY_POLL_MS)
    }
    poll()
  })
}

export function takeDeferredDraws(renderer) {
  const n = renderer.deferredProgramDraws || 0
  renderer.deferredProgramDraws = 0
  renderer.lastDeferredDraws = n
  return n
}
