#!/usr/bin/env bash
set -u
cd /c/dev/spoint
AFTER="C:/Users/user/AppData/Local/Temp/veg-lod-instancer-after.mjs"
git show HEAD:client/core/WebGPULodInstancer.js > client/core/WebGPULodInstancer.js
node scripts/veg-lod-browser-witness.mjs --gpu=nvidia --rebuild-bundle --no-scaling --label=veg-lod-browser-before-f73df536 --still=3 --move=6 --oracle-survivors=251 > .lane-vegstream-page-before.log 2>&1
cp "$AFTER" client/core/WebGPULodInstancer.js
node scripts/bundle-client.mjs > .lane-vegstream-rebundle.log 2>&1
echo DONE
