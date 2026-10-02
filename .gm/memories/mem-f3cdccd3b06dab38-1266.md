---
key: mem-f3cdccd3b06dab38-1266
ns: default
created: 1790940801561
updated: 1790940801561
---

MinimapBiome.sampleMinimapCell must classify biome band and the land flag from the chart-independent ELEVATION (elevationAtLocal(frame,x,groundY,z)) with sea level 0, never from the chart-local render Y (groundHeightLocal minus waterlineLocalY). The two differ by drop(r2,R) - drop(r2,R+elev), which is ~93 m at 28 deg from the anchor on R=63600 (drop(r2,R)=r2/(R+sqrt(R^2-r2))): the same world point therefore lands in a different biome band in every chart, and the land flag h>=seaLevel over-reports land near the chart edge. The climate sample point has the same defect: frame.localToDir(x,z) with y omitted returns the SEA-LEVEL direction, whose parallax from the ground direction is ~0.37 deg (410 m of surface) at 28 deg and elevation 1000 m, so temperature/humidity were read at a different world point per chart. Pass the ground Y: frame.localToDir(x,h,z). Witnessed: route-seam minimap pixel diff fell from max 114/255 (raw biome 107) to the value in the rerun once both were fixed; the height FIELD had already been chart-independent to <0.05 m before the fix, proving the residual was a band-classification artifact and not a sampling or shading difference. MINIMAP_BAKE_CODE_VERSION hashes ../shared/MinimapBiome.js, so editing it auto-invalidates bakes.
