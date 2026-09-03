// RenderGraph -- the single per-frame orchestrator for the client's update+render passes.
//
// NODE CONTRACT (the dag-node-api that unblocked mapspinner decomposition):
//   { id: string,                unique; shows in inspector/errors/mermaid
//     reads: string[],           resource keys consumed (edges derive from these)
//     writes: string[],          resource keys produced -- EXACTLY ONE writer per key, enforced
//                                at construction with a throw (this is the mechanism that makes a
//                                4th ad-hoc depth-compositing path structurally impossible)
//     shouldRun?: ctx => bool,   false = skip this frame; the node's resources keep LAST frame's
//                                value (or stay undefined on frame 1) -- downstream must tolerate
//     required?: true,           refuses disable() (e.g. scene-color: a frame must draw)
//     independent?: true,        opts OUT of the implicit registration-order edge below (a node
//                                genuinely safe to run whenever its real reads are satisfied)
//     targets?: {resKey:targetId}, OPTIONAL declared physical-target identity for one or more of
//                                this node's writes (e.g. {sceneColor:'canvas', sceneDepth:'canvas'})
//                                -- lets two distinct resource KEYS (separate data-dependency
//                                identities, e.g. a depth marker and a color marker) be declared as
//                                the SAME underlying GPU render target/framebuffer without forcing
//                                node authors to merge them into one key. A resource key with no
//                                entry here defaults to aliasing only itself (no sharing assumed).
//                                Feeds resourceGraph()/aliasReport() below; purely additive -- a node
//                                that omits `targets` behaves exactly as before.
//     terminal?: true,           this node's writes are a legitimate frameId-stamp/marker with real
//                                work done entirely as an EXTERNAL side effect (GPU query submission,
//                                a camera-layer toggle, ...) that no other graph node needs to read --
//                                the resource exists for INSPECTOR visibility (frameId ran-this-frame
//                                proof), not as a data dependency. Opts the node OUT of dead-pass
//                                detection below WITHOUT claiming the (unverifiable-from-reads/writes-
//                                alone) exemption every unread/untargeted write would otherwise get by
//                                default -- so a genuinely forgotten/orphaned new node (author forgot
//                                to wire its consumer) still gets flagged, while a real terminal marker
//                                doesn't false-positive. Declared per real example: visibility-commit
//                                (occlusionCommitted is a pure "queries issued this frame" stamp; the
//                                real effect is GPU occlusion-query state persisting to next frame) and
//                                hrt-gate-main-camera (hrtGated stamps whether the layer toggle ran;
//                                the real effect is ctx.camera.layers state).
//     run: ctx => void }         the pass body; writes go to ctx.res[key]
//   Marker resources (value ignored, presence orders) express order-only constraints a data edge
//   can't carry (e.g. camera.near/far mutation).
//   IMPLICIT SEQUENTIAL EDGE: a node with an EMPTY reads[] has in-degree 0 from real data edges
//   alone -- Kahn's algorithm queues it into the SAME initial ready-batch as the first-registered
//   node, so it can run before an earlier-registered node whose own real dependencies aren't
//   satisfied yet (live-witnessed: a zero-reads cull step ran before the frame-clock-dependent
//   tick step it was registered after). To make "registration order is the fallback ordering" true
//   in fact, not just when the whole list happens to be edge-free, every node with a non-empty
//   reads[] OR that is not marked independent:true gets an implicit order-only dependency on every
//   node registered before it. Ties still break FIFO; this only prevents a later node from racing
//   ahead of earlier ones it has no declared reason to precede.
//   Error policy: a throwing node logs ONCE per node id (console.error, named), the REMAINDER of
//   this frame is skipped (a half-written frame must not cascade), the next frame runs normally.
//
// Instrumentation (profiling=true): per-node CPU ms (last + EMA) and renderer.info draw-call/tri
// deltas. OFF by default -- the off-cost is one boolean branch per node, no allocation.
// Watchdogs (always on, log-once-loud): NaN camera, near>=far, autoClear left false after the
// frame, construction-time written-never-read warnings.
// Live surface: window.__renderGraph = { order, stats(), capture(), disable(id), enable(id),
// setProfiling(v), toMermaid(), lastRes, watchdogLog, deadPasses(), unreadResources(),
// aliasHazards(), resourceGraph() } -- one page.evaluate reads everything.
// deadPasses()/unreadResources()/aliasHazards() are construction-time-computed (the node list is
// fixed for a graph instance's lifetime) -- cheap to poll every frame from the inspector, no
// per-call recompute. resourceGraph() is the single real-edge artifact (nodes+edges+targets+
// hazards) that toMermaid() and the RenderGraphViewer both ultimately render as a view of.
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
  // Render-target aliasing (the other tractable half of the row): group resource KEYS by their
  // declared physical target (node.targets[key], defaulting to the key itself -- i.e. "no sharing
  // assumed" unless a node author opts in). Two distinct keys sharing one target is legitimate
  // (that's the real canvas-compositing chain: terrainColor/sceneColor/bloomComposited/... all
  // eventually land on the same canvas framebuffer) PROVIDED their writers are ORDER-CONNECTED
  // (one is reachable from the other through the declared edges) -- an unordered pair sharing a
  // target is a real hazard: two passes could race to stomp the same physical buffer with no
  // dependency forcing a safe order. Edge/order-reachability is computed AFTER the topo sort below
  // (aliasHazards is filled in there); this block only builds the grouping. Computed BEFORE
  // dead-pass detection below, since a write onto a shared (non-self) target is itself proof of a
  // real consumer (the target, not another node's `reads`) and must not be flagged dead.
  const targetOf = new Map() // resourceKey -> targetId
  const hasDeclaredTarget = new Set() // resourceKey whose writer opted into targets[key] (non-self alias)
  for (const n of nodes) {
    for (const key of n.writes || []) {
      const t = (n.targets && n.targets[key]) || key
      targetOf.set(key, t)
      if (t !== key) hasDeclaredTarget.add(key)
    }
  }
  const keysByTarget = new Map() // targetId -> [{key, writer}]
  for (const [key, target] of targetOf) {
    if (!keysByTarget.has(target)) keysByTarget.set(target, [])
    keysByTarget.get(target).push({ key, writer: writerOf.get(key) })
  }
  // written-never-read: a construction-time warning, not an error (a terminal debug mirror is legal,
  // but an unread resource is usually a consumer someone forgot to wire -- the silently-dropped-
  // bridge class this repo keeps re-finding). Exempt: (1) a declared non-self target -- the
  // canvas/physical-target IS the real consumer, same as dead-pass detection below; (2) a writer
  // node marked required/terminal -- the WHOLE node is an intentionally-terminal completion marker;
  // (3) a key listed in the writer's own `debugMirrors` -- a PER-KEY escape for a node that writes
  // some resources real consumers read and others that are deliberately self-contained debug
  // mirrors (e.g. terrain-depth-color's 'camera-context', read inline via ctx.res, not a declared
  // `reads` edge), so marking the whole node terminal would wrongly also silence a genuinely-
  // missing consumer on one of its OTHER writes.
  const unreadKeys = []
  for (const [key, writer] of writerOf) {
    if (readersOf.has(key) || hasDeclaredTarget.has(key)) continue
    const writerNode = byId.get(writer)
    if (writerNode && (writerNode.required || writerNode.terminal)) continue
    if (writerNode && writerNode.debugMirrors && writerNode.debugMirrors.includes(key)) continue
    unreadKeys.push(key)
    console.warn(`[render-graph] resource '${key}' (written by '${writer}') has no reader -- debug mirror or missing consumer?`)
  }
  // Dead-pass detection (construction-time, static -- the tractable half of "auto-cull dead
  // passes"): a node whose EVERY declared write is BOTH unread by another node's `reads` AND not
  // aliased onto a shared physical target (targets[key]) is a real candidate for a forgotten/
  // orphaned pass -- its whole output is provably invisible to the rest of the graph by either
  // consumption path. The target exemption matters: a terminal compositor (e.g. 'fsr1-composite'
  // writing fsr1Composited straight onto 'canvas', or whichever post-fx node happens to be LAST in
  // an enabled chain that frame) has zero `reads` consumers by construction -- its real consumer is
  // the physical canvas itself, declared via `targets`, not another node. Flagging every terminal
  // compositor as "dead" would be a false positive on the single most common real shape in this
  // graph (a linear post-fx chain), so a declared non-self target counts as a real reader.
  // Deliberately NOT auto-disabled: a node with writes:[] (no tracked resource output at all, e.g.
  // 'modelpool-update') is explicitly exempt -- it may still be doing real ctx-external work
  // (mutating a THREE object graph, ticking a subsystem) the static reads/writes contract can't
  // see, so silently culling on writes:[] would be a real behavior change, not a diagnostic. Only a
  // node that DECLARED at least one write and had every single one go both unread AND untargeted is
  // flagged -- that is a case the node's own author already told the graph "this exists to produce
  // a resource", so zero consumers by either path is unambiguous, not a guess.
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
  // Implicit sequential edge (see NODE CONTRACT above): a node not opted out via independent:true
  // depends on the immediately-preceding registered node, unless a real data edge already covers
  // it -- chaining through the FULL preceding list this way (not just the immediate predecessor)
  // would re-serialize everything and defeat the DAG; one edge to the direct predecessor is
  // sufficient to prevent racing ahead, since that predecessor's own in-degree already encodes its
  // transitive ordering against everything before it.
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.independent) continue
    const prev = nodes[i - 1]
    const seenDeps = new Set((n.reads || []).map(k => writerOf.get(k)).filter(Boolean))
    if (seenDeps.has(prev.id)) continue
    outEdges.get(prev.id).push(n.id)
    inDegree.set(n.id, inDegree.get(n.id) + 1)
  }
  // Kahn's algorithm, FIFO queue so ties break in registration order (reproduces today's real
  // animate() execution order when declared edges match today's real dependencies).
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

  // aliasHazards: pairs of DIFFERENT resource keys declared onto the SAME target (keysByTarget,
  // built above) whose writer nodes have no path between them in outEdges -- i.e. the topo sort
  // does not guarantee one runs before the other, so two writers could (depending on future
  // reordering/edge changes) stomp the same physical target with no ordering constraint forcing a
  // safe sequence. Reachability computed once here via BFS per writer (node count is small --
  // dozens, not thousands -- so O(N*(N+E)) is negligible at construction time, never per-frame).
  const _reachableFrom = new Map() // nodeId -> Set(nodeId) forward-reachable
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
  for (const n of nodes) stats.set(n.id, { ms: 0, ema: 0, calls: 0, tris: 0, runs: 0, skips: 0, errors: 0 })
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
      disabled.add(id)
      return true
    },
    enable(id) { disabled.delete(id); return true },
    disabledIds() { return [...disabled] },
    // Construction-time-computed, immutable for this graph instance's lifetime (the node list
    // never changes after createRenderGraph returns) -- cheap to call every poll, no recompute.
    deadPasses() { return [...deadPassIds] },
    unreadResources() { return [...unreadKeys] },
    aliasHazards() { return aliasHazards.map(h => ({ ...h })) },
    // The single real-resource-edge artifact the row asks for: every node with its reads/writes/
    // target/disabled/dead-pass state plus every real data edge (key, from, to) -- toMermaid()
    // stays the human-readable rendering of exactly this same underlying data, never a second
    // source of truth.
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
    // Resolves after the NEXT completed frame with a serializable snapshot -- the one artifact a
    // bug report carries instead of ten probing rounds.
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
          if (disabled.has(node.id)) { stats.get(node.id).skips++; continue }
          if (node.shouldRun && !node.shouldRun(ctx)) { stats.get(node.id).skips++; continue }
          if (profiling) {
            const s = stats.get(node.id)
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
            stats.get(node.id).runs++
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
