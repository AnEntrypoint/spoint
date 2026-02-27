import { PhysicsWorld } from './src/physics/World.js';

async function testCharacterCollision() {
    console.log('=== Character Collision Test ===');
    
    const world = new PhysicsWorld({ gravity: [0, -9.81, 0] });
    await world.init();
    console.log('Physics world initialized');
    
    // Create floor at y=0 (box with half-height 0.5, positioned at y=-0.5)
    const floorId = world.addStaticBox([10, 0.5, 10], [0, -0.5, 0]);
    console.log('Floor created:', floorId);
    
    // Create character above floor
    const charId = world.addPlayerCharacter(0.4, 0.9, [0, 5, 0], 120);
    console.log('Character created:', charId);
    
    // Simulate 2 seconds of physics
    const dt = 1/60;
    const steps = 120;
    
    console.log(`\nSimulating ${steps} steps (${steps * dt} seconds)...`);
    for (let i = 0; i < steps; i++) {
        // Update character
        world.updateCharacter(charId, dt);
        world.step(dt);
        
        // Check results every 10 steps
        if (i % 10 === 0) {
            const pos = world.getCharacterPosition(charId);
            const vel = world.getCharacterVelocity(charId);
            const onGround = world.getCharacterGroundState(charId);
            console.log(`Step ${i}: pos=${pos[1].toFixed(2)}, vel=${vel[1].toFixed(2)}, onGround=${onGround}`);
        }
    }
    
    // Final state
    const pos = world.getCharacterPosition(charId);
    const vel = world.getCharacterVelocity(charId);
    const onGround = world.getCharacterGroundState(charId);
    console.log(`\nFinal: pos=${pos[1].toFixed(2)}, vel=${vel[1].toFixed(2)}, onGround=${onGround}`);
    
    // Verify character is standing on floor
    const expectedY = 0.0 + 0.4 + 0.9; // floor top y=0 + capsule radius 0.4 + capsule half height 0.9
    const error = Math.abs(pos[1] - expectedY);
    console.log(`Expected y: ${expectedY.toFixed(2)}, Error: ${error.toFixed(3)} meters`);
    console.log(`Should be on ground: ${onGround}`);
    
    world.destroy();
    console.log('\n=== Physics world destroyed ===');
}

testCharacterCollision().catch(err => {
    console.error('ERROR:', err);
    process.exit(1);
});