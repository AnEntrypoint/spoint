const ammoRead = "(document.body.innerText.split(String.fromCharCode(10)).filter(s=>s.indexOf('/')>0&&s.length<8).slice(-1)[0]||null)"

export const inputBlockerHook = flags => "(()=>{" + flags +
  "const W={blockedInput:0,pageErrors:0,consoleErrors:0,consoleWarns:0,msgs:[]};window.__witness=W;" +
  "for(const n of ['error','warn']){const o=console[n].bind(console);console[n]=(...a)=>{if(n==='error')W.consoleErrors++;else W.consoleWarns++;if(W.msgs.length<30)W.msgs.push(n+': '+a.map(x=>x&&x.stack?x.stack:String(x)).join(' ').slice(0,200));o(...a)}}" +
  "window.addEventListener('error',e=>{W.pageErrors++;if(W.msgs.length<30)W.msgs.push('PAGEERROR '+String(e.message||e).slice(0,200))});" +
  "window.addEventListener('unhandledrejection',e=>{W.pageErrors++;if(W.msgs.length<30)W.msgs.push('REJECTION '+String(e.reason&&e.reason.message||e.reason).slice(0,200))});" +
  "const b=e=>{W.blockedInput++;e.stopImmediatePropagation();e.preventDefault()};" +
  "for(const t of ['pointerdown','pointerup','mousedown','mouseup','click','keydown','keyup','wheel','contextmenu'])window.addEventListener(t,b,{capture:true,passive:false});" +
  "try{Element.prototype.requestPointerLock=function(){W.blockedInput++;return Promise.resolve()}}catch(e){}})();"

const signature = label => "JSON.stringify({frame:'" + label + "',t:new Date().toISOString(),cam:window.__app.cam.save(),ammo:" + ammoRead +
  ",veg:window.__veg.totalInstances,blocked:window.__witness.blockedInput,albedoOverride:window.__albedoOverride,reliefShade:window.__reliefShade===undefined?'default':window.__reliefShade,hazeMul:window.__hazeMul})"

export const settleExpression = minVeg => "(async()=>{const t0=performance.now();" +
  "while(performance.now()-t0<60000){if(window.__app&&window.__app.terrain&&window.__veg&&window.__timeOfDayApi&&window.__app.cam&&window.__rendererInfo)break;await new Promise(r=>setTimeout(r,300))}" +
  "if(!(window.__app&&window.__app.terrain&&window.__veg&&window.__timeOfDayApi&&window.__app.cam))return JSON.stringify({settle:false,reason:'world objects missing',app:!!window.__app,veg:!!window.__veg,msgs:window.__witness&&window.__witness.msgs});" +
  "const T=window.__timeOfDayApi;T.setFractionFromServer=()=>{};T.setPaused(true);T.setFraction(0.45);" +
  "window.__weatherType='clear';window.__weatherIntensity=0;window.__hazeMul=0.4;window.__threeVdrs=false;window.__albedoOverride=[0,0,0,0];delete window.__reliefShade;" +
  "window.__app.cam.restore({yaw:1.0,pitch:0,zoomIndex:2});" +
  "let prev=-1,settled=false;while(performance.now()-t0<115000){await new Promise(r=>setTimeout(r,5000));const v=window.__veg.totalInstances;if(v>=" + minVeg + "&&v===prev){settled=true;break}prev=v}" +
  "const c=window.__app.renderer.domElement;" +
  "return JSON.stringify({settle:settled,veg:window.__veg.totalInstances,elapsedMs:Math.round(performance.now()-t0),href:location.href,cls:window.__rendererInfo.class,backend:window.__rendererInfo.backend,gpu:window.__rendererInfo.glRenderer," +
  "hv:window.__app.terrain.frame.hashVersion,canvas:[c.width,c.height,c.clientWidth,c.clientHeight],dpr:devicePixelRatio,geomorphLod:String(window.__geomorphLod),witness:window.__witness})})()"

const stepExpression = (assign, waitMs, label) => "(async()=>{" + assign + ";await new Promise(r=>setTimeout(r," + waitMs + "));" +
  "let prev=-1;const t0=performance.now();while(performance.now()-t0<20000){const v=window.__veg.totalInstances;if(v===prev)break;prev=v;await new Promise(r=>setTimeout(r,5000))}" +
  "return " + signature(label) + "})()"

const evaluate = expr => ['cdp Runtime.evaluate', JSON.stringify({ expression: expr, awaitPromise: true, returnByValue: true, timeout: 60000 })]
const shot = clip => ['cdp Page.captureScreenshot', JSON.stringify({ format: 'png', clip })]
const SKY_CLIP = { x: 311, y: 39, width: 518, height: 155, scale: 0.25 }
const FULL = { x: 0, y: 0, width: 1036, height: 647, scale: 0.5 }

