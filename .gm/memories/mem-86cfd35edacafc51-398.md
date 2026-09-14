---
key: mem-86cfd35edacafc51-398
ns: default
created: 1789392325178
updated: 1789392325178
---

project/worker-module-no-importmap-bare-specifier: client/workers/OffscreenRenderWorker.js imports three via '/node_modules/three/build/three.module.js', not bare 'three': module Workers do not inherit the document importmap, and a bare specifier throws inside the worker with no message surfaced to main-thread onerror (cross-realm error text suppressed). Any module Worker must import real paths.
