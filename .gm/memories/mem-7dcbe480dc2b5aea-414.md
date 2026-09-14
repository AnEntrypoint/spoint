---
key: mem-7dcbe480dc2b5aea-414
ns: default
created: 1789393182444
updated: 1789393182444
---

project/esbuild-import-specifier-iife-not-concat: esbuild constant-folds 'draco3d'+'gltf' back to a literal import() specifier and resolves it statically, breaking the wrangler edge/DO build. src/physics/DracoDecompressor.js (like apps/_lib/game-fsm.js) wraps the concat in an IIFE; src/physics/World.js getJolt hides its browser path behind a runtime _isNode ternary. Keep these _bundlerOpaque* specifiers opaque.
