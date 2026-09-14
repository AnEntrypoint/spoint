---
key: mem-75fbb3edbf1f4e18-368
ns: default
created: 1789391625292
updated: 1789391625292
---

project/mapspinner-water-visprobe-overreport: the water-visibility probe draw (gl-render, uWaterVisProbe=1) must skip terrain.glsl's vH>1 land discard. It is a coverage query that gates the whole water colour pipeline, so it may only over-report; depth test, vH discard and winding each zeroed coarse-mesh samples -> ocean unrendered at shoreline poses ~90% of frames.
