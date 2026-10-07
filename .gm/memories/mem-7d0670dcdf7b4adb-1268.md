---
key: mem-7d0670dcdf7b4adb-1268
ns: default
created: 1791382155787
updated: 1791382155787
---

spoint fire + weather: rain nullifies fire at the shipped tps-game intensity. src/behaviours/fireWeather.js rainByteOf turns weather intensity 0..1 into a byte via rainPerIntensity 200 (DEFAULT_FIRE_WEATHER, src/behaviours/fireSpec.js:148), so rain 0.6 becomes 120. src/shared/fire/fireKernel.js burnCell rolls (cellHash(...) & 255) < rain on EVERY burning cell EVERY fire step and on a hit sets fuel[g]=0, which settleMask converts to BURNT (losing regrowth too). At 120/255 that is 47% fuel loss per cell per step, so an ignition lives ~2 steps and never builds a front. Measured 2026-10-07 with node scripts/fire-tps-game-witness.mjs (real server, real tps-game world, 2 clients): shipped-weather arm reads 0 active cells after the first ground shot, peak active 0, fire_burn 1 / fire_burn_end 1, fire damage 0.00; the clear-weather arm of the same run reads 9 active cells, peak 236, burning band 124 cells over 310.7 m, fire damage 37.97, LOS blocked (crossedBurning 7). So enabling fire in the world players actually load is a silent no-op. scripts/fire-tps-game-witness.mjs exits 1 on this and is NOT in the WITNESSES list of scripts/fire-witness-gate.mjs, so npm run check never sees it -- a witness absent from the gate is invisible no matter what it reports.
