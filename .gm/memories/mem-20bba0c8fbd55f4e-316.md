---
key: mem-20bba0c8fbd55f4e-316
ns: default
created: 1789391555284
updated: 1789391555284
---

project/editor-wm-css-absolute-href: client/editor/EditorShellMenus.js injects /editor/wm/os-token-bridge.css and /editor/wm/wm.css as absolute server paths, not import.meta.url-relative: after scripts/bundle-client.mjs bundles app.js, import.meta.url is the bundle's URL and relative hrefs mis-resolve to /wm/*.css.
