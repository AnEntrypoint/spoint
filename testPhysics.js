const World = require('./src/physics/World.js').PhysicsWorld;

async function testPhysics() {
    console.log('=== Physics World Test ===');
    
    const world = new World({ gravity: [0, -9.81, 0] });
    await world.init();
    console.log('Physics world initialized');
    
    // Test if static box collides with character
    const boxId = world.addStaticBox([5, 5, 5], [0, 0, 0]);
    console.log('Static box created:', boxId);
    
    // Create character above the box
    const charId = world.addPlayerCharacter(0.4, 0.9, [0, 10, 0], 120);
    console.log('Character created:', charId);
    
    // Simulate 2 seconds of physics
    const dt = 1/60;
    const steps = 120;
    console.log(`Simulating ${steps} steps (${steps * dt} seconds)...`);
    
    let lastPos, hitGround = false;
    for (let i = 0; i < steps; i++) {
        const pos = world.getCharacterPosition(charId);
        const onGround = world.getCharacterGroundState(charId);
        
        if (onGround && !hitGround) {
            console.log(`Character hit ground at step ${i}, height: ${pos[1].toFixed(2)}`);
            hitGround = true;
        }
        
        if (lastPos) {
            const vy = pos[1] - lastPos[1];
            if (vy > 0.1) {
                console.log(`Character moving UP at step ${i}: ${vy.toFixed(3)}`);
            } else if (vy < -0.1) {
                console.log(`Character falling at step ${i}: ${vy.toFixed(3)}`);
            }
        }
        
        lastPos = pos;
        world.updateCharacter(charId, dt);
        world.step(dt);
    }
    
    const finalPos = world.getCharacterPosition(charId);
    const onGround = world.getCharacterGroundState(charId);
    
    console.log('\n=== Final Results ===');
    console.log(`Position: [${finalPos[0].toFixed(2)}, ${finalPos[1].toFixed(2)}, ${finalPos[2].toFixed(2)}]`);
    console.log(`On ground: ${onGround}`);
    console.log(`Should be on ground at ~${5.9} (box height 5 + capsule radius 0.4 + half height 0.9)`);
    
    world.destroy();
    console.log('\n=== Physics world destroyed ===');
}

testPhysics().catch(err => {
    console.error('ERROR:', err);
    process.exit(1);
});