---
key: mem-5db24ea4a32aa4dd-1317
ns: default
created: 1790745948246
updated: 1790745948246
---

project/veg-variation-strengthened-metrics-and-witness-method-2026-09-30: VegPlacement tint palette strengthened (TINT_WARM [1.22,0.76,0.52] russet, TINT_COOL [0.64,1.07,0.58] green, sat 0.35-1.0, hue 0.55 random + 0.45 season field, pine x0.4 and bush x0.8 tint strength) and a 22% companion genus (oak->ash, ash->aspen, aspen->oak, pine->aspen, hash key K_COMPANION=16); client/core/Vegetation.js tints bark by the tint luminance only, leaves by the full tint. Node (scratchpad vegdiv, real placement code, 192 m squares, 32 m areas) old 23f5d995 -> 35003feb -> now: species x shape combos 6 -> 21 -> 28 at spawn, per-area species 3.0 -> 4.2 -> 5.2, per-area species x shape 3.0 -> 7.6 -> 8.3, scale sd 0.143 -> 0.237, tint chroma 0 -> 0.055 -> 0.113, hue sd 0 -> ~0.8 rad, lean p95 0 -> 5-8 deg. Parity: 60/60 client trees near spawn have a worker trunk collider whose top matches TRUNK[species].h x scale bucket within 1.1 cm. Screenshot trap: the player standing inside the aim_sillos interior (_interior) hides outdoor foliage, so a fixed camera (cam.setMode('fixed')) outside shows no trees unless window.__tpOverride first moves the player mesh outside; wait ~40 s after spawn for far chunks. gm cdp: `session new gpu=amd`, `session new gpu=nvidia`, `session new uncapped` work in gm >= the 2026-09-30 update.
