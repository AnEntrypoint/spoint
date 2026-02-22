# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [0.1.35](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.34...v0.1.35) (2026-02-22)


### Features

* restore playerModel config pointing to Cleetus.vrm ([280784f](https://github.com/AnEntrypoint/spawnpoint/commit/280784f65cc2a20848fc4220ad002f1bf7821e99))

### [0.1.34](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.33...v0.1.34) (2026-02-22)


### Bug Fixes

* remove missing Cleetus.vrm reference, add initAssets error recovery, sync THREE.Cache to skills ([fc2d0a7](https://github.com/AnEntrypoint/spawnpoint/commit/fc2d0a7c778771a3d3698c291c1d2ce064ada548))

### [0.1.33](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.32...v0.1.33) (2026-02-22)


### Bug Fixes

* compileAsync warmup for all dynamic GLB/mesh loads ([0d5a9bd](https://github.com/AnEntrypoint/spawnpoint/commit/0d5a9bda47ddded84296a53af6414b3e757aed60))

### [0.1.32](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.31...v0.1.32) (2026-02-22)

### [0.1.31](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.30...v0.1.31) (2026-02-22)

### [0.1.30](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.29...v0.1.30) (2026-02-22)

### [0.1.29](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.28...v0.1.29) (2026-02-22)

### [0.1.28](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.27...v0.1.28) (2026-02-22)

### [0.1.27](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.26...v0.1.27) (2026-02-22)

### [0.1.26](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.25...v0.1.26) (2026-02-22)

### [0.1.25](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.24...v0.1.25) (2026-02-22)

### [0.1.24](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.23...v0.1.24) (2026-02-22)

### [0.1.23](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.22...v0.1.23) (2026-02-22)

### [0.1.22](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.21...v0.1.22) (2026-02-22)


### Bug Fixes

* improve THREE.js loader configuration and error handling ([35b0ace](https://github.com/AnEntrypoint/spawnpoint/commit/35b0ace8ef78bcb4e6832ad77574e99c5c010004))

### [0.1.21](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.20...v0.1.21) (2026-02-22)


### Bug Fixes

* provide Node utility stubs in app module evaluation ([bfdbc9b](https://github.com/AnEntrypoint/spawnpoint/commit/bfdbc9b72f6b813bb95f69456679e901b308b9d4))

### [0.1.20](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.19...v0.1.20) (2026-02-22)


### Bug Fixes

* handle import.meta.url in app module evaluation ([9ca5692](https://github.com/AnEntrypoint/spawnpoint/commit/9ca56929cdb695cfd71eddc10137a34dd41f45c8))

### [0.1.19](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.18...v0.1.19) (2026-02-22)


### Features

* bundle DRACO decoder files locally for self-contained GLB loading ([1269d22](https://github.com/AnEntrypoint/spawnpoint/commit/1269d22206fee3499eeaef85ca8916e045d3841d))


### Bug Fixes

* simplify publish workflow to use standard-version auto-bump ([f6995d3](https://github.com/AnEntrypoint/spawnpoint/commit/f6995d32a80dba88c6d6f988687a97981c645ec7))

### 0.1.18 (2026-02-22)


### Features

* 5 bodyshots or 2 headshots to kill, top 70% is headshot zone ([de43944](https://github.com/AnEntrypoint/spawnpoint/commit/de43944484496c577ae72aea7f42fb7c09515bc0))
* add /editor/ route serving three.js editor connected to live game scene ([925ef44](https://github.com/AnEntrypoint/spawnpoint/commit/925ef44b9164ae4526b1e45ff886462a8f45df21))
* add comfort vignette for VR movement ([dd2394a](https://github.com/AnEntrypoint/spawnpoint/commit/dd2394ae9c696970aa4124c268b2a4b47bd13c51))
* add comprehensive animation retargeting diagnostics ([1f2fc6c](https://github.com/AnEntrypoint/spawnpoint/commit/1f2fc6ce57f567470e4e16eceac2b84a2de66546))
* add comprehensive spoint-app-creator skill with CLI, documentation, and templates ([705c441](https://github.com/AnEntrypoint/spawnpoint/commit/705c441c19c676c88606245efc87272f2e5a0976))
* add crouch capsule resizing for physics ([02892ce](https://github.com/AnEntrypoint/spawnpoint/commit/02892ce8b50ca51d56740f6806d6e7a45edc0dd5))
* add crouch mode (Ctrl) and network look direction ([ed3fc8d](https://github.com/AnEntrypoint/spawnpoint/commit/ed3fc8dc68130af21ef70254be36a4a266575600))
* add fade-to-black during teleport for comfort ([6fbe742](https://github.com/AnEntrypoint/spawnpoint/commit/6fbe7425c7af63803748853d293d314c834845fe))
* Add memory profiling to tick handler (every 10s) ([e28d6e8](https://github.com/AnEntrypoint/spawnpoint/commit/e28d6e8d4b0f523cfd6b0cc1b0ef06d4cc8550de))
* Add Nixpacks config for Coolify deployment ([5eefa7b](https://github.com/AnEntrypoint/spawnpoint/commit/5eefa7b660e0572f2649a01dcbeabebeed6ab09f))
* add ping/pong heartbeat with RTT tracking ([b872aeb](https://github.com/AnEntrypoint/spawnpoint/commit/b872aeb08cc5aaf5741fe1370073e36e6634ff50))
* Add player speed indicator to HUD ([59cbe75](https://github.com/AnEntrypoint/spawnpoint/commit/59cbe7580ba6de37ddbac9d8d8925de98da9d71a))
* add scaffold command and SKILL.md for skills npm package ([f0696c9](https://github.com/AnEntrypoint/spawnpoint/commit/f0696c91c34a3c27b0145d9aec404e1ed55c41c9))
* add skills directory and skills-lock.json ([c27db69](https://github.com/AnEntrypoint/spawnpoint/commit/c27db6911c0a9cc29d22a1fed705966c19bbdf7d))
* Add SSAO post-processing for ambient occlusion ([9608b95](https://github.com/AnEntrypoint/spawnpoint/commit/9608b958fdbcc3cf3de0c89f17230d3acc7f3e25))
* add VR settings panel and configurable snap turn angle ([4351117](https://github.com/AnEntrypoint/spawnpoint/commit/4351117f33f261b73bf6a8df0811348039e33671))
* add WebXR hand tracking support with gesture detection ([6131552](https://github.com/AnEntrypoint/spawnpoint/commit/613155243317744a475c5310e24f3fd09666ee92))
* Add WebXR VR support with joystick locomotion ([c942938](https://github.com/AnEntrypoint/spawnpoint/commit/c942938c763b6600a5a6b68c343ebb2da47f08d2))
* Add WebXR VR support with joystick locomotion ([59f8dc6](https://github.com/AnEntrypoint/spawnpoint/commit/59f8dc6eb098641a7a48410b746bccaba73f4c11))
* add wrist-mounted VR UI with health and ammo display ([7d52470](https://github.com/AnEntrypoint/spawnpoint/commit/7d524705a81a139a21d1a62964081fb1f50271ec))
* add Y/B button reload and ammo system to TPS game ([f7c449d](https://github.com/AnEntrypoint/spawnpoint/commit/f7c449d6d8aff4af8a3acf76c9e6c68a6f73f92b))
* Additive animation blending for shooting and aiming ([8ba4dd3](https://github.com/AnEntrypoint/spawnpoint/commit/8ba4dd3fb6591474ff95a55cc533088eb576e644))
* AR view localization and mobile performance optimization ([0a4a7d8](https://github.com/AnEntrypoint/spawnpoint/commit/0a4a7d8dbc18bd97fe0c42e37f3756f0d2fa955f))
* attach FPS camera to head bone with forward offset ([7e59111](https://github.com/AnEntrypoint/spawnpoint/commit/7e591118ccf0c8ee882c4a644eff8581ae7f69b5))
* Auto-reconnect with session restore, fix session TTL ([c2b7d38](https://github.com/AnEntrypoint/spawnpoint/commit/c2b7d382483c1da4eda0c65bf943aa3739045db4))
* auto-scaffold on boot ([a0cbd88](https://github.com/AnEntrypoint/spawnpoint/commit/a0cbd8873fa3bded16cc2e52f9c6ed91f7977132))
* crouch on C key, smooth camera, cache models, FPS player visible, ammo flash fix, crouch anim ([f4dc067](https://github.com/AnEntrypoint/spawnpoint/commit/f4dc067739f9f3196607157acd48f874a365f53a))
* disable teleport by default, add toggle in VR settings panel ([cf8e43a](https://github.com/AnEntrypoint/spawnpoint/commit/cf8e43a5277c66fda83fc788e996e64b0e801cdd))
* enhance mobile controls with interactable functionality and reload animations ([26450e7](https://github.com/AnEntrypoint/spawnpoint/commit/26450e7e1b6d3bd6beb4f1ecf9251eaa2e90c0b4))
* Enhanced three-vrm integration - VRM 0.x rotation fix, humanoid API, expressions, lookAt, spring bones ([1f15a6f](https://github.com/AnEntrypoint/spawnpoint/commit/1f15a6fc717e6dbc13f855138e116a8d7019b1e0))
* FPS camera on neck bone, shrink head instead of hiding model ([d97e60c](https://github.com/AnEntrypoint/spawnpoint/commit/d97e60c2fb6c3d40594c9b5dd54fcc9d2edfb4ac))
* full-featured dual joystick mobile controls ([ac8738a](https://github.com/AnEntrypoint/spawnpoint/commit/ac8738ad11529edf323d274c5069bfccf4da35a5))
* implement edit mode with model drag-and-drop support ([d500450](https://github.com/AnEntrypoint/spawnpoint/commit/d50045063672f06d7add07b9fbda53e30c38febf))
* implement hierarchical model placement system with smart objects ([0b5f11d](https://github.com/AnEntrypoint/spawnpoint/commit/0b5f11d0a98966446b78b10516a0dcac10e9ad1c))
* Kalman filter + jitter buffer for smooth netcode ([063b51e](https://github.com/AnEntrypoint/spawnpoint/commit/063b51eb7459680c974aed6e7e23bde2a0cab14b))
* Knockback and aim punch on shooting and getting hit ([89e697e](https://github.com/AnEntrypoint/spawnpoint/commit/89e697ed75392f324e887e6cb4bb98e5dc0b83f8))
* Loading screen waits for all assets, push anim + boost heal ([6daecb4](https://github.com/AnEntrypoint/spawnpoint/commit/6daecb420bf76806598521e8d0a0610dfcf62638))
* Merge local and SDK apps directories with local-first override ([a72fbfe](https://github.com/AnEntrypoint/spawnpoint/commit/a72fbfeb97bce4e6d1acbfc73019dacaf9d59c58))
* Migrate game config to apps, add app-controllable camera and input modes ([e956174](https://github.com/AnEntrypoint/spawnpoint/commit/e956174272626ecbbfd96ed1575382d40ff4b599))
* P key toggle, engine interactable API, confirm no THREE coupling in src/ ([97091cf](https://github.com/AnEntrypoint/spawnpoint/commit/97091cf0a2b07cdbbf1122bc48aedaafc55d5e86))
* PistolShoot overrides upper body instead of additive blend ([47ca340](https://github.com/AnEntrypoint/spawnpoint/commit/47ca340475b23497f0945f9396167e4318aecd2e))
* Powerup coins spin/hover, crates fall with physics ([9287c9b](https://github.com/AnEntrypoint/spawnpoint/commit/9287c9ba67526dc322d1d9822bfe778b4ef83747))
* Push velocity triggers walk anim + model rotation, boost heals over 10s ([64a53f8](https://github.com/AnEntrypoint/spawnpoint/commit/64a53f8f7d8d471a50f1824c86b15188eb928ff0))
* refine mobile controls initialization and pointer lock handling ([838a300](https://github.com/AnEntrypoint/spawnpoint/commit/838a300345b9c6b65e453e1c2e5d4e3fb875e10e))
* run skills install after scaffold copies apps/ ([f570b53](https://github.com/AnEntrypoint/spawnpoint/commit/f570b535477596be8a0c22fe6a758859ff796ef8))
* Trigger PistolShoot animation on gunfire ([2561f9b](https://github.com/AnEntrypoint/spawnpoint/commit/2561f9bb9e444b09f2f38a3527b365d432afb72e))
* update mobile controls and input handling for improved responsiveness ([3533f6e](https://github.com/AnEntrypoint/spawnpoint/commit/3533f6e29c7d4019243e1bd5190f94dcfb955029))
* WebXR VR Phase 2 - Controller visualization, haptics, teleportation ([1a7034e](https://github.com/AnEntrypoint/spawnpoint/commit/1a7034e34778bfc765600fe8294824a3ae0492a9))


### Bug Fixes

* 3x aim punch intensity (0.3 -> 0.9) ([c61706b](https://github.com/AnEntrypoint/spawnpoint/commit/c61706b7e34947f86693e103273f59fdab37bb11))
* 3x faster aim punch decay (6 -> 18) for quicker settle ([600928d](https://github.com/AnEntrypoint/spawnpoint/commit/600928d8771e5411b86590eaebc26b0956e38b21))
* 3x faster aim punch lerp (108 -> 324) ([ae69575](https://github.com/AnEntrypoint/spawnpoint/commit/ae695756c36f45970eb800e1962ff6957546ec53))
* 3x faster aim punch lerp (12 -> 36) ([1b84fb6](https://github.com/AnEntrypoint/spawnpoint/commit/1b84fb679d7149fd0fa965f0ea5348d6fcc05aa0))
* 3x faster aim punch lerp (324 -> 972) ([46a08eb](https://github.com/AnEntrypoint/spawnpoint/commit/46a08eb792d3ccd50b2aa1af5efa2c9f9dc09438))
* 3x faster aim punch lerp (36 -> 108) ([e30171b](https://github.com/AnEntrypoint/spawnpoint/commit/e30171b9a66b48c2187e5850d843777a4876e4c4))
* 3x stronger aim punch with more random direction ([1c1dc48](https://github.com/AnEntrypoint/spawnpoint/commit/1c1dc48062ecc8843f1da0b01a4e7ad2f1643c30))
* 4096 shadow map + balanced bias to close corner light leaks ([1973616](https://github.com/AnEntrypoint/spawnpoint/commit/1973616e3516e7986d56fa9098bc69e305c6daf8))
* Add blue studio light, soft yellow ambient, reduce shadows to 512 ([2160cb4](https://github.com/AnEntrypoint/spawnpoint/commit/2160cb4d22a06190c6c4462ad57c964e87c1ed40))
* Add camera fill light to prevent black shadows when facing away ([7ef7406](https://github.com/AnEntrypoint/spawnpoint/commit/7ef74063d8b9cefab6037200e0365b6e8bfd7870))
* add error handling to setCharacterCrouch ([fb49d4b](https://github.com/AnEntrypoint/spawnpoint/commit/fb49d4bdac89d0718cb481696b490f3a65632c5c))
* Add shadow radius 4 to widen the dark shadow area ([ee79471](https://github.com/AnEntrypoint/spawnpoint/commit/ee7947120d9ef55c7ba914fc1f470bc834fd9e11))
* Add small normalBias 0.05 to bleed shadow edges out 1px ([aeac761](https://github.com/AnEntrypoint/spawnpoint/commit/aeac761cec180b666a45d3e29835f9963da6e4c5))
* Adjust VSM shadow bias to reduce washed out appearance ([2d06e50](https://github.com/AnEntrypoint/spawnpoint/commit/2d06e5066f744dbabed6c8e8f60b3d874143ca99))
* All crates get physics, hitbox follows fallen position ([8045387](https://github.com/AnEntrypoint/spawnpoint/commit/8045387ee4bee2682a45f7125449e98cdf73a14d))
* Apply coin hover offset to child mesh to prevent flicker ([e4d9a26](https://github.com/AnEntrypoint/spawnpoint/commit/e4d9a264e990023d8ca1f8144268ed606ce3e760))
* Apply tuned shadow settings - VSM, bias 0.0026, normalBias 0.87, radius 6.5, mapSize 1024, sun at [21,50,20] intensity 1.5 ([3e9015d](https://github.com/AnEntrypoint/spawnpoint/commit/3e9015d9667a7cf52ca969fce01e0f681153333a))
* attach FPS camera to head bone with proper world matrix update ([3421e6b](https://github.com/AnEntrypoint/spawnpoint/commit/3421e6b781c44ad9dcd85cc62973f182b6b34fdb))
* bump to 0.1.17 with DRACO loader support ([be8e83a](https://github.com/AnEntrypoint/spawnpoint/commit/be8e83ab43fad12d4f47e11da2ffaa026d96d06e))
* cap power crate spawning to prevent unbounded entity accumulation ([8934bd1](https://github.com/AnEntrypoint/spawnpoint/commit/8934bd14da740d449f39a1dcda2852bb542fe278))
* Change default port from 8080 to 3000 ([5afacaa](https://github.com/AnEntrypoint/spawnpoint/commit/5afacaaaff5fee38c9b3cf4b19680638ee1bc3f7))
* Clamp death animation and add fall respawn after 5s ([2612a4e](https://github.com/AnEntrypoint/spawnpoint/commit/2612a4e1b7389ed858a7b7eef89ce3a03a4429a9))
* configure git author in bump-version workflow ([f132bf7](https://github.com/AnEntrypoint/spawnpoint/commit/f132bf72ab325991929c539947ffeaa3aaf53fc7))
* Convert VRM MToon materials to MeshStandard for light-dependent shadows ([94cdc57](https://github.com/AnEntrypoint/spawnpoint/commit/94cdc57f227fd255cfa112c2bc379e1d652819e4))
* correct retargetClip parameter order and add findSkinnedMesh helper ([9cf9b32](https://github.com/AnEntrypoint/spawnpoint/commit/9cf9b3253c98985af171bb973587bf609b1993c8))
* crouch by adjusting player height instead of shape swap ([ee4c654](https://github.com/AnEntrypoint/spawnpoint/commit/ee4c6542ad2216b1ecafe345a8e88f3dd3945803))
* Decouple feet placement from scale - feet always at ground level ([4b4d180](https://github.com/AnEntrypoint/spawnpoint/commit/4b4d180a8be95338bd058beda9a416aef711c5aa))
* Destroy all characters in physics world destroy method ([607dff6](https://github.com/AnEntrypoint/spawnpoint/commit/607dff689dc4becacd3e093d6f4c13a2276998ee))
* Destroy Jolt CharacterVirtual objects on remove to prevent WASM heap corruption ([a309456](https://github.com/AnEntrypoint/spawnpoint/commit/a309456f50589f545fc82898f38f54d1d9798452))
* Destroy Jolt getter return objects to stop WASM heap leak ([6081f4d](https://github.com/AnEntrypoint/spawnpoint/commit/6081f4d08f31a0c1ed0d95f87e2e60e77217f9e7))
* Double light intensity to reduce player shadows ([7fddb87](https://github.com/AnEntrypoint/spawnpoint/commit/7fddb87a22a18aadadd5f9ada4828a4c405d359f))
* Double shadow frustum to 240x240 units to cover full map ([4b539ab](https://github.com/AnEntrypoint/spawnpoint/commit/4b539ab33cc1fecefa1de6aec37fec8080d25466))
* Double shadow map resolution to 4096 ([bc0116f](https://github.com/AnEntrypoint/spawnpoint/commit/bc0116f7e0dc885969aa0e3f03d6066a7fe4e7a6))
* Double shadow radius to 8 ([c9271c7](https://github.com/AnEntrypoint/spawnpoint/commit/c9271c7f3faf5245743b565fdfff744d1308c572))
* DoubleSide shadows, bias -0.001 ([b567e9d](https://github.com/AnEntrypoint/spawnpoint/commit/b567e9dc88f19e198e9096dbf5d3d1b5469b1340))
* Dynamic feet-to-ground offset from capsule height, works at any scale ([c1cbbb7](https://github.com/AnEntrypoint/spawnpoint/commit/c1cbbb732ab978ca92f4cfdce7fef0ea080b4cea))
* eliminate ghost players on network lag and tab inactivity ([fe03b97](https://github.com/AnEntrypoint/spawnpoint/commit/fe03b97c74f279086da25fbdea3f45dccc1af88b))
* Eliminate server lag at high tick counts ([b9c458c](https://github.com/AnEntrypoint/spawnpoint/commit/b9c458ca26d4c1b34b15c755852461e50c40f70f))
* enable DRACO loader for compressed GLB model support ([8ffc126](https://github.com/AnEntrypoint/spawnpoint/commit/8ffc1264a0b76c46fd612b5e071ab9dedc46e1ca))
* Entity removal detection + cleanup unused files ([ecc1da9](https://github.com/AnEntrypoint/spawnpoint/commit/ecc1da913bf720b521052e922d8910eb16c4eee7))
* entity scale via custom.scale, client app teardown on hot reload, doc updates ([a8e454e](https://github.com/AnEntrypoint/spawnpoint/commit/a8e454e00b19a7b207287efb4ed74dfd17046215))
* Expand shadow frustum 3% ([589e7e9](https://github.com/AnEntrypoint/spawnpoint/commit/589e7e9b2219d6883fe0ca3793d267152ac9a23b))
* Expand shadow frustum to 6% ([13a3068](https://github.com/AnEntrypoint/spawnpoint/commit/13a306827e914ab1ccebf982ce5d8a66c0e4b0b6))
* Extend shadows into wall corners/edges ([26f833a](https://github.com/AnEntrypoint/spawnpoint/commit/26f833a97b1c1bef7dab1625a094ca01dd9dc5d8))
* filter invalid animation tracks before mixing to eliminate PropertyBinding errors ([62d395b](https://github.com/AnEntrypoint/spawnpoint/commit/62d395b69eb79b56dbead410928075020ad438a0))
* FPS raycast pulls camera back from walls instead of into them ([b56c550](https://github.com/AnEntrypoint/spawnpoint/commit/b56c55084220bc6d4a28d274544ab1194cafd6a8))
* ghost players on tab close - detach transport on reconnect, emit before remove ([d0a9777](https://github.com/AnEntrypoint/spawnpoint/commit/d0a97771f37f44243a12ee42b764b25c40ceb7a0))
* Halve shadow bias to 0.0005 ([8a88059](https://github.com/AnEntrypoint/spawnpoint/commit/8a880598f5041d510b8af0e07f729394bf158116))
* Hot-reload movement.js with cache busting ([38a9b00](https://github.com/AnEntrypoint/spawnpoint/commit/38a9b00d5d5a1cb3734804e57a565ee207841f52))
* Hot-reload world config (movement/jump settings) ([c0b024c](https://github.com/AnEntrypoint/spawnpoint/commit/c0b024c2ee4788f7be6b328702f8eaa7bf6fdc6e))
* implement backward raycast for FPS wall collision and push head down ([18f142d](https://github.com/AnEntrypoint/spawnpoint/commit/18f142d5f3322f76d36d1b0735ff30c96026c9bf))
* implement responsive mobile controls layout for all device sizes ([3ad1438](https://github.com/AnEntrypoint/spawnpoint/commit/3ad1438d6713e22436e849c7cb4b9926ae7e704c))
* Improve Firefox fullscreen performance ([8fbc1dc](https://github.com/AnEntrypoint/spawnpoint/commit/8fbc1dc597124f7b831fce7c3eaef629819f9b98))
* Increase all animation speed by 20% ([295e834](https://github.com/AnEntrypoint/spawnpoint/commit/295e834a1e035e930defbd8ab8b3596357a9bdae))
* Increase animation speed to 1.3x ([60ad6ca](https://github.com/AnEntrypoint/spawnpoint/commit/60ad6ca09c0a6268c24788e603275e7126b9ce50))
* Increase emissive fill to prevent dark shadows on player ([4415dcc](https://github.com/AnEntrypoint/spawnpoint/commit/4415dcc7ea03aebe6da7f8cfca5d928f7d44a8a8))
* increase FPS forward offset to clear neck area ([1fce7b4](https://github.com/AnEntrypoint/spawnpoint/commit/1fce7b4ab4863f619aaf7cc7b4808e915d4c90f2))
* Increase normalBias to 0.25 (~1 shadow texel at 512 res) ([f9d49ee](https://github.com/AnEntrypoint/spawnpoint/commit/f9d49eeed2aaf05d80fbc55848a0ef3882bb3017))
* Increase player mass from 160 to 320 for heavier feel ([c637be5](https://github.com/AnEntrypoint/spawnpoint/commit/c637be5abbf55220596cce73769ed5a3de257055))
* Increase shadow normalBias to 0.04 ([6ee6cbf](https://github.com/AnEntrypoint/spawnpoint/commit/6ee6cbfd58b1d691fbb2a9c2ce8f7533e14ed465))
* Increase shadow normalBias to 0.08 ([6c4f6e7](https://github.com/AnEntrypoint/spawnpoint/commit/6c4f6e7bee2e7eff83dc84e1010dbd7fd9cc8a71))
* Increase shadow normalBias to 0.15 ([4623c09](https://github.com/AnEntrypoint/spawnpoint/commit/4623c092f7d2792c6ba0448a4f41b7c4627c4720))
* Increase shadow normalBias to 0.3 to close corner light leaks ([b20cf36](https://github.com/AnEntrypoint/spawnpoint/commit/b20cf3609f0a7523081674fd68a0642b6a320f24))
* initialize buttons Map in MobileControls constructor ([87dbb00](https://github.com/AnEntrypoint/spawnpoint/commit/87dbb006cc2ff47086a451222236f0b457be5f48))
* install spoint skill for all agents at project level on scaffold ([fbb6e46](https://github.com/AnEntrypoint/spawnpoint/commit/fbb6e46b4ad96879443112a814cac35b39fb129d))
* Jolt WASM memory leak causing progressive server lag ([de3f8c6](https://github.com/AnEntrypoint/spawnpoint/commit/de3f8c6e6e0f900f2479e31d85de3de7ab7c512b))
* larger FPS wall detection with multi-directional rays ([357360f](https://github.com/AnEntrypoint/spawnpoint/commit/357360fe96029c7ddd6d2b035ae4952811817052))
* Limit additive animations to upper body only ([0329b70](https://github.com/AnEntrypoint/spawnpoint/commit/0329b70a318cea651947b944f51ba7f749b4fc5a))
* Loading screen waits for VRM and animations to fully load before hiding ([3f6b065](https://github.com/AnEntrypoint/spawnpoint/commit/3f6b065f28d35efb8c55564f791de8884e199d99))
* Lower player model offset to -1.6 ([1e7519b](https://github.com/AnEntrypoint/spawnpoint/commit/1e7519bb762d050fcf7e7a8e0fdd145628f6d1cf))
* Lower sprint animation threshold to 6.0 for new speed settings ([283b0fe](https://github.com/AnEntrypoint/spawnpoint/commit/283b0fea813216fe6bbf893bd9b86f5824199c85))
* Make players physically collide with position separation ([b59466e](https://github.com/AnEntrypoint/spawnpoint/commit/b59466e2155682f501d57427c643a47318551857))
* Move death/respawn animation check outside oneShot guard ([b775fcc](https://github.com/AnEntrypoint/spawnpoint/commit/b775fccec3e8f9b3ebaa3c6bbf9267e6304af12e))
* Nudge player model down 0.1 to plant feet on ground ([95ee891](https://github.com/AnEntrypoint/spawnpoint/commit/95ee891eed90a6012e139f771738ddd0c1056024))
* Pass ArrayBuffer copy to GLTFLoader.parseAsync for VRM loading ([935a7c0](https://github.com/AnEntrypoint/spawnpoint/commit/935a7c09c74e1dd662150e82ecf5452343c7ee63))
* pass explicit flags to skills add so it does not hang on interactive prompts ([9711e99](https://github.com/AnEntrypoint/spawnpoint/commit/9711e99f28eae22f7c09d35900d2165ad1e57afe))
* Positive bias to align backface shadow offset ([c1e3d62](https://github.com/AnEntrypoint/spawnpoint/commit/c1e3d620f38ad667f7e33d01e1017900bfcb5c31))
* Power crate no longer uses physics body, eliminates hit lag ([109df45](https://github.com/AnEntrypoint/spawnpoint/commit/109df4579ff11bac3641486c4f5a54d0556622c0))
* Prevent double friction - preserve movement velocity through physics step ([d8f8e03](https://github.com/AnEntrypoint/spawnpoint/commit/d8f8e037fe60d5556f92ea1b72870baa83e948cf))
* Prevent duplicate entity model loading (97x → 1x env mesh) ([d70ef93](https://github.com/AnEntrypoint/spawnpoint/commit/d70ef93997287bc9ba2ec8f1caef1fd371607ac4))
* prevent npm publish workflow tag conflicts with version check ([70fa3c3](https://github.com/AnEntrypoint/spawnpoint/commit/70fa3c37c9db21aa69169db62b51edf824430785))
* prevent player duplication on reconnect and increase heartbeat timeout ([1dfd8dc](https://github.com/AnEntrypoint/spawnpoint/commit/1dfd8dcd68dadd20f6dc8a51ea27b1f379cd0585))
* Process multiple ticks per loop to prevent floaty physics ([f27af09](https://github.com/AnEntrypoint/spawnpoint/commit/f27af09a034564dac7bc44963e3d527a77c7ffad))
* raise and push forward FPS camera offset ([50c9648](https://github.com/AnEntrypoint/spawnpoint/commit/50c9648c1329b164a768b2ad7d8c7125a5adbcea))
* raise FPS camera higher and push further forward ([991dec4](https://github.com/AnEntrypoint/spawnpoint/commit/991dec48dbe1e9f0bf2cc4cf600859497b7b2916))
* raise FPS camera to eye level and shrink head bone every frame ([0d98f4e](https://github.com/AnEntrypoint/spawnpoint/commit/0d98f4e1b7649604011b60645f5154a65ed6d419))
* Reduce aim punch to 1/10 with smooth lerp decay ([0d78e98](https://github.com/AnEntrypoint/spawnpoint/commit/0d78e987035587db2be1f97f3b7a23fa494efa3d))
* Reduce jump impulse from 4.5 to 3.5 ([dc44a5b](https://github.com/AnEntrypoint/spawnpoint/commit/dc44a5b67aeab16a53cf55e79896458e6c899da0))
* Reduce jump impulse to 1.0 for testing ([a1132a9](https://github.com/AnEntrypoint/spawnpoint/commit/a1132a963438b9d5d6b27954fc1423d54a4710e3))
* Reduce model scale 10% from 1.47 to 1.323 for better hitbox fit ([3444873](https://github.com/AnEntrypoint/spawnpoint/commit/344487371e58cabce71c1c26744502b0e89f73e1))
* Reduce normal move speed from 8 to 6 for better sprint contrast ([380a720](https://github.com/AnEntrypoint/spawnpoint/commit/380a720d8666af64158d0f6b4df32d72ee65b6ca))
* Reduce normal move speed to 5.0 ([48dedd1](https://github.com/AnEntrypoint/spawnpoint/commit/48dedd199455da68bf2a186074ad3306738c72a4))
* Reduce normalBias 0.5→0.3 to close floor shadow gap ([8f41623](https://github.com/AnEntrypoint/spawnpoint/commit/8f41623ebcff751335836b5d8ccc4f416c0cf9c6))
* Reduce peter panning with less bias, widen shadows with normalBias 0.2 ([e241e7a](https://github.com/AnEntrypoint/spawnpoint/commit/e241e7aa9bc598c73e511a67f7adee78c0554b73))
* Reduce shadow bias to prevent peter panning, restore normalBias ([74a8b19](https://github.com/AnEntrypoint/spawnpoint/commit/74a8b195ebc65c4af5eca207753638a948800926))
* Reduce shadow map to 1024 ([ffe7f1d](https://github.com/AnEntrypoint/spawnpoint/commit/ffe7f1d5cd6a1ef4cd23ecf132254792a241fe4a))
* Reduce shadow map to 512 ([37e6926](https://github.com/AnEntrypoint/spawnpoint/commit/37e692697dd1c75020e063c62389f6954920f668))
* Reduce shadow radius to 1.5 and increase bias to fix bright seams ([69d1be1](https://github.com/AnEntrypoint/spawnpoint/commit/69d1be1be8e09c9dd21aca7b1ddf7eb5e831511b))
* Reduce sprint multiplier from 1.5x to 1.25x ([5b7c6b9](https://github.com/AnEntrypoint/spawnpoint/commit/5b7c6b9c98782248b16b56984274df93fc0a496c))
* Remove all shadow biases ([fb3e0d3](https://github.com/AnEntrypoint/spawnpoint/commit/fb3e0d395d1c0c7afe456555681a4889e646b54d))
* remove broken retargeting, use normalized clips directly, add favicon handler ([5b92cc1](https://github.com/AnEntrypoint/spawnpoint/commit/5b92cc12845752ed121ca82e90c7d2d6dab32969))
* remove crouch height drop from camera and player model ([bec266c](https://github.com/AnEntrypoint/spawnpoint/commit/bec266cac4585dc512f8a9972344f5031a2a2f54))
* Remove double gravity - Jolt ExtendedUpdate already applies it ([5556b69](https://github.com/AnEntrypoint/spawnpoint/commit/5556b69f7bcb9fac0a560778dbafb07e60085fe3))
* Remove double gravity causing progressive movement slowdown ([5e2971c](https://github.com/AnEntrypoint/spawnpoint/commit/5e2971c27b77da6897785c142fe629d9a15ff75e))
* remove ghost players from snapshot when they disappear due to network lag ([86983f5](https://github.com/AnEntrypoint/spawnpoint/commit/86983f59d803702c5e40093da28c24ad5ce0bcab))
* Remove hemisphere and fill lights, keep only sun ([a38c54f](https://github.com/AnEntrypoint/spawnpoint/commit/a38c54f4c9a5e232cefe9313968ac478e7a22ba9))
* Remove normalBias to eliminate bright edges at shadow boundaries ([ac25da3](https://github.com/AnEntrypoint/spawnpoint/commit/ac25da313d54ce1bdd3109c5988b7bd4a8c68850))
* Remove specular from environment - full roughness, zero metalness ([63ffdc1](https://github.com/AnEntrypoint/spawnpoint/commit/63ffdc1d7d54a442b20ec0ce75bfef6e50484ca9))
* Remove unnecessary buffer slice in VRM loading ([5aa8716](https://github.com/AnEntrypoint/spawnpoint/commit/5aa8716a5c00eddce2c0828d1448dac0afae8040))
* Remove VRM 0.x auto-rotation fix - broke model orientation ([94d88ef](https://github.com/AnEntrypoint/spawnpoint/commit/94d88ef7f4347ab878b1a061a85711fe0536ecf7))
* remove vrm.update that overwrote animated bones with T-pose ([db8ce57](https://github.com/AnEntrypoint/spawnpoint/commit/db8ce57760ec4d892f369c54ec986b7eef3130ae))
* Render shadow map from back faces to eliminate edge bright lines ([86bcb72](https://github.com/AnEntrypoint/spawnpoint/commit/86bcb7240da19b0ab3de611de869593c487742b4))
* Replace ambient with hemisphere light to reduce player model shadows ([fd6c9a8](https://github.com/AnEntrypoint/spawnpoint/commit/fd6c9a88491c4226f0b1011fecf91578ba0098ae))
* Reset death animation on respawn so other players see idle state ([cb7b8d8](https://github.com/AnEntrypoint/spawnpoint/commit/cb7b8d8ee53454a33bc1a2ed8dec2d6b83fadc0d))
* Reset death animation on respawn when health returns ([06b3477](https://github.com/AnEntrypoint/spawnpoint/commit/06b3477ab9965497218a08d1c87c653eade2bf7f))
* resolve SDK paths relative to package root for bunx compatibility ([7ae94c3](https://github.com/AnEntrypoint/spawnpoint/commit/7ae94c3d8e2121e304f42cfbea382ba7d39d3f76))
* Resolve VRM loading bug and add gzip compression ([bf19e78](https://github.com/AnEntrypoint/spawnpoint/commit/bf19e7836d04ca4bbf8e3ca7d5b4b3795fa1d6e8))
* Restore gravity, tighten shadow bias, render model-less entities ([083cea1](https://github.com/AnEntrypoint/spawnpoint/commit/083cea1bb4a7d0e7d173a7105011421ea8c51186))
* restore head bone in TPS and add forward raycast in FPS ([dd1ef34](https://github.com/AnEntrypoint/spawnpoint/commit/dd1ef34d9a834b92447dda145aa47ded47866c5e))
* Restore manual gravity - CharacterVirtual needs it ([0b60f51](https://github.com/AnEntrypoint/spawnpoint/commit/0b60f516b17a3f35f873890d8fcb062507ed9709))
* Restore shadow map to 2048, reduce blur radius to 3 ([fe88911](https://github.com/AnEntrypoint/spawnpoint/commit/fe889114d09bd31c25721df0067e9fe1d918b41a))
* Restore shadow maps with default frustum and scene target ([285f4f3](https://github.com/AnEntrypoint/spawnpoint/commit/285f4f32e0e51b88f199f76810621b06df267506))
* Reuse last input on ticks with no new input ([b6c909f](https://github.com/AnEntrypoint/spawnpoint/commit/b6c909fe330f7a776c05a529bc0823ca7938d7bc))
* Reuse muzzle flash light, shadow radius 10, normalBias 0.8, fix pendingLoads cleanup ([7567904](https://github.com/AnEntrypoint/spawnpoint/commit/7567904ee27ff9d1fcd1912a518dcc20575baead))
* Revert to BackSide shadows, zero bias - eliminates acne and halos ([6db5b46](https://github.com/AnEntrypoint/spawnpoint/commit/6db5b4651384e3b7b9f931fc9636f3c1beddfb20))
* Rotate VRM model 180 degrees to face away from camera ([f8929e7](https://github.com/AnEntrypoint/spawnpoint/commit/f8929e74db87ecf04b07a4a3508a995c5a953992))
* Scale model to capsule cylinder height (1.8m), not full capsule ([5f701e5](https://github.com/AnEntrypoint/spawnpoint/commit/5f701e56cc2da2a6824e39c1bbc5c70ed27c0d99))
* Scale player model to capsule height, align feet to ground ([c59f2cd](https://github.com/AnEntrypoint/spawnpoint/commit/c59f2cd76a07e2bcf071c5e6187bbc3ba656e475))
* Sensible shadow setup for 3060, full pixel ratio ([b743a63](https://github.com/AnEntrypoint/spawnpoint/commit/b743a63f8b1683eef1ff43c0ba117db4a8490fb9))
* Set jump impulse to 4.0 ([1e5c567](https://github.com/AnEntrypoint/spawnpoint/commit/1e5c567607874c0626978768ec8dd25d60876106))
* Set player mass to 120 ([3b90f8c](https://github.com/AnEntrypoint/spawnpoint/commit/3b90f8cf8994bfaf7a8dd9fac1db4af256fac260))
* Set sprint multiplier to 1.2x ([cd94f23](https://github.com/AnEntrypoint/spawnpoint/commit/cd94f233cc1de3d35f04288ea8cda83044a0080e))
* Shadow acne banding - bias -0.001, normalBias 0.5 ([f0afed5](https://github.com/AnEntrypoint/spawnpoint/commit/f0afed5dbad6572f3793a5836d23465d0c6fe711))
* Shadow bias -0.0001 for remaining acne ([d204e4d](https://github.com/AnEntrypoint/spawnpoint/commit/d204e4de5e51659ef3eab6e247ceece64a0d190a))
* Shadow bias -0.0003 ([071335a](https://github.com/AnEntrypoint/spawnpoint/commit/071335af2a35ae13d374b261d77abda7cb47fba0))
* Shadow bias -0.0005 ([258e930](https://github.com/AnEntrypoint/spawnpoint/commit/258e9309f4f638d0ad80bc091469e3bafd6f165e))
* Shadow bias -0.001 ([f51d9ba](https://github.com/AnEntrypoint/spawnpoint/commit/f51d9ba14bb44fe598ebd8c3ec6da885ad437817))
* Shadow bias -0.002, FrontSide shadow casting ([570ca45](https://github.com/AnEntrypoint/spawnpoint/commit/570ca45d62195d1b5a5e987a7f493f6a642224be))
* Shadow bias to 0 ([f3a6764](https://github.com/AnEntrypoint/spawnpoint/commit/f3a67648b97e3c5a11c5a8d4833611f160a53657))
* Shadow frustum far plane calculated from light-to-scene distance ([75c8eed](https://github.com/AnEntrypoint/spawnpoint/commit/75c8eed08c2d70f12d96892e0e956737d38924f5))
* Shadow map 1024, normalBias 0.3 ([f0a1a74](https://github.com/AnEntrypoint/spawnpoint/commit/f0a1a7451a574f33c2d98bb50cc5afd6688f8e27))
* Shadow map 2048, bias 0.001 to reduce peter panning ([11b458a](https://github.com/AnEntrypoint/spawnpoint/commit/11b458ad8dc8eb1d3cd2f2757ea6ae9f689009d9))
* Shadow normalBias to 0 ([a689dc8](https://github.com/AnEntrypoint/spawnpoint/commit/a689dc8b2f22b580ede024e51b0b269a9faab54f))
* Shadow radius 1 ([38a8fee](https://github.com/AnEntrypoint/spawnpoint/commit/38a8fee24576937624793eb3d78358f0960bd94d))
* Shadow radius 12 ([a84e020](https://github.com/AnEntrypoint/spawnpoint/commit/a84e020dd2288b079c7ac223dc74b2b3d57d0f76))
* Shadow radius to 6 ([cd80122](https://github.com/AnEntrypoint/spawnpoint/commit/cd80122f99eaf55de94685276fcd5cd57178cff6))
* Shadow radius to 8 ([ee39654](https://github.com/AnEntrypoint/spawnpoint/commit/ee396540325c9aa26a25cf3ed1e64469b92cbac6))
* Shadow settings - VSM bias 0.0038, normalBias 0.6, radius 4, blurSamples 8 ([835a364](https://github.com/AnEntrypoint/spawnpoint/commit/835a364344fee717467f103e8e5c6ff28502b380))
* Shadow side DoubleSide on environment meshes ([a8522e4](https://github.com/AnEntrypoint/spawnpoint/commit/a8522e4ec2105fb47f6b0355dcc5361c771b7ca1))
* Skip snapshots with 0 players, reduce EventLog, remove per-tick allocations ([bf951e0](https://github.com/AnEntrypoint/spawnpoint/commit/bf951e0fc256a961c8c901d9b5ac460aeff12dca))
* Slow sprint animation another 30% ([21935e7](https://github.com/AnEntrypoint/spawnpoint/commit/21935e72a1e54e4080f1dddef08e42d3e4dc9489))
* Slow sprint animation by 20% ([8d9cd4c](https://github.com/AnEntrypoint/spawnpoint/commit/8d9cd4c13ca34b6d80180d493059f04149162569))
* smooth FPS wall raycast and pitch-based forward offset ([fadc424](https://github.com/AnEntrypoint/spawnpoint/commit/fadc42493f22f991a7f4e8c18d7e2d82f2ba0c4d))
* Smooth frame delta to fix Firefox jitter ([9a3aeac](https://github.com/AnEntrypoint/spawnpoint/commit/9a3aeac651fa84f7e93dc6913486c4a3971e3d3a))
* Snap player position on teleport/respawn instead of interpolating ([1bcaefc](https://github.com/AnEntrypoint/spawnpoint/commit/1bcaefc58d01c0a9f7135c0e2d01594314e59216))
* Soft shadows with bias to eliminate banding on player models ([9814f3d](https://github.com/AnEntrypoint/spawnpoint/commit/9814f3df979dae9c303210e68002308290331bd5))
* Softer wider shadows with PCFSoftShadowMap and radius 3 ([95de86e](https://github.com/AnEntrypoint/spawnpoint/commit/95de86ed469905a86bcd7327f22b4bf24f4f5ad6))
* Spawn far from players, cap push velocity to prevent launch ([0530f5f](https://github.com/AnEntrypoint/spawnpoint/commit/0530f5f9b22a9b30e006549ffc3eea9b3f06fe4b))
* Spawn power crate immediately and every 30s ([d68c51a](https://github.com/AnEntrypoint/spawnpoint/commit/d68c51a2557a5f84c33e8edf1ebe7684d5ea991e))
* spread mobile controls layout and preserve VR position on session start ([f5a4a25](https://github.com/AnEntrypoint/spawnpoint/commit/f5a4a257ac1267e9a7a8e8d78bb8cad2ca1ec755))
* Sprint multiplier to 2.0x for 8.0 sprint speed ([1c7a497](https://github.com/AnEntrypoint/spawnpoint/commit/1c7a4974c827e3bfff78c2f6785046b94c2b1c07))
* Sprint speed 1.6x multiplier (8.0) and walk animation at speed 5 ([0f92c51](https://github.com/AnEntrypoint/spawnpoint/commit/0f92c5167a30f8f420fc9ba4472c7f8df6c3554b))
* Sprint speed to 7.0 (1.75x multiplier) ([4a01772](https://github.com/AnEntrypoint/spawnpoint/commit/4a01772eb30041e1c1200de9985fbf4fb3449651))
* static FPS camera position and 6-directional wall pushback ([7861828](https://github.com/AnEntrypoint/spawnpoint/commit/786182847b6d2145c4dbe25c68b558039c5a71de))
* suppress misleading ENOENT errors and add SDK default logging ([45e2ee2](https://github.com/AnEntrypoint/spawnpoint/commit/45e2ee29e915eec3e85ce194d7e5682007d5d988))
* Switch back to PCFSoftShadowMap, VSM caused cutout artifacts ([208a206](https://github.com/AnEntrypoint/spawnpoint/commit/208a206e431359b7e7a9835eee9fb6baf4d8cf7d))
* Switch to depth bias strategy for shadow edge coverage ([465d3ef](https://github.com/AnEntrypoint/spawnpoint/commit/465d3ef8fb4a32298e5538d97b9252599c751348))
* Switch to PCFSoftShadowMap to match tuned settings ([39f5f32](https://github.com/AnEntrypoint/spawnpoint/commit/39f5f32d352b84de51783aba861e051cb96f3786))
* Switch to VSM shadows to eliminate corner light leaks ([399e9a6](https://github.com/AnEntrypoint/spawnpoint/commit/399e9a681af840f6e2420a5ad6f63387464dfb0c))
* Switch to VSMShadowMap - no angle banding ([0167d96](https://github.com/AnEntrypoint/spawnpoint/commit/0167d96214fd5d10e1e5a458df0f58b317a15a59))
* Tighten shadow frustum 240→160 for denser shadow maps ([12b4184](https://github.com/AnEntrypoint/spawnpoint/commit/12b41848b3e7e3dc7a61043e9182e034df19f27a))
* Tighten shadow frustum and increase bias to fix corner light leaks ([af4dac4](https://github.com/AnEntrypoint/spawnpoint/commit/af4dac458a95ad014505fc79e8cf101e653e1b90))
* Triple jump impulse from 1.0 to 3.0 ([55191fe](https://github.com/AnEntrypoint/spawnpoint/commit/55191fea6422c397c5839096ae7bb52af771b5ba))
* use fetch-depth 0 in publish workflow for tag checkout compatibility ([52884a0](https://github.com/AnEntrypoint/spawnpoint/commit/52884a0031cf50e700731528e4d4887b737b457e))
* Use MeshToonMaterial with emissive to prevent dark mask ([0e55034](https://github.com/AnEntrypoint/spawnpoint/commit/0e55034e214dd3c39ccfcddbf25f92305c285b61))
* use payload.timestamp instead of pingTime for RTT in MessageHandler heartbeat ([0821d07](https://github.com/AnEntrypoint/spawnpoint/commit/0821d07d16b74547e693dce7b4641a6fc551eccd))
* use raw bone + vrm.update for proper FPS camera tracking ([86b6432](https://github.com/AnEntrypoint/spawnpoint/commit/86b64328de5e4ed93c9555ea5e7e6fcecdca63df))
* use real CrouchIdleLoop/CrouchFwdLoop animations instead of spine hack ([00684b0](https://github.com/AnEntrypoint/spawnpoint/commit/00684b0cb3fcc6f9b13389aab142a01d781957b0))
* Use toe bone local Y for ground placement, restore capsule offset ([4036500](https://github.com/AnEntrypoint/spawnpoint/commit/403650066149483685dd1b9bccdac98dc9ebc0c1))
* Use toe bones as ground reference, scale 1.47, feet at origin ([eb8b826](https://github.com/AnEntrypoint/spawnpoint/commit/eb8b826c28d4e12d2fef9ad98a4eef8f3381fcd2))
* Use tuned ground offset 0.212 * scale for feet placement ([c612827](https://github.com/AnEntrypoint/spawnpoint/commit/c6128277e665d528254ab6beef2762fd6f3f06e4))
* use wss:// WebSocket protocol when page is served over https ([9b95e16](https://github.com/AnEntrypoint/spawnpoint/commit/9b95e16b4acf212a7dd589d72af229c4ba14cb84))
* VSM light bleeding - radius 3, mapSize 2048, bias -0.0005 ([cdc028a](https://github.com/AnEntrypoint/spawnpoint/commit/cdc028a038c0944f8afb76ea868f18d7874b20ba))
* Walk speed to 4.0, adjust animation thresholds ([87f027b](https://github.com/AnEntrypoint/spawnpoint/commit/87f027b32df99a6efb7840c321eaa8f736b82729))
* WebXR VR Phase 1 - snap-turn and camera positioning ([a28544f](https://github.com/AnEntrypoint/spawnpoint/commit/a28544f1687843c1fa6821b03b951e21c68b8a11))
* Widen shadows with normalBias 0.4 ([7061633](https://github.com/AnEntrypoint/spawnpoint/commit/706163367d29cfbe1b5839987e3886991d85b73f))
* Widen shadows with normalBias 0.7 ([8003a4c](https://github.com/AnEntrypoint/spawnpoint/commit/8003a4c50c925fce57470c5aec7a7b875a30d46c))
* Widen shadows with normalBias 1.5 to cover object edge bright lines ([1d70360](https://github.com/AnEntrypoint/spawnpoint/commit/1d70360785465b38f2987c4232688696474ede57))
* XR controller button mappings and joystick movement ([0d306aa](https://github.com/AnEntrypoint/spawnpoint/commit/0d306aad939367885295b8c50e1277441f94377c))

### [0.1.15](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.14...v0.1.15) (2026-02-22)


### Bug Fixes

* install spoint skill for all agents at project level on scaffold ([a285875](https://github.com/AnEntrypoint/spawnpoint/commit/a2858755e6505d8a932a000a9b1569f8527d3cb1))

### [0.1.14](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.13...v0.1.14) (2026-02-22)


### Features

* add skills directory and skills-lock.json ([0979e38](https://github.com/AnEntrypoint/spawnpoint/commit/0979e38eed42149ee0a438530fb5fd822f05a750))

### [0.1.13](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.12...v0.1.13) (2026-02-22)

### [0.1.12](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.11...v0.1.12) (2026-02-22)


### Bug Fixes

* pass explicit flags to skills add so it does not hang on interactive prompts ([b145ec1](https://github.com/AnEntrypoint/spawnpoint/commit/b145ec11bfbefca6fd48bfb3309ddad168281099))

### [0.1.11](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.10...v0.1.11) (2026-02-22)


### Features

* run skills install after scaffold copies apps/ ([b163486](https://github.com/AnEntrypoint/spawnpoint/commit/b16348658017dda8fc3ef224a826b011b66a95e9))

### [0.1.10](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.9...v0.1.10) (2026-02-22)


### Bug Fixes

* use fetch-depth 0 in publish workflow for tag checkout compatibility ([d59077b](https://github.com/AnEntrypoint/spawnpoint/commit/d59077bf5c0f8b994723c390ec553e6c28054b8c))

### [0.1.9](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.8...v0.1.9) (2026-02-22)


### Features

* auto-scaffold on boot ([c94758e](https://github.com/AnEntrypoint/spawnpoint/commit/c94758edbc3e57fbccf6b44e8b9998d646d90d89))

### [0.1.8](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.7...v0.1.8) (2026-02-22)


### Features

* add scaffold command and SKILL.md for skills npm package ([bd573d3](https://github.com/AnEntrypoint/spawnpoint/commit/bd573d35e30662d227365ffd509d0cd4409f5c10))

### [0.1.7](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.6...v0.1.7) (2026-02-21)

### [0.1.6](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.5...v0.1.6) (2026-02-21)

### [0.1.5](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.4...v0.1.5) (2026-02-21)

### [0.1.4](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.3...v0.1.4) (2026-02-21)


### Features

* add comprehensive spoint-app-creator skill with CLI, documentation, and templates ([a48b5ed](https://github.com/AnEntrypoint/spawnpoint/commit/a48b5ed262d5435bb468fad41c22fe4ead9bd169))

### [0.1.3](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.2...v0.1.3) (2026-02-21)


### Bug Fixes

* suppress misleading ENOENT errors and add SDK default logging ([67461cf](https://github.com/AnEntrypoint/spawnpoint/commit/67461cf38f56e4f6e6dc6c7801208f75cb7291de))

### [0.1.2](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.1...v0.1.2) (2026-02-21)


### Features

* add /editor/ route serving three.js editor connected to live game scene ([f035858](https://github.com/AnEntrypoint/spawnpoint/commit/f0358583f6561f3b4a95e8132f2d7398240750ee))
* add comfort vignette for VR movement ([02d864c](https://github.com/AnEntrypoint/spawnpoint/commit/02d864c109daeb0d7067e10349f1f755ee279ee2))
* add comprehensive animation retargeting diagnostics ([2e17287](https://github.com/AnEntrypoint/spawnpoint/commit/2e17287fd5413518d5ad56c34a444db81fb2d91a))
* add crouch capsule resizing for physics ([1900f83](https://github.com/AnEntrypoint/spawnpoint/commit/1900f83a3451ac72ddb17278f5aece1e4f451914))
* add crouch mode (Ctrl) and network look direction ([655554f](https://github.com/AnEntrypoint/spawnpoint/commit/655554f44ffee1383b8e4004e1eb00fb7af623a8))
* add fade-to-black during teleport for comfort ([0b3369e](https://github.com/AnEntrypoint/spawnpoint/commit/0b3369ebc696147982f5d2f41839d384c23129e3))
* add ping/pong heartbeat with RTT tracking ([c589012](https://github.com/AnEntrypoint/spawnpoint/commit/c589012f240974cd4f01b20b79cf89294ad66bd6))
* add VR settings panel and configurable snap turn angle ([cb12731](https://github.com/AnEntrypoint/spawnpoint/commit/cb1273146de9bb5996fc0e3750a910cfab6a83fd))
* add WebXR hand tracking support with gesture detection ([e592641](https://github.com/AnEntrypoint/spawnpoint/commit/e5926410019e1cb3db1bcb19184cd10b7b6d78d2))
* add wrist-mounted VR UI with health and ammo display ([88e46d3](https://github.com/AnEntrypoint/spawnpoint/commit/88e46d35bbaf370fc319383570c8bf005c21ce77))
* add Y/B button reload and ammo system to TPS game ([9dd6408](https://github.com/AnEntrypoint/spawnpoint/commit/9dd64089bfc65c69a49af6c0ae6c810125716dc0))
* AR view localization and mobile performance optimization ([1558c81](https://github.com/AnEntrypoint/spawnpoint/commit/1558c81462688bd99ed52b2d50b3a979d648a116))
* attach FPS camera to head bone with forward offset ([320e86f](https://github.com/AnEntrypoint/spawnpoint/commit/320e86f58cbd3c7edcabdcfe92fd51745a8b5bb3))
* crouch on C key, smooth camera, cache models, FPS player visible, ammo flash fix, crouch anim ([d9f83fd](https://github.com/AnEntrypoint/spawnpoint/commit/d9f83fdf45b9caa1e77dc408c02aef080355b5a1))
* disable teleport by default, add toggle in VR settings panel ([9b24911](https://github.com/AnEntrypoint/spawnpoint/commit/9b24911741882c3276b41ecda2c141c9dd0436ff))
* enhance mobile controls with interactable functionality and reload animations ([b92a30b](https://github.com/AnEntrypoint/spawnpoint/commit/b92a30bb8062f5e5e8e8b980466c094c1a1fecc1))
* FPS camera on neck bone, shrink head instead of hiding model ([0312241](https://github.com/AnEntrypoint/spawnpoint/commit/03122416a6fbbaebb94c847649aff31152f5740b))
* full-featured dual joystick mobile controls ([35ef704](https://github.com/AnEntrypoint/spawnpoint/commit/35ef704974e270e593e8664e29861ab928b1fa07))
* implement edit mode with model drag-and-drop support ([5fdf796](https://github.com/AnEntrypoint/spawnpoint/commit/5fdf7967cf9d76b4c20fb3f2fc7d1d0a6f5db341))
* implement hierarchical model placement system with smart objects ([0560301](https://github.com/AnEntrypoint/spawnpoint/commit/05603016f7eeb5defc945312050bd0675a06f423))
* Kalman filter + jitter buffer for smooth netcode ([2271d28](https://github.com/AnEntrypoint/spawnpoint/commit/2271d28e54193bd25b05923c4a5c6ba93bfcc249))
* PistolShoot overrides upper body instead of additive blend ([b544ca0](https://github.com/AnEntrypoint/spawnpoint/commit/b544ca005119b9f0622de42aa6656dd7dab0c882))
* refine mobile controls initialization and pointer lock handling ([69e7e9b](https://github.com/AnEntrypoint/spawnpoint/commit/69e7e9bb70c9ac2f0478559c13e059caf85b5529))
* update mobile controls and input handling for improved responsiveness ([3eaa43c](https://github.com/AnEntrypoint/spawnpoint/commit/3eaa43c145b8f8b5024e6574b9758c9ef84cc5aa))
* WebXR VR Phase 2 - Controller visualization, haptics, teleportation ([c14c901](https://github.com/AnEntrypoint/spawnpoint/commit/c14c901ec395b4b49ddde6168a83f0f49c564a21))


### Bug Fixes

* add error handling to setCharacterCrouch ([1391d7b](https://github.com/AnEntrypoint/spawnpoint/commit/1391d7b2b2cab54ae9f6cace2eb20f428fc95273))
* attach FPS camera to head bone with proper world matrix update ([d5ec80a](https://github.com/AnEntrypoint/spawnpoint/commit/d5ec80a65c013664a085f152bb26cfb89e3f1c05))
* cap power crate spawning to prevent unbounded entity accumulation ([028ad34](https://github.com/AnEntrypoint/spawnpoint/commit/028ad349b1ad1eeae7d97b3335f3f1536b359799))
* configure git author in bump-version workflow ([a4819f1](https://github.com/AnEntrypoint/spawnpoint/commit/a4819f1699dc9ced721f7102b7b700af61e2304e))
* correct retargetClip parameter order and add findSkinnedMesh helper ([a9b5adc](https://github.com/AnEntrypoint/spawnpoint/commit/a9b5adcc78989c7f8dd3ebbb50b45b5bfcef291e))
* crouch by adjusting player height instead of shape swap ([1f28497](https://github.com/AnEntrypoint/spawnpoint/commit/1f28497c8eb3606b4e53d4f427c371045ec69450))
* eliminate ghost players on network lag and tab inactivity ([cda3a04](https://github.com/AnEntrypoint/spawnpoint/commit/cda3a04f44c7706e50434f9b48b3bfcbe9cfce25))
* filter invalid animation tracks before mixing to eliminate PropertyBinding errors ([7e6f742](https://github.com/AnEntrypoint/spawnpoint/commit/7e6f742b6fd3eb13f92351da0cf09cbe613f63e6))
* FPS raycast pulls camera back from walls instead of into them ([5b82f8b](https://github.com/AnEntrypoint/spawnpoint/commit/5b82f8be1cb3fc58ed4d223630f0aad6e5a81aad))
* ghost players on tab close - detach transport on reconnect, emit before remove ([7ffc828](https://github.com/AnEntrypoint/spawnpoint/commit/7ffc828fef12905bc5a020006a6539494cbbffa2))
* implement backward raycast for FPS wall collision and push head down ([06dea7d](https://github.com/AnEntrypoint/spawnpoint/commit/06dea7d6537f87f7c10adc6abe56af6edbfab148))
* implement responsive mobile controls layout for all device sizes ([fc77f73](https://github.com/AnEntrypoint/spawnpoint/commit/fc77f7341296182c3ad0d7b52e4d6a42d6aa0892))
* increase FPS forward offset to clear neck area ([52b17b8](https://github.com/AnEntrypoint/spawnpoint/commit/52b17b8533dccc085321133f3f66c98d583166c3))
* initialize buttons Map in MobileControls constructor ([505408c](https://github.com/AnEntrypoint/spawnpoint/commit/505408c44ac0eb337f31f14c4bd75077695918f3))
* larger FPS wall detection with multi-directional rays ([99a398c](https://github.com/AnEntrypoint/spawnpoint/commit/99a398cf9c86971d94abd72f86768ef3692339f1))
* prevent player duplication on reconnect and increase heartbeat timeout ([8ef8f7d](https://github.com/AnEntrypoint/spawnpoint/commit/8ef8f7d59585864fa3e47a28f54a2d18a15bf2b2))
* raise and push forward FPS camera offset ([3e2a353](https://github.com/AnEntrypoint/spawnpoint/commit/3e2a353d2be0f08c52bed896d6117acc803813b7))
* raise FPS camera higher and push further forward ([b47c90f](https://github.com/AnEntrypoint/spawnpoint/commit/b47c90f121fd1cbeb89912f9e39534a087e963d9))
* raise FPS camera to eye level and shrink head bone every frame ([0aeee4a](https://github.com/AnEntrypoint/spawnpoint/commit/0aeee4a99eb0c36ec86426938df506621160d9a8))
* remove broken retargeting, use normalized clips directly, add favicon handler ([3ad618b](https://github.com/AnEntrypoint/spawnpoint/commit/3ad618bf9d7b4604dddc46c268fb0f36183a4449))
* remove crouch height drop from camera and player model ([0a8a82f](https://github.com/AnEntrypoint/spawnpoint/commit/0a8a82f0b882a0210cb713a60688cdded44ba669))
* remove ghost players from snapshot when they disappear due to network lag ([8ef57b1](https://github.com/AnEntrypoint/spawnpoint/commit/8ef57b116ba2088fe6ae03c7458381c3cbe32444))
* remove vrm.update that overwrote animated bones with T-pose ([e97591d](https://github.com/AnEntrypoint/spawnpoint/commit/e97591da7ae0090af30f838e143bb9607ce8ab53))
* restore head bone in TPS and add forward raycast in FPS ([17f22cb](https://github.com/AnEntrypoint/spawnpoint/commit/17f22cbeb547bb5c909a5ecacab73842b274e548))
* smooth FPS wall raycast and pitch-based forward offset ([141a7b2](https://github.com/AnEntrypoint/spawnpoint/commit/141a7b22e0918f9737252f22c2c3af37f4fee764))
* spread mobile controls layout and preserve VR position on session start ([a6ab3e8](https://github.com/AnEntrypoint/spawnpoint/commit/a6ab3e89f4ecc9cf9f42aacf3aa858ec67b6ae4d))
* static FPS camera position and 6-directional wall pushback ([20e6af2](https://github.com/AnEntrypoint/spawnpoint/commit/20e6af2428bda3a7d0e125ca20e08457b5d9fe19))
* use raw bone + vrm.update for proper FPS camera tracking ([40ca267](https://github.com/AnEntrypoint/spawnpoint/commit/40ca267576ba498eb4a655f6fa9345553eaa7ff1))
* use real CrouchIdleLoop/CrouchFwdLoop animations instead of spine hack ([d362acf](https://github.com/AnEntrypoint/spawnpoint/commit/d362acf99ab7eb707da1c750f8e26ca758e2c88b))
* use wss:// WebSocket protocol when page is served over https ([4f4204d](https://github.com/AnEntrypoint/spawnpoint/commit/4f4204d7b7c2142bbc7e4e056214d332c4774c89))
* WebXR VR Phase 1 - snap-turn and camera positioning ([7b985a1](https://github.com/AnEntrypoint/spawnpoint/commit/7b985a17695b114e1fb060ac8b6f3e110151ffbd))
* XR controller button mappings and joystick movement ([f950cfc](https://github.com/AnEntrypoint/spawnpoint/commit/f950cfc602947d1f819a7ef711d1286bd22c51c3))
