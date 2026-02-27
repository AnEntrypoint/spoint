import { PhysicsWorld } from './src/physics/World.js';

async function debugCharacter() {
    console.log('=== Character Debug ===');
    
    const world = new PhysicsWorld({ gravity: [0, -9.81, 0] });
    await world.init();
    console.log('Physics world initialized');
    
    // Create floor at y=0
    const floorId = world.addStaticBox([10, 0.5, 10], [0, -0.5, 0]);
    console.log('Floor created:', floorId);
    
    // Create character above floor
    const charId = world.addPlayerCharacter(0.4, 0.9, [0, 5, 0], 120);
    console.log('Character created:', charId);
    
    // Debug initial state
    let pos = world.getCharacterPosition(charId);
    let vel = world.getCharacterVelocity(charId);
    let onGround = world.getCharacterGroundState(charId);
    console.log(`\nInitial state:`);
    console.log(`  Position: [${pos[0].toFixed(2)}, ${pos[1].toFixed(2)}, ${pos[2].toFixed(2)}]`);
    console.log(`  Velocity: [${vel[0].toFixed(2)}, ${vel[1].toFixed(2)}, ${vel[2].toFixed(2)}]`);
    console.log(`  On ground: ${onGround}`);
    
    // Try to set velocity
    console.log('\nSetting velocity to [0, -1, 0]:');
    world.setCharacterVelocity(charId, [0, -1, 0]);
    vel = world.getCharacterVelocity(charId);
    console.log(`  Velocity after set: [${vel[0].toFixed(2)}, ${vel[1].toFixed(2)}, ${vel[2].toFixed(2)}]`);
    
    // Simulate 1 step
    const dt = 1/60;
    console.log(`\nSimulating 1 step (${dt} seconds):`);
    
    world.updateCharacter(charId, dt);
    world.step(dt);
    
    pos = world.getCharacterPosition(charId);
    vel = world.getCharacterVelocity(charId);
    onGround = world.getCharacterGroundState(charId);
    console.log(`  Position: [${pos[0].toFixed(2)}, ${pos[1].toFixed(2)}, ${pos[2].toFixed(2)}]`);
    console.log(`  Velocity: [${vel[0].toFixed(2)}, ${vel[1].toFixed(2)}, ${vel[2].toFixed(2)}]`);
    console.log(`  On ground: ${onGround}`);
    
    // Check if floor exists
    console.log('\nPhysics world has bodies:', world.bodies.size);
    for (const [id, body] of world.bodies) {
        const bodyPos = world.getBodyPosition(id);
        const bodyMeta = world.bodyMeta.get(id);
        console.log(`  Body ${id}: pos=${bodyPos[1].toFixed(2)}, type=${bodyMeta.type}, shape=${bodyMeta.shape}`);
    }
    
    world.destroy();
    console.log('\n=== Physics world destroyed ===');
}

debugCharacter().catch(err => {
    console.error('ERROR:', err);
    process.exit(1);
});