---
key: mem-223db9df8de0fe1c-924
ns: default
created: 1790773419321
updated: 1790773419321
---

project/tsl-amd-webgpu-spawn-remeasure-2026-09-30: AMD Radeon rdna-2 (gm cdp session new gpu=amd, ANGLE D3D11 / Dawn), tps-game singleplayer spawn (-15,3.64,-10.14), default camera, rAF median over 400 frames after settle, AMD engine not shared with other processes (C:/dev/train headless Chrome was on the NVIDIA LUID at ~88%): legacy WebGLRenderer 35 fps (p90 31.8 ms), TSL ?webgpu=1&tslterrain=1 WebGPU backend 73 fps after a 15 s settle (106 fps 8 s after whenSettled). The earlier 26 vs 34 reading does not reproduce: AMD WebGPU spawn is about 2x legacy. Pose/fps helpers: window.__app.cam.restore({yaw,pitch,zoomIndex}) sets the camera (cam.yaw is a getter), window.__timeOfDayApi.setPaused(true)+setFraction(0.4), window.__weatherType='clear', ?at=x,z boot relocation. Other agents share the gm session id: give cdp pages a private sessionId=<name> first line or dispatches queue behind theirs and pages get recycled.
