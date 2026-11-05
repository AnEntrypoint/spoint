import * as M from '/workspace/spoint/client/hud/MinimapPlacements.js';
const scanner = M.createPlacementScanner();
const out = { exports: Object.keys(M).sort().join(','), scannerKeys: Object.keys(scanner).join(',') };
const refused = scanner.begin(null, null, [], 0, 0, 0, 0);
out.beginOnBadInput = refused === null ? 'null (refused, no handle)' : 'handle returned';
console.log(JSON.stringify(out));