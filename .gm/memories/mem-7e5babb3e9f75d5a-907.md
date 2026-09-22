---
key: mem-7e5babb3e9f75d5a-907
ns: default
created: 1790086423556
updated: 1790086423556
---

## Resolved mutable: mut-1790086340414

Root cause: scripts/bundle-client.mjs:52's externalPlugin onResolve filter regex enumerates specific streaming-gltf/* bare specifiers to pass through as external, but was never updated when octahedral-impostor-display-tsl.js was added this session -- even though its path mapping already existed in _bareToAbs (line 43). Only this one new file is actually imported via bare specifier from client code (checked all client/**/*.js for 'from streaming-gltf/' -- the other new TSL files are only imported via relative paths within the streaming-gltf package itself, no exports-map/bundler-regex entry needed). Fixed both scripts/bundle-client.mjs:52's regex and packages/streaming-gltf/package.json's exports map (also missing octahedral-impostor-ez despite it working before, added for consistency). npm run build:client now succeeds cleanly where it previously failed.
