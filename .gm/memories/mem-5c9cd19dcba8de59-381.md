---
key: mem-5c9cd19dcba8de59-381
ns: default
created: 1789391651364
updated: 1789391651364
---

project/cdp-browser-pageerror-only: scripts/lib/cdp-browser.mjs page.on() wires ONLY 'pageerror'; page.on('console', ...) is silently never called, so a 'zero console.error' check through it is vacuous. Capture console errors by injecting a collector via Page.addScriptToEvaluateOnNewDocument and reading it back with evaluate (scripts/verify-app.mjs window.__verifyConsoleErrors).
