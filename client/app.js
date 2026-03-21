import * as THREE from 'three'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree; THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree; THREE.Mesh.prototype.raycast = acceleratedRaycast
import { PhysicsNetworkClient, InputHandler, MSG } from '/src/index.client.js'; import { LocalClient } from './LocalClient.js'
import { createElement } from 'webjsx'
import { LoadingManager } from './LoadingManager.js'
import { createLoadingScreen } from './createLoadingScreen.js'
import { MobileControls, detectDevice } from './MobileControls.js'
import { createMobileControlsUI } from './MobileControlsUI.js'
import { createCameraController } from './camera.js'
import { preloadAnimationLibrary, loadAnimationLibrary } from './AnimationLibrary.js'
import { initFacialSystem } from './facial-animation.js'
import { dbDelete, dbPut } from './ModelCache.js'
import { createEditor } from './editor.js'
import { createEditPanel } from './edit-panel.js'
import { createScene, createRenderer, setupLights, createLoaders, fitShadowFrustum, applySceneConfig, warmupShaders, wrapKtx2Cache } from './SceneSetup.js'
import { createPlayerManager } from './PlayerManager.js'
import { createEntityLoader } from './EntityLoader.js'
import { createAppModuleSystem } from './AppModuleSystem.js'
import { createXRSystem } from './XRSystem.js'
import { patchGLB } from './GLBPatch.js'
import { createFileDropLoader } from './FileDropLoader.js'
const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)||(navigator.maxTouchPoints>1&&/Macintosh/.test(navigator.userAgent))
const scene = createScene(), camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.05, 500)
scene.add(camera)
const { renderer, isWebGPU } = await createRenderer(isMobileDevice)
const { ambient, studio, sun } = setupLights(scene), { gltfLoader, ktx2Loader } = createLoaders(renderer)
wrapKtx2Cache(ktx2Loader)
const loadingMgr = new LoadingManager(), loadingScreen = createLoadingScreen(loadingMgr)
loadingMgr.setLabel('Connecting...')
const deviceInfo = detectDevice(); let mobileControls = null, inputConfig = { pointerLock: true }
if (deviceInfo.isMobile) { mobileControls = new MobileControls({ joystickRadius: 45, rotationSensitivity: 0.003, zoomSensitivity: 0.008 }); createMobileControlsUI(mobileControls); inputConfig.pointerLock = false }
const cam = createCameraController(camera, scene)
cam.restore(JSON.parse(sessionStorage.getItem('cam') || 'null')); sessionStorage.removeItem('cam')
const xrSystem = createXRSystem(renderer, scene, camera); xrSystem.setup()
const pm = createPlayerManager(scene, gltfLoader, cam), entityAppMap = new Map()
const uiRoot = document.getElementById('ui-root')
const clickPrompt = document.getElementById('click-prompt')
if (deviceInfo.isMobile && clickPrompt) clickPrompt.style.display = 'none'
const _pids = new Set(), _eids = new Set()
let worldConfig={}, vrmBuffer=null, animAssets=null, assetsLoaded=false, loadingScreenHidden=false, environmentLoaded=false, firstSnapshotReceived=false, _fitShadowTimer=null
const firstSnapshotEntityPending=new Set(), el=createEntityLoader(scene,gltfLoader,cam,loadingMgr,patchGLB,isWebGPU)
const _scheduleFitShadow=()=>{ if (_fitShadowTimer) clearTimeout(_fitShadowTimer); _fitShadowTimer=setTimeout(()=>{_fitShadowTimer=null;fitShadowFrustum(scene,sun)},200) }
let _entityLoadTimeout=null
const _clearEntityPending=()=>{ firstSnapshotEntityPending.clear(); if(_entityLoadTimeout){clearTimeout(_entityLoadTimeout);_entityLoadTimeout=null}; checkAllLoaded() }
const onFirstEntityLoaded=id=>{ if (!environmentLoaded){environmentLoaded=true;checkAllLoaded()}; if (firstSnapshotEntityPending.has(id)){firstSnapshotEntityPending.delete(id);if(firstSnapshotEntityPending.size===0)_clearEntityPending()} }
async function checkAllLoaded() { if (loadingScreenHidden||!assetsLoaded||!environmentLoaded||!firstSnapshotReceived||firstSnapshotEntityPending.size>0) return; loadingScreenHidden=true; loadingMgr.setLabel('Starting game...'); try { await warmupShaders(renderer,scene,camera,el.entityMeshes,pm.playerMeshes,loadingMgr) } catch (_) {}; loadingScreen.hide() }
function _readVrmVersion(b) { try { const av=b instanceof ArrayBuffer?b:b.buffer,dv=new DataView(av),jl=dv.getUint32(12,true),j=JSON.parse(new TextDecoder().decode(new Uint8Array(av,20,jl))); return j.extensions?.VRM?'0':'1' } catch(_){} return '1' }
function initAssets(url) { loadingMgr.setLabel('Downloading player model...'); preloadAnimationLibrary(gltfLoader)
  loadingMgr.fetchWithProgress(url,'vrm').then(async b => {
    const vrmVersion=_readVrmVersion(b)
    const animPromise=loadAnimationLibrary(vrmVersion,null)
    if (url.endsWith('.vrm')) { try { const av=b instanceof ArrayBuffer?b:b.buffer,dv=new DataView(av),jl=dv.getUint32(12,true),j=JSON.parse(new TextDecoder().decode(new Uint8Array(av,20,jl))),exts=j.extensions||{}; if (!exts.VRM&&!exts.VRMC_vrm) { await dbDelete(url); const r=await fetch(url); if (!r.ok) throw 0; b=new Uint8Array(await r.arrayBuffer()); const e=r.headers.get('etag')||''; if (e) dbPut(url,e,b.buffer) } } catch (_) {} }
    vrmBuffer=b; loadingMgr.setLabel('Loading animations...'); animAssets=await animPromise; assetsLoaded=true; checkAllLoaded()
  }).catch(err => { console.warn('[assets]',err?.message); assetsLoaded=true; checkAllLoaded() })
}
const _isSingleplayer = new URLSearchParams(location.search).has('singleplayer'); const ams = createAppModuleSystem(null, uiRoot)
const engineCtx = {
  scene, camera, renderer, THREE, createElement,
  get client() { return client }, get playerId() { return client.playerId }, get cam() { return cam },
  get worldConfig() { return worldConfig }, get inputConfig() { return inputConfig },
  playerVrms: pm.playerVrms, entityAppMap,
  network: { send: msg => client.send(0x33, msg) },
  setInputConfig(cfg) { Object.assign(inputConfig,cfg); if (!inputConfig.pointerLock) { if (clickPrompt) clickPrompt.style.display='none'; if (document.pointerLockElement) document.exitPointerLock() } },
  players: { getMesh: id=>pm.playerMeshes.get(id), getState: id=>pm.playerStates.get(id), getAnimator: id=>pm.playerAnimators.get(id), setExpression: (id,n,v)=>pm.setVRMExpression(id,n,v), setAiming: (id,v)=>{ const s=pm.playerStates.get(id); if (s) s._aiming=v } },
  get mobileControls() { return mobileControls }
}
initFacialSystem(engineCtx)
const _buildEntityData = (id, mesh) => ({ id, position: mesh.position.toArray(), rotation: mesh.quaternion.toArray(), scale: mesh.scale.toArray(), custom: mesh.userData.custom||{}, _appName: mesh.userData._appName||null })
const client = _isSingleplayer ? new LocalClient({ worldDef: await fetch('/singleplayer-world.json').then(r=>r.json()).catch(()=>({})) }) : new PhysicsNetworkClient({
  url: `${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`, predictionEnabled: false, smoothInterpolation: true,
  onStateUpdate: state => {
    const lid=client.playerId
    let i=0; for (const p of state.players) { if (!pm.playerMeshes.has(p.id)) { if (i<32) pm.createPlayerVRM(p.id,vrmBuffer,animAssets,worldConfig,lid); else { const g=new THREE.Group(); scene.add(g); pm.playerMeshes.set(p.id,g) } }; i++ }
    _pids.clear(); for (const p of state.players) _pids.add(p.id)
    _eids.clear(); for (const e of state.entities) _eids.add(e.id)
    for (const [id] of pm.playerMeshes) { if (!_pids.has(id)) pm.removePlayerMesh(id) }
    for (const [id] of el.entityMeshes) { if (!_eids.has(id)) el.removeEntity(id) }
    for (const e of state.entities) {
      const mesh=el.entityMeshes.get(e.id)
      if (mesh&&e.position) { const et=el.entityTargets.get(e.id),vx=e.velocity?.[0]||0,vy=e.velocity?.[1]||0,vz=e.velocity?.[2]||0; if (et) { et.x=e.position[0];et.y=e.position[1];et.z=e.position[2];et.vx=vx;et.vy=vy;et.vz=vz;et.rx=e.rotation?.[0]||0;et.ry=e.rotation?.[1]||0;et.rz=e.rotation?.[2]||0;et.rw=e.rotation?.[3]||1 } else el.entityTargets.set(e.id,{x:e.position[0],y:e.position[1],z:e.position[2],vx,vy,vz,rx:e.rotation?.[0]||0,ry:e.rotation?.[1]||0,rz:e.rotation?.[2]||0,rw:e.rotation?.[3]||1}); _dirty.add(e.id); const dx=e.position[0]-mesh.position.x,dy=e.position[1]-mesh.position.y,dz=e.position[2]-mesh.position.z; if (!mesh.userData.entInit||dx*dx+dy*dy+dz*dz>100) { mesh.position.set(e.position[0],e.position[1],e.position[2]); if (e.rotation) mesh.quaternion.set(e.rotation[0],e.rotation[1],e.rotation[2],e.rotation[3]); mesh.userData.entInit=true } }
      if (!el.entityMeshes.has(e.id)) el.loadEntityModel(e.id,e,entityAppMap,firstSnapshotEntityPending,onFirstEntityLoaded,_scheduleFitShadow,loadingScreenHidden)
    }
    latestState=state; if (!firstSnapshotReceived) { firstSnapshotReceived=true; for (const e of state.entities) { if (e.model&&!el.entityMeshes.has(e.id)&&e.bodyType==='dynamic') firstSnapshotEntityPending.add(e.id) }; if (firstSnapshotEntityPending.size>0) _entityLoadTimeout=setTimeout(_clearEntityPending,5000); checkAllLoaded() }
  },
  onPlayerJoined: id => { if (!pm.playerMeshes.has(id)) pm.createPlayerVRM(id,vrmBuffer,animAssets,worldConfig,client.playerId) },
  onPlayerLeft: id => pm.removePlayerMesh(id),
  onEntityAdded: (id,s) => el.loadEntityModel(id,s,entityAppMap,firstSnapshotEntityPending,onFirstEntityLoaded,_scheduleFitShadow,loadingScreenHidden),
  onEntityRemoved: id => el.removeEntity(id),
  onWorldDef: wd => {
    loadingMgr.setLabel('Syncing with server...'); worldConfig=wd
    const tot=new Set([wd.playerModel,...(wd.entities||[]).map(e=>e.model)].filter(Boolean)).size; if (tot>0) loadingMgr.setFixedTotal(tot)
    if (wd.playerModel) initAssets(wd.playerModel.startsWith('./')?'/'+wd.playerModel.slice(2):wd.playerModel)
    else { assetsLoaded=true; checkAllLoaded() }
    if (wd.entities) for (const e of wd.entities) { if (e.app) entityAppMap.set(e.id,e.app) }
    if (wd.scene) applySceneConfig(wd.scene,scene,ambient,sun,studio,camera)
    if (wd.camera) cam.applyConfig(wd.camera)
    if (wd.input) { inputConfig={pointerLock:true,...wd.input}; if (!inputConfig.pointerLock) clickPrompt.style.display='none' }
  },
  onAppModule: d => ams.loadAppModule(d,engineCtx), onAssetUpdate: ()=>{},
  onAppEvent: payload => { if (payload?.type==='afan_frame'&&payload.playerId&&payload.data) try { pm.applyAfanFrame(payload.playerId,new Uint8Array(payload.data)) } catch (_) {}; ams.dispatchEvent(payload,engineCtx) },
  onHotReload: () => { sessionStorage.setItem('cam',JSON.stringify(cam.save())); location.reload() },
  onEditorSelect: payload => { const {entityId,editorProps}=payload||{}; if (!entityId) return; const mesh=el.entityMeshes.get(entityId); if (mesh) { const d=_buildEntityData(entityId,mesh); editor.selectEntity(entityId,d); editPanel.showEntity(d,editorProps||[]) } },
  onMessage: (type,payload) => { if (type===MSG.APP_LIST) editPanel.updateApps(payload.apps); else if (type===MSG.SOURCE) editPanel.openCode(payload.appName,payload.file||'index.js',payload.source); else if (type===MSG.SCENE_GRAPH) editPanel.updateScene(payload.entities); else if (type===MSG.APP_FILES) editPanel.updateAppFiles(payload.appName,payload.files); else if (type===MSG.EDITOR_PROPS) { const mesh=el.entityMeshes.get(payload.entityId); if (mesh) editPanel.showEntity(_buildEntityData(payload.entityId,mesh),payload.editorProps||[]) } },
  debug: false
})
const editPanel = createEditPanel({
  onPlace: appName => { const local=pm.playerStates.get(client.playerId),yaw=local?.yaw||0,pos=local?[local.position[0]+Math.sin(yaw)*2,local.position[1],local.position[2]+Math.cos(yaw)*2]:[0,0,2]; client.send(MSG.PLACE_APP,{appName,position:pos,config:{}}) },
  onSave: (app,file,src) => client.send(MSG.SAVE_SOURCE,{appName:app,file,source:src}),
  onEntitySelect: id => { const mesh=el.entityMeshes.get(id); if (mesh) { const d=_buildEntityData(id,mesh); editor.selectEntity(id,d); editPanel.showEntity(d,[]); client.send(MSG.GET_EDITOR_PROPS,{entityId:id}) } },
  onGetSource: (app,file) => client.send(MSG.GET_SOURCE,{appName:app,file}),
  onGetAppFiles: app => client.send(MSG.LIST_APP_FILES,{appName:app}),
  onDestroyEntity: id => client.send(MSG.DESTROY_ENTITY,{entityId:id}),
  onCreateApp: app => client.send(MSG.CREATE_APP,{appName:app})
})
const editor = createEditor({ scene, camera, renderer, client, entityMeshes: el.entityMeshes, playerStates: pm.playerStates })
editor.onSelectionChange((id,data) => { if (data) { const mesh=el.entityMeshes.get(id); editPanel.showEntity(mesh?_buildEntityData(id,mesh):data,[]); client.send(MSG.GET_EDITOR_PROPS,{entityId:id}) } })
editor.onEditModeChange(on => { if (on) { if (document.pointerLockElement) document.exitPointerLock(); editPanel.show(); if (!_isSingleplayer) { client.send(MSG.SCENE_GRAPH,{}); client.send(MSG.LIST_APPS,{}) } } else editPanel.hide() })
editPanel.onEditorChange((key,value) => { if (!editor.selectedEntityId) return; const changes=key==='collider'?{custom:{_collider:value}}:key.startsWith('custom.')?{custom:{[key.slice(7)]:value}}:key==='_rotEuler'?{rotation:editor.eulerDegToQuat(value)}:{[key]:value}; const mesh=el.entityMeshes.get(editor.selectedEntityId); if (mesh) { if (changes.position) mesh.position.set(...changes.position); if (changes.rotation) mesh.quaternion.set(...changes.rotation); if (changes.scale) mesh.scale.set(...changes.scale); editor.updateGizmo() }; editor.sendEditorUpdate(changes) })
document.addEventListener('keydown', e => { editor.onKeyDown(e); ams.dispatchKeyDown(e,engineCtx) }); document.addEventListener('keyup', e => ams.dispatchKeyUp(e,engineCtx))
if (!_isSingleplayer) client.send(MSG.LIST_APPS, {}); xrSystem.setupSessionListeners(id=>pm.playerStates.get(id), ()=>client.playerId, { get yaw() { return cam.yaw } })
let inputHandler=null, inputLoopId=null, latestState=null, latestInput=null, lastShootState=false, lastHealth=100, _hierarchyDirty=false, fpsFrames=0, fpsLast=performance.now(), fpsDisplay=0, uiTimer=0, lastFrameTime=performance.now(), _lodCullAt=0, _shadowDirty=true, _shadowLastUpdate=0, _profileFrames=0, _profileSum=0; const _dirty=new Set(), _sinTable=Array(360).fill(0).map((_,i)=>Math.sin(i*Math.PI/180)), _PLAYER_VIS_D2=6400
function startInputLoop() {
  if (inputLoopId) return
  inputHandler=InputHandler({ renderer, snapTurnAngle: xrSystem.vrSettings.snapTurnAngle, smoothTurnSpeed: xrSystem.vrSettings.smoothTurnSpeed, onMenuPressed: ()=>{ if (xrSystem.isPresenting) xrSystem.toggleSettings() } }); if (mobileControls) inputHandler.setMobileControls(mobileControls)
  inputLoopId=setInterval(()=>{
    if (!client.connected) return; const input=inputHandler.getInput(); latestInput=input
    if (!!input.editToggle!==cam.getEditMode()) cam.setEditMode(!!input.editToggle)
    if (input.yaw!==undefined) cam.setVRYaw(input.yaw); else { input.yaw=cam.yaw; input.pitch=cam.pitch }
    if (input.zoom) cam.onWheel({ deltaY: -input.zoom*100, preventDefault: ()=>{} })
    if (input.isMobile&&input.pitchDelta!==undefined) cam.adjustVRPitch(input.pitchDelta)
    xrSystem.handleSettingsInput(input,inputHandler)
    if (input.shoot&&!lastShootState) inputHandler.pulse('right',0.5,100); lastShootState=input.shoot
    const local=pm.playerStates.get(client.playerId); if (local?.health<lastHealth) { inputHandler.pulse('left',0.8,200); inputHandler.pulse('right',0.8,200) }; if (local) lastHealth=local.health
    ams.dispatchInput(input,engineCtx)
    if (cam.getEditMode()) input.forward=input.backward=input.left=input.right=input.jump=input.sprint=input.crouch=false
    client.sendInput(input)
  }, 1000/60)
}
renderer.domElement.addEventListener('click', ()=>{ if (inputConfig.pointerLock&&!document.pointerLockElement&&!cam.getEditMode()) renderer.domElement.requestPointerLock() })
document.addEventListener('pointerlockchange', ()=>{ const locked=document.pointerLockElement===renderer.domElement; clickPrompt.style.display=locked?'none':(inputConfig.pointerLock?'block':'none'); if (locked) document.addEventListener('mousemove',cam.onMouseMove); else document.removeEventListener('mousemove',cam.onMouseMove) })
renderer.domElement.addEventListener('wheel', cam.onWheel, { passive: false }); renderer.domElement.addEventListener('mousedown', e=>ams.dispatchMouseDown(e,engineCtx)); renderer.domElement.addEventListener('mouseup', e=>ams.dispatchMouseUp(e,engineCtx)); renderer.domElement.addEventListener('contextmenu', e=>e.preventDefault())
window.addEventListener('resize', ()=>{ camera.aspect=window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth,window.innerHeight) })
createFileDropLoader(scene, gltfLoader, cam, pm.playerStates, ams.appModules, engineCtx).setupDropListeners(renderer.domElement)
function updatePlayerPositions(players, lid, frameDt) {
  for (const p of players) {
    if (!pm.playerMeshes.has(p.id)) continue
    const mesh=pm.playerMeshes.get(p.id), fo=mesh?.userData?.feetOffset??0.91; let tx,ty,tz,vx=0,vy=0,vz=0
    if (p.id===lid) { const lc=client.getLocalState(); tx=(lc?.position||p.position)[0]; ty=(lc?.position||p.position)[1]-fo; tz=(lc?.position||p.position)[2] }
    else { vx=p.velocity?.[0]||0;vy=p.velocity?.[1]||0;vz=p.velocity?.[2]||0; tx=p.position[0]+vx*frameDt;ty=p.position[1]-fo+vy*frameDt;tz=p.position[2]+vz*frameDt }
    if (!mesh.userData.initialized) { mesh.position.set(tx,ty,tz); mesh.userData.initialized=true } else { mesh.position.x=tx;mesh.position.y=ty;mesh.position.z=tz }
    const ex=pm.playerTargets.get(p.id)
    if (!ex) pm.playerTargets.set(p.id,{x:tx,y:ty,z:tz,vx,vy,vz}); else { if (ex.x!==tx||ex.z!==tz) _shadowDirty=true; ex.x=tx;ex.y=ty;ex.z=tz;ex.vx=vx;ex.vy=vy;ex.vz=vz }
    pm.playerStates.set(p.id,p)
  }
}
function tickPlayerAnimators(lid, frameDt) {
  pm.playerAnimators.forEach((anim,id)=>{
    const ps=pm.playerStates.get(id); if (!ps) return
    const vrm=pm.playerVrms.get(id), mesh=pm.playerMeshes.get(id); if (!mesh) return
    if (!mesh.visible && id !== lid) return
    anim.update(frameDt,ps.velocity,ps.onGround,ps.health,ps._aiming||false,ps.crouch||0)
    const ly=id===lid?cam.yaw:ps.lookYaw
    if (ly!==undefined) { let df=ly-mesh.rotation.y; df-=Math.PI*2*Math.round(df/(Math.PI*2)); const vx=ps.velocity?.[0]||0,vz=ps.velocity?.[2]||0; if (vx*vx+vz*vz<0.25) mesh.rotation.y+=df*Math.min(1,40*frameDt); else { mesh.rotation.y+=df*Math.min(1,5*frameDt); let d2=ly-mesh.rotation.y; d2-=Math.PI*2*Math.round(d2/(Math.PI*2)); if (Math.abs(d2)>Math.PI*0.65) mesh.rotation.y+=d2>0?d2-Math.PI*0.65:d2+Math.PI*0.65 }; mesh.rotation.y-=Math.PI*2*Math.round(mesh.rotation.y/(Math.PI*2)); if (anim.setLookDirection) anim.setLookDirection(ly-mesh.rotation.y,ps.lookPitch||0,mesh.rotation.y+Math.PI,ps.velocity) }
    if (anim.applyBoneOverrides) anim.applyBoneOverrides(frameDt); if (vrm) vrm.update(frameDt)
    pm.updateVRMFeatures(id,frameDt,pm.playerTargets.get(id))
    if (id!==lid&&ps.lookPitch!==undefined) { const f=pm.playerExpressions.get(id); if (f&&!f._headBone&&vrm?.humanoid) f._headBone=vrm.humanoid.getNormalizedBoneNode('head'); if (f?._headBone) f._headBone.rotation.x=-(ps.lookPitch||0)*0.6 }
  })
}
function updateEntityPositions(frameDt, lerpFactor) {
  if (_dirty.size>0) _shadowDirty=true
  for (const id of _dirty) { const t=el.entityTargets.get(id),m=el.entityMeshes.get(id); if (!t||!m) continue; const gx=t.x+(t.vx||0)*frameDt,gy=t.y+(t.vy||0)*frameDt,gz=t.z+(t.vz||0)*frameDt; m.position.x+=(gx-m.position.x)*lerpFactor;m.position.y+=(gy-m.position.y)*lerpFactor;m.position.z+=(gz-m.position.z)*lerpFactor; const dx=t.rx-m.quaternion.x,dy=t.ry-m.quaternion.y,dz=t.rz-m.quaternion.z,dw=t.rw-m.quaternion.w; if (dx*dx+dy*dy+dz*dz+dw*dw>1e-12){m.quaternion.x+=dx*lerpFactor;m.quaternion.y+=dy*lerpFactor;m.quaternion.z+=dz*lerpFactor;m.quaternion.w+=dw*lerpFactor;m.quaternion.normalize()} }
  _dirty.clear()
}
function tickAnimatedEntities(frameDt) {
  for (const m of el._animatedEntities) { if (m.userData.spin) m.rotation.y+=m.userData.spin*frameDt; if (m.userData.hover) { m.userData.hoverTime=(m.userData.hoverTime||0)+frameDt; const c=m.children[0]; if (c) c.position.y=_sinTable[Math.floor(m.userData.hoverTime*2*180/Math.PI)%360]*m.userData.hover } }
}
function animate(ts) {
  const now=ts||performance.now(), frameDt=Math.min(Math.max((now-lastFrameTime)/1000,0.001),0.1); lastFrameTime=now
  fpsFrames++; if (now-fpsLast>=1000) { fpsDisplay=fpsFrames; fpsFrames=0; fpsLast=now }
  const lerpFactor=1.0-Math.exp(-((client.getRTT?.()>100?24:16))*frameDt), ss=client.getSmoothState(now), lid=client.playerId
  updatePlayerPositions(ss.players, lid, frameDt)
  if (_hierarchyDirty&&ss.entities.length>0) { el.rebuildEntityHierarchy(ss.entities); _hierarchyDirty=false }
  tickPlayerAnimators(lid, frameDt)
  updateEntityPositions(frameDt, lerpFactor)
  tickAnimatedEntities(frameDt)
  ams.dispatchFrame(frameDt,engineCtx)
  if (engineCtx.facial) engineCtx.facial.update(frameDt)
  uiTimer+=frameDt; if (latestState&&uiTimer>=0.25) { uiTimer=0; ams.renderAppUI(latestState,engineCtx,scene,camera,renderer,fpsDisplay) }
  const local=client.getLocalState()||pm.playerStates.get(lid)
  if (!xrSystem.isPresenting||cam.getEditMode()) cam.update(local,pm.playerMeshes.get(lid),frameDt,latestInput)
  xrSystem.syncVRPosition(local); xrSystem.update(frameDt,local,ams.appModules,now)
  if (now-_lodCullAt>=50) { const cp=camera.position; for (const m of pm.playerMeshes.values()) { const dx=m.position.x-cp.x,dy=m.position.y-cp.y,dz=m.position.z-cp.z; m.visible=dx*dx+dy*dy+dz*dz<=_PLAYER_VIS_D2 }; el.updateVisibility(camera); _lodCullAt=now }
  if (typeof editor!=='undefined') editor.updateGizmo()
  if (_shadowDirty&&now-_shadowLastUpdate>=66) { renderer.shadowMap.needsUpdate=true; _shadowDirty=false; _shadowLastUpdate=now }
  renderer.render(scene,camera)
  const frameMs=performance.now()-now; _profileSum+=frameMs; if (++_profileFrames>=120) { console.log(`[frame-profile] fps:${fpsDisplay} avg:${(_profileSum/_profileFrames).toFixed(2)}ms players:${pm.playerMeshes.size} entities:${el.entityMeshes.size}`); _profileFrames=0; _profileSum=0 }
}
renderer.setAnimationLoop(animate); client.connect().then(()=>{ console.log('Connected'); startInputLoop(); xrSystem.initAR() }).catch(err=>console.error('Connection failed:',err))
window.debug={ scene, camera, renderer, isWebGPU, client, playerMeshes: pm.playerMeshes, entityMeshes: el.entityMeshes, appModules: ams.appModules, playerVrms: pm.playerVrms, playerAnimators: pm.playerAnimators, loadingMgr, loadingScreen, mobileControls, xrControls: xrSystem.xrControls, controllerModels: xrSystem.controllerModels, controllerGrips: xrSystem.controllerGrips, handModels: xrSystem.handModels, hullMeshes: el._hullMeshes, get showHulls() { return !!window.__showHulls__ }, set showHulls(v) { window.__showHulls__=v; el._hullMeshes.forEach(s=>s.forEach(sg=>{sg.visible=v})) }, vrSettings: ()=>xrSystem.vrSettings, deviceInfo: ()=>deviceInfo, placeARAnchor: ()=>xrSystem.xrControls?.placeAnchor(), setAA: (v) => { console.warn('[renderer] AA change requires page reload. antialias='+v); renderer.domElement.setAttribute('data-aa', v) } }