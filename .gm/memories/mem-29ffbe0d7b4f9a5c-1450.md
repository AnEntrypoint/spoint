---
key: mem-29ffbe0d7b4f9a5c-1450
ns: default
created: 1791208772879
updated: 1791208772879
---

SUPERSEDES project/terrain-heightfield-streamer-spread-players-yield-and-demand-cap-2026-10-05 (its RSS-based cap is wrong). The Jolt wasm heap is a FIXED 128 MiB (134217728 B, no growth); a default world uses ~21 MB; each HeightFieldShape+body costs 44.7 KB wasm at N=128 (measured on real tps-game terrain, 44741 B/field over 64 fields; synthetic 2048 fields: free 112.9 MB -> 21.5 MB), so OOM Aborted would come near 2530 fields on an empty world. HeightfieldStreamer: default cap = 32 MiB / (N*N*4 B) = 512 fields (upper bound; real is ~2.7 B/sample), plus a live guard in pass(): physics.wasmHeapBytes() (World.js, Jolt sGetFreeMemory) free - field bytes must stay >= 64 MiB reserve for dynamic bodies, trunk/rock colliders, trimeshes, characters, otherwise a loud console.error names free/total/reserve/resident fields/uncovered players and no field is added (witnessed: ballast to 64.1 MiB free, 6 players, 1 field kept, refusal line printed, no abort). Spread-ground timings (1 km grid, default cap): 16 players all covered in 12-13 s, 64 players in 47.5-56 s, versus 8 of 16 never more and 60 of 64 in 148 s before; cause of the old 4.5 s/field was setTimeout(0) clamped to ~15 ms on Windows around 2 ms slices (field CPU is 0.6 s) plus one field per pass. Wasm bytes and solver CPU both scale with N^2, so N/2 coarse-first fields for groundless players would cut both 4x (row terrain-coarse-first-fields-for-groundless-players, unmeasured).
