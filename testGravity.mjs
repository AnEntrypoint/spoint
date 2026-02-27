import { PhysicsWorld } from './src/physics/World.js';

async function testCharacterGravity() {
    console.log('=== Character Gravity Test ===');
    
    const world = new PhysicsWorld({ gravity: [0, -9.81, 0] });
    await world.init();
    console.log('Physics world initialized');
    
    // Create character in empty world (no floor)
    const charId = world.addPlayerCharacter(0.4, 0.9, [0, 10, 0], 120);
    console.log('Character created:', charId);
    
    // Check initial state
    let pos = world.getCharacterPosition(charId);
    let vel = world.getCharacterVelocity(charId);
    console.log(`Initial: pos=${pos[1].toFixed(2)}, vel=${vel[1].toFixed(2)}`);
    
    // Simulate 1 second of physics
    const dt = 1/60;
    const steps = 60;
    
    console.log(`\nSimulating ${steps} steps (${steps * dt} seconds)...`);
    for (let i = 0; i < steps; i++) {
        // Get current state
        pos = world.getCharacterPosition(charId);
        vel = world.getCharacterVelocity(charId);
        
        // Apply gravity manually
        const newVy = vel[1] + world.gravity[1] * dt;
        world.setCharacterVelocity(charId, [vel[0], newVy, vel[2]]);
        
        // Update character
        world.updateCharacter(charId, dt);
        world.step(dt);
        
        // Check results
        if (i % 10 === 0) {
            const newPos = world.getCharacterPosition(charId);
            const newVel = world.getCharacterVelocity(charId);
            console.log(`Step ${i}: pos=${newPos[1].toFixed(2)}, vel=${newVel[1].toFixed(2)}`);
        }
    }
    
    // Final state
    pos = world.getCharacterPosition(charId);
    vel = world.getCharacterVelocity(charId);
    console.log(`\nFinal: pos=${pos[1].toFixed(2)}, vel=${vel[1].toFixed(2)}`);
    
    // Verify if character fell
    const expectedFinalY = 10 + 0.5 * world.gravity[1] * Math.pow(steps * dt, 2);
    console.log(`Expected final y: ${expectedFinalY.toFixed(2)}`);
    const error = Math.abs(pos[1] - expectedFinalY);
    console.log(`Error: ${error.toFixed(3)} meters`);
    
    world.destroy();
    console.log('\n=== Physics world destroyed ===');
}

testCharacterGravity().catch(err => {
    console.error('ERROR:', err);
    process.exit(1);
});