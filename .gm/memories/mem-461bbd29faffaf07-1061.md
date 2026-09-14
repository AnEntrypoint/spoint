---
key: mem-461bbd29faffaf07-1061
ns: default
created: 1789392388365
updated: 1789392388365
---

project/anentrypoint-consumption-and-submodules: AnEntrypoint publishes nothing new to npm, but spoint's kit URLs are PINNED, not @main: bare 'anentrypoint-design' -> https://unpkg.com/anentrypoint-design@1.0.34/dist/247420.js (+ 247420.css stylesheet/preload), 'game-editor-kit' -> jsdelivr gh/AnEntrypoint/design@<sha>/src/components/game-editor-kit/index.js, in client/index.html, client/landing/index.html, client/editor/thebird-host.html and scripts/bundle-client.mjs -- bump all four together; the importmap must precede any module load. wireweave = package.json optionalDependencies github:AnEntrypoint/wireweave (src/ only; importmaps remap to /node_modules/wireweave/src/index.js; Node uses bare import('wireweave'); nostr-tools injected from client/vendor/nostr-tools.mjs). gm = global npx gm-skill install. vendor/design, vendor/wireweave, vendor/gm are editing-only submodules (never imported at runtime): edit on the submodule's main, push to its own remote, commit the new gitlink in spoint. docs/index.html still claims an @latest policy (stale).
