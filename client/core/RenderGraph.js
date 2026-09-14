export function createRenderGraph(nodes, opts = {}) {
  const byId = new Map(nodes.map(n => [n.id, n]))
  if (byId.size !== nodes.length) throw new Error('RenderGraph: duplicate node id')
  const writerOf = new Map()
  for (const n of nodes) {
    for (const key of n.writes || []) {
      if (writerOf.has(key)) {
        throw new Error(`RenderGraph: '${key}' written by both '${writerOf.get(key)}' and '${n.id}' -- every resource must have exactly one writer`)
      }
      writerOf.set(key, n.id)
    }
  }
  const readersOf = new Map()
  for (const n of nodes) for (const key of n.reads || []) {
    if (!readersOf.has(key)) readersOf.set(key, [])
    readersOf.get(key).push(n.id)
  }
  const targetOf = new Map()
  const hasDeclaredTarget = new Set()
  for (const n of nodes) {
    for (const key of n.writes || []) {
      const t = (n.targets && n.targets[key]) || key
      targetOf.set(key, t)
      if (t !== key) hasDeclaredTarget.add(key)
    }
  }
  const keysByTarget = new Map()
  for (const [key, target] of targetOf) {
    if (!keysByTarget.has(target)) keysByTarget.set(target, [])
    keysByTarget.get(target).push({ key, writer: writerOf.get(key) })
  }
  const unreadKeys = []
  for (const [key, writer] of writerOf) {
    if (readersOf.has(key) || hasDeclaredTarget.has(key)) continue
    const writerNode = byId.get(writer)
    if (writerNode && (writerNode.required || writerNode.terminal)) continue
    if (writerNode && writerNode.debugMirrors && writerNode.debugMirrors.includes(key)) continue
    unreadKeys.push(key)
    console.warn(`[render-graph] resource '${key}' (written by '${writer}') has no reader -- debug mirror or missing consumer?`)
  }
  const deadPassIds = []
  for (const n of nodes) {
    const w = n.writes || []
    if (w.length === 0) continue
    if (n.required || n.terminal) continue
    if (w.every(key => !readersOf.has(key) && !hasDeclaredTarget.has(key))) deadPassIds.push(n.id)
  }
  const outEdges = new Map(nodes.map(n => [n.id, []]))
  const inDegree = new Map(nodes.map(n => [n.id, 0]))
  for (const n of nodes) {
    const seenDeps = new Set()
    for (const key of n.reads || []) {
      const producer = writerOf.get(key)
      if (producer == null || producer === n.id || seenDeps.has(producer)) continue
      seenDeps.add(producer)
      outEdges.get(producer).push(n.id)
      inDegree.set(n.id, inDegree.get(n.id) + 1)
    }
  }
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.independent) continue
    const prev = nodes[i - 1]
    const seenDeps = new Set((n.reads || []).map(k => writerOf.get(k)).filter(Boolean))
    if (seenDeps.has(prev.id)) continue
    outEdges.get(prev.id).push(n.id)
    inDegree.set(n.id, inDegree.get(n.id) + 1)
  }
  const queue = nodes.filter(n => inDegree.get(n.id) === 0).map(n => n.id)
  const order = []
  const _deg = new Map(inDegree)
  while (queue.length) {
    const id = queue.shift()
    order.push(id)
    for (const next of outEdges.get(id)) {
      _deg.set(next, _deg.get(next) - 1)
      if (_deg.get(next) === 0) queue.push(next)
    }
  }
  if (order.length !== nodes.length) {
    const stuck = nodes.map(n => n.id).filter(id => !order.includes(id))
    throw new Error(`RenderGraph: cycle detected among [${stuck.join(', ')}]`)
  }
  const ordered = order.map(id => byId.get(id))

  const _reachableFrom = new Map()
  for (const n of nodes) {
    const seen = new Set([n.id])
    const q = [n.id]
    while (q.length) {
      const cur = q.shift()
      for (const next of outEdges.get(cur) || []) if (!seen.has(next)) { seen.add(next); q.push(next) }
    }
    _reachableFrom.set(n.id, seen)
  }
  const aliasHazards = []
  for (const [target, entries] of keysByTarget) {
    if (entries.length < 2) continue
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i], b = entries[j]
        if (!a.writer || !b.writer || a.writer === b.writer) continue
        const aReachesB = _reachableFrom.get(a.writer)?.has(b.writer)
        const bReachesA = _reachableFrom.get(b.writer)?.has(a.writer)
        if (!aReachesB && !bReachesA) {
          aliasHazards.push({ target, a: { key: a.key, writer: a.writer }, b: { key: b.key, writer: b.writer } })
        }
      }
    }
  }
  if (aliasHazards.length) {
    for (const h of aliasHazards) {
      console.warn(`[render-graph] target '${h.target}' shared by '${h.a.key}' (${h.a.writer}) and '${h.b.key}' (${h.b.writer}) with no ordering edge between them -- unordered write to a shared render target`)
    }
  }

  let profiling = false
  const disabled = new Set()
  const stats = new Map()
  for (const n of nodes) { const st = { ms: 0, ema: 0, calls: 0, tris: 0, runs: 0, skips: 0, errors: 0 }; stats.set(n.id, st); n._stats = st; n._disabled = false }
  const _erroredOnce = new Set()
  const _watchdogOnce = new Set()
  const watchdogLog = []
  let running = false
  let _captureResolve = null
  let lastCapture = null

  function _nodeThrew(id, e, frameId) {
    stats.get(id).errors++
    if (!_erroredOnce.has(id)) {
      _erroredOnce.add(id)
      console.error(`[render-graph] node '${id}' threw (frame ${frameId}); skipping the rest of this frame -- next frame runs normally. This logs once per node.`, e)
    }
  }

  function _watch(kind, msg, frameId) {
    if (_watchdogOnce.has(kind)) return
    _watchdogOnce.add(kind)
    watchdogLog.push({ kind, msg, frameId })
    console.error(`[render-graph watchdog] ${kind}: ${msg}`)
  }

  const graph = {
    order,
    frameId: 0,
    watchdogLog,
    get profiling() { return profiling },
    setProfiling(v) { profiling = !!v },
    disable(id) {
      const n = byId.get(id)
      if (!n) { console.warn(`[render-graph] disable('${id}'): no such node. Nodes: ${order.join(', ')}`); return false }
      if (n.required) { console.warn(`[render-graph] disable('${id}') refused: node is marked required`); return false }
      disabled.add(id); n._disabled = true
      return true
    },
    enable(id) { disabled.delete(id); const n = byId.get(id); if (n) n._disabled = false; return true },
    disabledIds() { return [...disabled] },
    deadPasses() { return [...deadPassIds] },
    unreadResources() { return [...unreadKeys] },
    aliasHazards() { return aliasHazards.map(h => ({ ...h })) },
    resourceGraph() {
      const rNodes = ordered.map(n => ({
        id: n.id,
        reads: [...(n.reads || [])],
        writes: [...(n.writes || [])],
        required: !!n.required,
        independent: !!n.independent,
        terminal: !!n.terminal,
        disabled: disabled.has(n.id),
        dead: deadPassIds.includes(n.id),
      }))
      const rEdges = []
      for (const n of ordered) {
        for (const key of n.reads || []) {
          const producer = writerOf.get(key)
          if (producer && producer !== n.id) rEdges.push({ from: producer, to: n.id, key })
        }
      }
      const rTargets = [...keysByTarget.entries()].map(([target, entries]) => ({ target, keys: entries.map(e => e.key) }))
      return { nodes: rNodes, edges: rEdges, targets: rTargets, aliasHazards: aliasHazards.map(h => ({ ...h })) }
    },
    stats() {
      const out = {}
      for (const [id, s] of stats) out[id] = { ...s, disabled: disabled.has(id) }
      return out
    },
    capture() {
      const wasProfiling = profiling
      profiling = true
      return new Promise(resolve => { _captureResolve = (c) => { profiling = wasProfiling; resolve(c) } })
    },
    lastRes: null,
    get lastCapture() { return lastCapture },
    toMermaid() {
      const lines = ['flowchart TD']
      for (const n of ordered) lines.push(`  ${n.id}["${n.id}${disabled.has(n.id) ? ' (disabled)' : ''}"]`)
      for (const n of ordered) {
        for (const key of n.reads || []) {
          const producer = writerOf.get(key)
          if (producer && producer !== n.id) lines.push(`  ${producer} -- ${key} --> ${n.id}`)
        }
      }
      return lines.join('\n')
    },
    run(ctx) {
      if (running) throw new Error('RenderGraph: reentrant run() -- a node (or an event it fired) called run() while a frame is in flight')
      running = true
      graph.frameId++
      ctx.frameId = graph.frameId
      if (!ctx.res) ctx.res = {}
      graph.lastRes = ctx.res
      try {
        for (const node of ordered) {
          if (node._disabled) { node._stats.skips++; continue }
          if (node.shouldRun && !node.shouldRun(ctx)) { node._stats.skips++; continue }
          if (profiling) {
            const s = node._stats
            const ri = ctx.renderer ? ctx.renderer.info.render : null
            const c0 = ri ? ri.calls : 0, tri0 = ri ? ri.triangles : 0
            const t0 = performance.now()
            try { node.run(ctx) } catch (e) { _nodeThrew(node.id, e, graph.frameId); return }
            s.ms = performance.now() - t0
            s.ema = s.ema === 0 ? s.ms : s.ema * 0.9 + s.ms * 0.1
            if (ri) { s.calls = ri.calls - c0; s.tris = ri.triangles - tri0 }
            s.runs++
          } else {
            try { node.run(ctx) } catch (e) { _nodeThrew(node.id, e, graph.frameId); return }
            node._stats.runs++
          }
        }
      } finally {
        running = false
        if (ctx.camera) {
          const p = ctx.camera.position
          if (!(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) _watch('nan-camera', `camera.position=(${p.x},${p.y},${p.z}) -- an upstream node wrote a non-finite transform`, graph.frameId)
          if (!(ctx.camera.near < ctx.camera.far)) _watch('near-ge-far', `camera near=${ctx.camera.near} >= far=${ctx.camera.far} -- projection sync broke`, graph.frameId)
        }
        if (ctx.renderer && ctx.renderer.autoClear === false) _watch('autoclear-left-false', 'renderer.autoClear left false after the frame -- a node set it and never restored', graph.frameId)
        if (_captureResolve) {
          const resSnap = {}
          for (const k of Object.keys(ctx.res)) {
            const v = ctx.res[k]
            if (v == null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') resSnap[k] = v
            else if (Array.isArray(v) && v.length <= 64 && v.every(x => typeof x === 'number')) resSnap[k] = [...v]
            else if (typeof v === 'object') { const o = {}; let cnt = 0; for (const kk of Object.keys(v)) { const vv = v[kk]; if (vv == null || typeof vv === 'number' || typeof vv === 'string' || typeof vv === 'boolean') { o[kk] = vv; if (++cnt >= 24) break } } resSnap[k] = o }
            else resSnap[k] = `<${typeof v}>`
          }
          lastCapture = {
            frameId: graph.frameId,
            order: [...order],
            disabled: [...disabled],
            stats: graph.stats(),
            res: resSnap,
            camera: ctx.camera ? { pos: ctx.camera.position.toArray(), near: ctx.camera.near, far: ctx.camera.far } : null,
            rendererInfo: ctx.renderer ? { ...ctx.renderer.info.render, textures: ctx.renderer.info.memory.textures, geometries: ctx.renderer.info.memory.geometries } : null,
            culling: (typeof window !== 'undefined' && window.__culling && window.__culling.aggregate) ? window.__culling.aggregate() : null,
            watchdogLog: [...watchdogLog],
          }
          const r = _captureResolve; _captureResolve = null; r(lastCapture)
        }
      }
    },
  }
  if (typeof window !== 'undefined' && opts.expose !== false) window.__renderGraph = graph
  return graph
}
