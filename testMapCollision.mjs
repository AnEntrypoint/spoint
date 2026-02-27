import { PhysicsWorld } from './src/physics/World.js';
import { extractAllMeshesFromGLBAsync } from './src/physics/GLBLoader.js';
import { resolve } from 'path';

async function testMapCollision() {
    console.log('=== Map Collision Test ===');
    
    const world = new PhysicsWorld({ gravity: [0, -9.81, 0] });
    await world.init();
    console.log('Physics world initialized');
    
    // Load map
    const mapPath = resolve('./apps/maps/fy_osama_house.glb');
    console.log('Loading map from:', mapPath);
    
    try {
        // Check map scale
        const mapData = await extractAllMeshesFromGLBAsync(mapPath);
        console.log(`Map has ${mapData.vertexCount} vertices, ${mapData.triangleCount} triangles`);
        
        let minY = Infinity, maxY = -Infinity;
        for (let i = 1; i < mapData.vertexCount; i++) {
            const y = mapData.vertices[i * 3 + 1];
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        console.log(`Map Y range: ${minY.toFixed(2)} to ${maxY.toFixed(2)} meters`);
        
        // Add map to physics world
        console.log('Adding map to physics world...');
        const mapBodyId = await world.addStaticTrimeshAsync(mapPath);
        console.log('Map physics body created:', mapBodyId);
        
        // Create character at different heights to test collision
        console.log('\n=== Testing collision at different heights ===');
        const testHeights = [5, 10, 15, 20];
        
        for (const height of testHeights) {
            const charId = world.addPlayerCharacter(0.4, 0.9, [0, height, 0], 120);
            
            // Simulate 1 second of physics
            const dt = 1/60;
            const steps = 60;
            let lastPos = [0, height, 0];
            let hitGround = false;
            
            for (let i = 0; i < steps; i++) {
                const currentVel = world.getCharacterVelocity(charId);
                const onGround = world.getCharacterGroundState(charId);
                let vy
                
                if (onGround) {
                    vy = 0;
                } else {
                    vy = currentVel[1] + world.gravity[1] * dt;
                }
                
                world.setCharacterVelocity(charId, [0, vy, 0]);
                world.updateCharacter(charId, dt);
                world.step(dt);
                
                const pos = world.getCharacterPosition(charId);
                
                if (onGround && !hitGround) {
                    hitGround = true;
                    console.log(`Character hit ground at height ${height}m, landed at y=${pos[1].toFixed(2)}m`);
                }
                
                lastPos = pos;
            }
            
            world.removeCharacter(charId);
        }
        
        world.destroy();
        console.log('\n=== Physics world destroyed ===');
        
    } catch (err) {
        console.error('ERROR:', err);
        world.destroy();
        process.exit(1);
    }
}

testMapCollision().catch(err => {
    console.error('ERROR:', err);
    process.exit(1);
});