const frame = (label, clip) => [...evaluate(signature(label)), ...shot(clip)]

export function bootBody({ session, url, minVeg, flags = '' }) {
  return [
    'sessionId=' + session,
    'events Debugger.scriptParsed where url~mapspinner limit=600',
    'events Runtime.exceptionThrown limit=40',
    'cdp Page.enable', 'cdp Network.enable', '{}',
    'cdp Network.setCacheDisabled', '{"cacheDisabled":true}',
    'cdp Network.clearBrowserCache', '{}',
    'cdp Emulation.setDeviceMetricsOverride', '{"width":1036,"height":647,"deviceScaleFactor":1.25,"mobile":false}',
    'cdp Page.addScriptToEvaluateOnNewDocument', JSON.stringify({ source: inputBlockerHook(flags) }),
    'cdp Page.navigate', JSON.stringify({ url }),
    ...evaluate(settleExpression(minVeg)).map((l, i) => i === 1 ? l.replace('"timeout":60000', '"timeout":130000') : l)
  ].join('\n')
}

export function settleBody({ session, minVeg }) {
  return ['sessionId=' + session, ...evaluate(settleExpression(minVeg)).map((l, i) => i === 1 ? l.replace('"timeout":60000', '"timeout":130000') : l)].join('\n')
}

export function captureBody({ session, prefix = '', withSky = true }) {
  const p = s => prefix + s
  const lines = ['sessionId=' + session]
  if (withSky) {
    lines.push(...evaluate(stepExpression("window.__app.cam.restore({yaw:1.0,pitch:0.35,zoomIndex:2})", 2500, p('skyPose'))))
    lines.push(...frame(p('sky-a'), SKY_CLIP), ...frame(p('sky-b'), SKY_CLIP), ...frame(p('skyFull-a'), FULL), ...frame(p('skyFull-b'), FULL))
  }
  lines.push(...evaluate(stepExpression("window.__app.cam.restore({yaw:1.0,pitch:0,zoomIndex:2})", 3000, p('groundPose'))))
  lines.push(...frame(p('ground-a'), FULL), ...frame(p('ground-b'), FULL))
  lines.push(...evaluate(stepExpression("window.__albedoOverride=[0.8,0.8,0.8,1]", 2000, p('greyStep'))))
  lines.push(...frame(p('grey-a'), FULL), ...frame(p('grey-b'), FULL))
  lines.push(...evaluate(stepExpression("window.__reliefShade=1", 2000, p('relief1Step'))))
  lines.push(...frame(p('greyRelief1-a'), FULL), ...frame(p('greyRelief1-b'), FULL))
  lines.push(...evaluate(stepExpression("delete window.__reliefShade;window.__albedoOverride=[0,0,0,0]", 1000, p('restored'))))
  return lines.join('\n')
}

export function leftEdgeBody({ session, extraGlobals = [] }) {
  const lines = ['sessionId=' + session]
  const steps = [
    ['le-grey', "window.__albedoOverride=[0.8,0.8,0.8,1];window.__hazeMul=0.4;delete window.__reliefShade"],
    ['le-greyHaze0', "window.__hazeMul=0"],
    ['le-greyRelief1Haze0', "window.__reliefShade=1"],
    ['le-greyRelief1', "window.__hazeMul=0.4"],
    ...extraGlobals.map(([k, v]) => ['le-extra-' + k.replace(/^__/, ''), 'window.' + k + '=' + v]),
    ['le-greyRelief1ShadowOff', "const R=window.__app.renderer;window.__scene.traverse(o=>{if(o.isLight&&o.castShadow)o.castShadow=false});window.__hostShadowOff=true;if(R.shadowMap){R.shadowMap.enabled=false;R.shadowMap.needsUpdate=true}window.__scene.traverse(o=>{if(o.material){for(const m of [].concat(o.material))m.needsUpdate=true}})"]
  ]
  lines.push(...evaluate(stepExpression("window.__app.cam.restore({yaw:1.0,pitch:0,zoomIndex:2})", 2000, 'le-groundPose')))
  for (const [label, assign] of steps) lines.push(...evaluate(stepExpression(assign, 2500, label + '-step')), ...frame(label, FULL))
  return lines.join('\n')
}

export function dryParse(body) {
  const lines = body.split('\n')
  let checked = 0
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('cdp ')) continue
    const next = lines[i + 1]
    if (!next || next.startsWith('cdp ') || next.startsWith('events ') || next.startsWith('wait ')) continue
    const params = JSON.parse(next)
    if (lines[i].startsWith('cdp Runtime.evaluate')) new Function('return ' + params.expression)
    if (lines[i].startsWith('cdp Page.addScriptToEvaluateOnNewDocument')) new Function(params.source)
    checked++
  }
  return checked
}
