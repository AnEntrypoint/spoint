const A = await import('/workspace/spoint/src/shared/chartAnchor.js')
const P = await import('/workspace/spoint/src/shared/chartReanchorPolicy.js')
const out = {}
const tryIt = (k, f) => { try { out[k] = { ok: f() } } catch (e) { out[k] = { throws: e.name, message: e.message } } }
tryIt('lattice(0,0)', () => A.createChartAnchorLattice(0, 0) ? 'obj' : 'null')
tryIt('lattice(6371e3,0)', () => A.createChartAnchorLattice(6371e3, 0) ? 'obj' : 'null')
tryIt('decision(lattice null)', () => P.chartAnchorDecision({ lattice: null, frame: { up: [0, 1, 0] }, dirs: [[0, 1, 0]] }))
const lat = A.createChartAnchorLattice(6371e3)
tryIt('decision(zero-length dir)', () => P.chartAnchorDecision({ lattice: lat, frame: { up: [0, 1, 0] }, dirs: [[0, 0, 0]] }))
tryIt('centroid(zero-length dir)', () => P.playerCentroidDir([[0, 0, 0]]))
tryIt('decision(normal)', () => P.chartAnchorDecision({ lattice: lat, frame: { up: [0, 1, 0] }, dirs: [[0, 1, 0]] }).kind)
console.log(JSON.stringify(out))
