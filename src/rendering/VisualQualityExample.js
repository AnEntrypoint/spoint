import * as THREE from 'three';
import {
  TemporalAA,
  QualityPresets,
  DynamicSky,
  createDynamicSkyWithTimeOfDay,
  DecalRenderer,
  DecalType,
  ShadowQualityTier,
  SSAOPresets,
  BloomPresets,
  MotionBlur,
  ColorGradeController,
  VisualQualityTier,
} from './index.js';

const MAX_FRAME_DT_SEC = 0.016;

export function setupVisualQualityFeatures(scene, camera, renderer, opts = {}) {
  const features = {};

  if (opts.enableTAA !== false) {
    features.taa = new TemporalAA(renderer, scene, camera, {
      enabled: true,
      quality: opts.taaQuality ?? 'MEDIUM',
    });
  }

  if (opts.enableSky !== false && opts.timeOfDay) {
    features.sky = createDynamicSkyWithTimeOfDay(
      scene,
      camera,
      opts.timeOfDay,
      opts.sunLight,
      {
        enabled: true,
        cloudScale: 2.0,
        cloudSpeed: 0.5,
      }
    );
  }

  if (opts.enableDecals !== false) {
    features.decals = new DecalRenderer(scene, {
      enabled: true,
      maxDecals: opts.maxDecals ?? 500,
      atlasTexture: opts.decalAtlasTexture,
      atlasGridSize: 4,
    });
    if (opts.decalTargets) {
      features.decals.setRaycasterTargets(opts.decalTargets);
    }
  }

  if (opts.sunLight) {
    const shadowConfig = ShadowQualityTier.apply(
      renderer,
      opts.sunLight,
      opts.shadowQuality ?? 'MEDIUM'
    );
    features.shadowConfig = shadowConfig;
  }

  const visualQuality = VisualQualityTier.getConfig(opts.qualityTier ?? 'MEDIUM');
  features.visualQuality = visualQuality;

  return features;
}

export function createRenderLoopWithVisualQuality(scene, camera, renderer, features, opts = {}) {
  let lastFrameTime = performance.now();

  return function renderLoop() {
    const currentTime = performance.now();
    const dt = Math.min((currentTime - lastFrameTime) / 1000, MAX_FRAME_DT_SEC);
    lastFrameTime = currentTime;

    if (features.sky) {
      features.sky.update(dt);
    }

    if (features.decals) {
      features.decals.update(dt);
    }

    if (features.taa) {
      features.taa.render(() => {
        features.taa.updateCamera();
        renderer.render(scene, camera);
      });
    } else {
      renderer.render(scene, camera);
    }

    if (opts.logPerformance) {
      const updateTime = (features.sky?.updateTime ?? 0) +
                        (features.decals?.updateTime ?? 0) +
                        (features.taa?.updateTime ?? 0);
      console.log(`Frame update time: ${updateTime.toFixed(2)}ms`);
    }
  };
}

export function setupDecalPlacement(renderer, camera, scene, features) {
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  renderer.domElement.addEventListener('click', (event) => {
    if (!features.decals) return;

    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObjects(scene.children, true);

    if (intersects.length > 0) {
      const hit = intersects[0];

      const decal = features.decals.placeDecalDirect(
        hit.point,
        hit.face.normal,
        DecalType.BULLET_HOLE
      );

      if (decal) {
        console.log('Decal placed at', hit.point);
      }
    }
  });
}

export function createDamageEffect(position, normal, features) {
  if (!features.decals) return;

  const decal = features.decals.placeDecalDirect(
    position,
    normal,
    DecalType.BLOOD_SPLATTER
  );

  return decal;
}

export function createExplosionEffect(position, radius, features) {
  if (!features.decals) return;

  const decalCount = 3;
  for (let i = 0; i < decalCount; i++) {
    const angle = (i / decalCount) * Math.PI * 2;
    const offset = new THREE.Vector3(
      Math.cos(angle) * radius * 0.5,
      Math.random() * radius * 0.3,
      Math.sin(angle) * radius * 0.5
    );

    const decalPos = position.clone().add(offset);
    const decalNormal = offset.normalize();

    features.decals.placeDecalDirect(
      decalPos,
      decalNormal,
      DecalType.EXPLOSION
    );
  }
}

export function switchQualityPreset(features, preset) {
  const config = VisualQualityTier.getConfig(preset);

  if (features.taa) {
    const taaQualities = {
      LOW: 'LOW',
      MEDIUM: 'MEDIUM',
      HIGH: 'HIGH',
      ULTRA: 'HIGH',
    };
    features.taa.setQuality(taaQualities[preset] ?? 'MEDIUM');
  }

  features.currentPreset = preset;
  features.qualityConfig = config;

  console.log(`Quality preset switched to: ${preset}`);
}

export function onWindowResize(width, height, features) {
  if (features.taa) {
    features.taa.onWindowResize(width, height);
  }

  if (features.decals) {
  }
}

export function disposeVisualQualityFeatures(features) {
  if (features.taa) {
    features.taa.dispose();
  }

  if (features.sky) {
    features.sky.dispose();
  }

  if (features.decals) {
    features.decals.dispose();
  }
}

export function createVisualQualitySettingsPanel() {
  const panel = document.createElement('div');
  panel.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 15px;
    border-radius: 5px;
    font-family: monospace;
    font-size: 12px;
    z-index: 1000;
  `;

  const content = `
    <div style="margin-bottom: 10px; font-weight: bold;">Visual Quality Settings</div>
    <div style="margin: 5px 0;">
      <label>
        <input type="radio" name="quality" value="LOW"> Low
        <input type="radio" name="quality" value="MEDIUM" checked> Medium
        <input type="radio" name="quality" value="HIGH"> High
        <input type="radio" name="quality" value="ULTRA"> Ultra
      </label>
    </div>
    <div style="margin: 5px 0;">
      <label>
        <input type="checkbox" id="taa-toggle" checked> TAA
      </label>
    </div>
    <div style="margin: 5px 0;">
      <label>
        <input type="checkbox" id="sky-toggle" checked> Dynamic Sky
      </label>
    </div>
    <div style="margin: 5px 0;">
      <label>
        <input type="checkbox" id="decals-toggle" checked> Decals
      </label>
    </div>
    <div style="margin: 5px 0; font-size: 10px; color: #aaa;">
      TAA: <span id="taa-ms">0</span>ms<br>
      Sky: <span id="sky-ms">0</span>ms<br>
      Decals: <span id="decals-ms">0</span>ms
    </div>
  `;

  panel.innerHTML = content;
  document.body.appendChild(panel);

  return {
    element: panel,
    qualityRadios: panel.querySelectorAll('input[name="quality"]'),
    taaToggle: panel.querySelector('#taa-toggle'),
    skyToggle: panel.querySelector('#sky-toggle'),
    decalsToggle: panel.querySelector('#decals-toggle'),
    taaMsLabel: panel.querySelector('#taa-ms'),
    skyMsLabel: panel.querySelector('#sky-ms'),
    decalsMsLabel: panel.querySelector('#decals-ms'),
  };
}

export default {
  setupVisualQualityFeatures,
  createRenderLoopWithVisualQuality,
  setupDecalPlacement,
  createDamageEffect,
  createExplosionEffect,
  switchQualityPreset,
  onWindowResize,
  disposeVisualQualityFeatures,
  createVisualQualitySettingsPanel,
};
