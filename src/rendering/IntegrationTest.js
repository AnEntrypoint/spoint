// Integration Test for Visual Quality Features
// This file provides a minimal test harness to verify all systems work correctly

import * as THREE from 'three';
import {
  TemporalAA,
  DynamicSky,
  DecalRenderer,
  DecalType,
  ShadowQualityTier,
  VisualQualityTier,
} from './index.js';

export class VisualQualityIntegrationTest {
  constructor(opts = {}) {
    this.canvas = opts.canvas || document.createElement('canvas');
    this.canvas.width = opts.width || 1920;
    this.canvas.height = opts.height || 1080;

    // Three.js setup
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: false, // TAA disables need for AA
    });
    this.renderer.setSize(this.canvas.width, this.canvas.height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);
    this.camera = new THREE.PerspectiveCamera(
      75,
      this.canvas.width / this.canvas.height,
      0.1,
      10000
    );
    this.camera.position.set(0, 2, 5);
    this.camera.lookAt(0, 0, 0);

    // Lighting
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1);
    this.sunLight.position.set(50, 100, 30);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.scene.add(this.sunLight);

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(this.ambientLight);

    // Test geometry
    this.createTestGeometry();

    // Visual systems
    this.systems = {};
    this.frameCount = 0;
    this.testResults = {};
  }

  createTestGeometry() {
    // Ground plane
    const groundGeom = new THREE.PlaneGeometry(100, 100);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Test cube (for aliasing evaluation)
    const cubeGeom = new THREE.BoxGeometry(1, 1, 1);
    const cubeMat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    this.testCube = new THREE.Mesh(cubeGeom, cubeMat);
    this.testCube.position.set(0, 1, 0);
    this.testCube.castShadow = true;
    this.testCube.receiveShadow = true;
    this.scene.add(this.testCube);

    // Test sphere (for decal placement)
    const sphereGeom = new THREE.SphereGeometry(0.5, 16, 16);
    const sphereMat = new THREE.MeshStandardMaterial({ color: 0x0088ff });
    this.testSphere = new THREE.Mesh(sphereGeom, sphereMat);
    this.testSphere.position.set(-2, 1, 0);
    this.testSphere.castShadow = true;
    this.testSphere.receiveShadow = true;
    this.scene.add(this.testSphere);

    // Emissive object (for bloom/glow)
    const emissiveGeom = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    const emissiveMat = new THREE.MeshStandardMaterial({
      color: 0xffff00,
      emissive: 0xffff00,
    });
    const emissive = new THREE.Mesh(emissiveGeom, emissiveMat);
    emissive.position.set(2, 1, 0);
    this.scene.add(emissive);
  }

  async initializeSystems(qualityTier = 'MEDIUM') {
    // Mock TimeOfDay provider
    const mockTimeOfDay = {
      getState: () => ({
        elevDeg: 45,
        azimuthDeg: 0,
        dayFraction: 0.5,
      }),
    };

    // 1. TAA
    try {
      this.systems.taa = new TemporalAA(this.renderer, this.scene, this.camera, {
        enabled: true,
        quality: qualityTier === 'LOW' ? 'LOW' :
                 qualityTier === 'HIGH' ? 'HIGH' : 'MEDIUM',
      });
      this.testResults.taa = { status: 'OK', message: 'TAA initialized' };
    } catch (e) {
      this.testResults.taa = { status: 'FAIL', message: e.message };
    }

    // 2. Dynamic Sky
    try {
      this.systems.sky = new DynamicSky(this.scene, this.camera, {
        enabled: true,
        timeOfDayProvider: mockTimeOfDay.getState.bind(mockTimeOfDay),
        sunLight: this.sunLight,
      });
      this.testResults.sky = { status: 'OK', message: 'Sky initialized' };
    } catch (e) {
      this.testResults.sky = { status: 'FAIL', message: e.message };
    }

    // 3. Decal System
    try {
      this.systems.decals = new DecalRenderer(this.scene, {
        enabled: true,
        maxDecals: 100,
        atlasTexture: new THREE.CanvasTexture(this.createTestAtlas()),
        atlasGridSize: 4,
      });
      this.systems.decals.setRaycasterTargets([this.testSphere, this.ground]);
      this.testResults.decals = { status: 'OK', message: 'Decals initialized' };
    } catch (e) {
      this.testResults.decals = { status: 'FAIL', message: e.message };
    }

    // 4. Shadow Quality
    try {
      const shadowConfig = ShadowQualityTier.apply(
        this.renderer,
        this.sunLight,
        qualityTier
      );
      this.systems.shadowConfig = shadowConfig;
      this.testResults.shadows = { status: 'OK', message: 'Shadow config applied' };
    } catch (e) {
      this.testResults.shadows = { status: 'FAIL', message: e.message };
    }

    // 5. Visual Quality Tier
    try {
      this.systems.qualityTier = VisualQualityTier.getConfig(qualityTier);
      this.testResults.quality = { status: 'OK', message: `Quality set to ${qualityTier}` };
    } catch (e) {
      this.testResults.quality = { status: 'FAIL', message: e.message };
    }
  }

  createTestAtlas() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');

    // Draw 16 test patterns (4x4 grid)
    const cellSize = 128;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const px = x * cellSize;
        const py = y * cellSize;

        // Background
        ctx.fillStyle = `hsl(${x * 90}, 100%, 50%)`;
        ctx.fillRect(px, py, cellSize, cellSize);

        // Pattern
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.arc(px + cellSize / 2, py + cellSize / 2, cellSize * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    return canvas;
  }

  runTest(testName, testFn) {
    const startTime = performance.now();
    try {
      testFn();
      const duration = performance.now() - startTime;
      this.testResults[testName] = {
        status: 'PASS',
        duration,
      };
      return true;
    } catch (e) {
      this.testResults[testName] = {
        status: 'FAIL',
        message: e.message,
      };
      return false;
    }
  }

  testTAAEnabled() {
    if (!this.systems.taa) throw new Error('TAA not initialized');
    if (!this.systems.taa.enabled) throw new Error('TAA not enabled');
    if (this.systems.taa.frameIndex === undefined) throw new Error('TAA frameIndex missing');
  }

  testSkyEnabled() {
    if (!this.systems.sky) throw new Error('Sky not initialized');
    if (!this.systems.sky.enabled) throw new Error('Sky not enabled');
    if (this.systems.sky.skyMesh.visible === false) throw new Error('Sky mesh hidden');
  }

  testDecalsInitialized() {
    if (!this.systems.decals) throw new Error('Decals not initialized');
    if (!this.systems.decals.enabled) throw new Error('Decals not enabled');
    if (this.systems.decals.maxDecals !== 100) throw new Error('Max decals incorrect');
  }

  testDecalPlacement() {
    if (!this.systems.decals) throw new Error('Decals not initialized');

    const decal = this.systems.decals.placeDecalDirect(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 1, 0),
      DecalType.BULLET_HOLE
    );

    if (!decal) throw new Error('Failed to place decal');
    if (this.systems.decals.decals.length !== 1) throw new Error('Decal not added to list');
  }

  testPerformance() {
    const startTime = performance.now();

    // Update all systems
    if (this.systems.sky) this.systems.sky.update(0.016);
    if (this.systems.decals) this.systems.decals.update(0.016);
    if (this.systems.taa) this.systems.taa.updateCamera();

    // Render
    this.renderer.render(this.scene, this.camera);

    const duration = performance.now() - startTime;
    if (duration > 20) throw new Error(`Frame time ${duration.toFixed(1)}ms exceeds budget`);
  }

  testMemory() {
    if (this.systems.taa) {
      const rt1 = this.systems.taa.renderTargets.current;
      const rt2 = this.systems.taa.renderTargets.history;
      if (!rt1 || !rt2) throw new Error('TAA render targets not allocated');
    }
  }

  async runAllTests(qualityTier = 'MEDIUM') {
    console.log('=== Visual Quality Integration Tests ===\n');

    // Initialize
    await this.initializeSystems(qualityTier);

    // Run tests
    this.runTest('taa-enabled', () => this.testTAAEnabled());
    this.runTest('sky-enabled', () => this.testSkyEnabled());
    this.runTest('decals-initialized', () => this.testDecalsInitialized());
    this.runTest('decal-placement', () => this.testDecalPlacement());
    this.runTest('performance', () => this.testPerformance());
    this.runTest('memory', () => this.testMemory());

    // Print results
    this.printResults();

    return this.getPassRate();
  }

  printResults() {
    console.group('Test Results');
    let passCount = 0;
    let failCount = 0;

    for (const [name, result] of Object.entries(this.testResults)) {
      const icon = result.status === 'PASS' || result.status === 'OK' ? '✓' : '✗';
      console.log(
        `${icon} ${name}: ${result.status}`,
        result.duration ? `(${result.duration.toFixed(2)}ms)` : '',
        result.message ? `- ${result.message}` : ''
      );

      if (result.status === 'PASS' || result.status === 'OK') passCount++;
      else failCount++;
    }

    console.groupEnd();
    console.log(`\n${passCount}/${passCount + failCount} tests passed`);

    return passCount > 0 && failCount === 0;
  }

  getPassRate() {
    const total = Object.keys(this.testResults).length;
    const passed = Object.values(this.testResults).filter(
      r => r.status === 'PASS' || r.status === 'OK'
    ).length;
    return (passed / total) * 100;
  }

  dispose() {
    if (this.systems.taa) this.systems.taa.dispose();
    if (this.systems.sky) this.systems.sky.dispose();
    if (this.systems.decals) this.systems.decals.dispose();
    this.renderer.dispose();
  }
}

// Quick test runner
export async function runIntegrationTests() {
  const test = new VisualQualityIntegrationTest({
    width: 1920,
    height: 1080,
  });

  for (const tier of ['LOW', 'MEDIUM', 'HIGH']) {
    console.log(`\n=== Testing ${tier} Quality Tier ===`);
    const passRate = await test.runAllTests(tier);
    console.log(`Pass rate: ${passRate.toFixed(1)}%\n`);
  }

  test.dispose();
}

export default VisualQualityIntegrationTest;
