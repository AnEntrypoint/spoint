export declare const SOURCE_DIGEST: '036f894ab41cc4793ca06eeb74e113a1c6ee19451a5ae9e6edbe9c8bfbe58efd';

export type NonNegFinite = number;


export declare class AppContext {
    _admitsRegistration(kind: any): boolean;
    _blockChartReanchor(reason: any): () => void;
    _buildEntityProxy(): {
        custom: any;
        destroy: () => any;
        position: any;
        readonly bodyType: any;
        readonly children: any[];
        readonly id: any;
        readonly model: any;
        readonly parent: any;
        readonly worldTransform: any;
        rotation: any;
        scale: any;
        velocity: any;
    };
    _busScope: any;
    _chartAware(api: any): any;
    _chartAwareApis: any[] | undefined;
    _chartAwareWeak: any[] | undefined;
    _chartAwareWeakly(api: any): any;
    _chartLocalNavmesh(navmesh: any): any;
    _configListeners: Set<any> | null | undefined;
    _debugger: CliDebugger;
    _disposed: boolean;
    _disposers: any[] | null | undefined;
    _entity: any;
    _entityProxy: {
        custom: any;
        destroy: () => any;
        position: any;
        readonly bodyType: any;
        readonly children: any[];
        readonly id: any;
        readonly model: any;
        readonly parent: any;
        readonly worldTransform: any;
        rotation: any;
        scale: any;
        velocity: any;
    };
    _fireConfigChange(): void;
    _liveChartAwareApis(): any[];
    _pendingShutdownHooks: Set<any> | null;
    _physicsAPI: {
        addBoxCollider: (s: any, shapeKey: any) => void;
        addCapsuleCollider: (r: NonNegFinite, h: NonNegFinite) => void;
        addColliderFromConfig: (cfg?: {}) => Promise<void> | undefined;
        addConvexCollider: (points: any) => void;
        addConvexFromModel: (meshIndex?: number) => void;
        addConvexFromModelAsync: (meshIndex: number | undefined, shapeKeyOverride: any) => Promise<void>;
        addForce: (f: any) => any;
        addSphereCollider: (r: NonNegFinite) => void;
        addTrimeshCollider: () => Promise<void>;
        createTrackedVehicle: (wheelDefs: any, opts: any) => any;
        createVehicle: (wheelDefs: any, opts: any) => any;
        destroyVehicle: () => any;
        getAngularVelocity: () => any[];
        getBodyId: () => any;
        getRotation: () => any[];
        getVehicleWheelState: (wheelIndex: any) => any;
        getVehicleWheelTransform: (wheelIndex: any) => any;
        getVelocity: () => any[];
        hasVehicle: () => boolean;
        setAngularDamping: (v: NonNegFinite) => void;
        setCCDPolicy: (v: any) => void;
        setDynamic: (v: any) => void;
        setFriction: (f: any) => boolean;
        setInteractable: (radius?: NonNegFinite) => void;
        setKinematic: (v: any) => void;
        setLinearDamping: (v: NonNegFinite) => void;
        setMass: (v: NonNegFinite) => void;
        setMotionType: (motionType: any) => boolean;
        setPosition: (p: any) => void;
        setRestitution: (r: any) => boolean;
        setStatic: (v: any) => void;
        setTrackedVehicleInput: (forward: any, leftRatio: any, rightRatio: any, brake: any) => any;
        setVehicleInput: (forward: any, right: any, brake: any, handbrake: any) => any;
        setVelocity: (v: any) => void;
    } | undefined;
    _registerDisposer(fn: any): void;
    _runDisposers(): void;
    _runtime: any;
    _state: any;
    _store(id: any, create: any): any;
    _stores: Map<any, any> | undefined;
    _teardownChildren(): void;
    accountState(playerId: any, key: any, initial: any): any;
    achievements(defs: any): {
        defs: Map<any, any>;
        flush(): any;
        ready: any;
        unlock(scope: any, id: any): {
            def: any;
            unlocked: boolean;
        };
        unlocked(scope: any): string[];
    };
    canSee(fromPos: any, toPos: any, opts?: {}): boolean;
    constructor(entity: any, runtime: any);
    createAnimationSystem(model: any, options: any): AnimationSystem;
    createTween(spec: any): {
        cancel(): void;
        readonly cancelled: boolean;
        readonly done: boolean;
        readonly progress: number;
        readonly value: any;
        update(dtMs: any): boolean;
    };
    defineBuffStack(spec: any): {
        apply(playerId: any, buffKey: any, delta: any): any;
        clear(playerId: any, buffKey: any): void;
        clearAll(): void;
        get(playerId: any, buffKey: any): any;
        getAll(playerId: any): {
            [k: string]: any;
        };
        set(playerId: any, buffKey: any, value: any): any;
        tick(dt: any): void;
    };
    defineBuoyancy(spec: any): {
        readonly submerged: boolean;
        readonly submersionFrac: number;
        tick(dt: any): void;
    };
    defineCameraRig(spec: any): {
        layerIds(): any[];
        onInput(playerId: any, input: any): boolean;
        pop(playerId: any, layerId: any): void;
        push(playerId: any, layerId: any): void;
        remove(playerId: any): void;
        top(playerId: any): any;
        update(playerId: any, pose: any, dt: any): {
            done: boolean;
            layer: any;
            position: any;
            target: any;
        };
    };
    defineCheckpoint(spec: any): any;
    defineCombat(spec?: {}): any;
    defineDestructible(spec: any): any;
    defineFire(spec?: {}): {
        applyRemote(payload: any): {
            adopted: {
                bytes: number;
                hash: any;
                tick: number;
            } | null;
            checksum: {
                hash: any;
                tick: any;
            } | null;
            ok: boolean;
            reason: any;
            rejected: number;
            rewound: number;
        };
        checksum(): any;
        destroy(): void;
        explode(position: any, { radiusM, igniteRadiusM, damage, source }?: {
            damage?: number | undefined;
            igniteRadiusM?: number | undefined;
            radiusM?: number | undefined;
            source?: number | undefined;
        }): any;
        extinguish(position: any, radiusMetres?: number): any;
        extinguishCell(face: any, I: any, J: any, radiusCells?: number): any;
        ignite(position: any, source?: number): any;
        igniteArea(position: any, radiusM: any, source?: number): any;
        igniteCell(face: any, I: any, J: any, source?: number): any;
        incendiaryHit({ radiusM }?: {
            radiusM?: number | undefined;
        }): (ctx: any, hit: any) => void;
        isBurning(id: any): boolean;
        isTrunkCharred(trunkId: any): boolean;
        keyframeMessage(): any;
        rayBlocked(origin: any, direction: any, distance: any): boolean;
        readonly activeCount: any;
        readonly checksumHistory: [any, any][];
        readonly gameplay: {
            blast: (position: any, radiusM: any, damage: any) => void;
            isBurning: (id: any) => boolean;
            rayBlocked: (origin: any, direction: any, distance: any) => boolean;
            readonly burningCount: number;
            smokeDepth: (origin: any, direction: any, distance: any) => number;
            tickDamage: (simTick: any, dt: any) => void;
        } | null;
        readonly keyframePending: boolean;
        readonly keyframeStats: {
            dropped: number;
            jobs: number;
            lastSliceMs: number;
            ms: number;
            served: number;
            slices: number;
            worstSliceMs: number;
        };
        readonly keyframeTick: any;
        readonly names: string[];
        readonly needsResync: boolean;
        readonly resyncStats: {
            adopted: number;
            compared: number;
            firstMismatch: null;
            mismatches: number;
            missed: number;
            requestsReceived: number;
            requestsSent: number;
            rows: number;
            unanswered: number;
        };
        readonly rollbackStats: {
            droppedRows: number;
            resimTicks: number;
            rewinds: number;
        };
        readonly simTick: any;
        readonly stats: any;
        readonly weather: {
            markEmitted(r: any, m: any, w: any): void;
            readonly emittedMoisture: number;
            readonly emittedRain: number;
            readonly emittedWind: number[];
            readonly moisture: number;
            readonly rain: number;
            readonly reading: Readonly<{
                intensity: 0;
                kind: "no-weather";
                wind: null;
            }>;
            readonly wind: number[];
            step(simTick: any, out: any): any;
        } | null;
        readonly wind: any;
        readonly world: any;
        requestResync(): {
            r: any[];
            type: string;
        };
        rewindTo(tick: any): any;
        setMoisture(value: any): any;
        setRain(value: any): any;
        setWind(vector: any): any;
        sightBlocked(from: any, to: any): boolean;
        smokeDepth(origin: any, direction: any, distance: any): number;
        stageMap(options: any): {
            acquire: (face: any, ti: any, tj: any) => any;
            blockOrigin: (slot: any) => {
                x: number;
                y: number;
            };
            data: Uint8Array<ArrayBuffer>;
            dirtySlots: Int32Array<ArrayBuffer>;
            height: number;
            readonly watchedTiles: number;
            release: (face: any, ti: any, tj: any) => boolean;
            slotCapacity: number;
            slotValueOfCell: (face: any, I: any, J: any) => number;
            slotValueOfTrunk: (trunkId: any) => number;
            stats: {
                bytesWritten: number;
                resolves: number;
                syncs: number;
                tilesWritten: number;
            };
            sync: () => number;
            texelOf: (value: any, out: any) => any;
            width: number;
        };
        stateAt(position: any): any;
        stateAtLocal(x: any, z: any): any;
        tick(dt: any): void;
    };
    defineFluid(spec: any): {
        dispose: () => void;
        onChartReanchor({ transfer }: {
            transfer: any;
        }): void;
        positions: () => Float64Array<ArrayBuffer>;
        publish: () => boolean;
        readonly particleCount: number;
        readonly ready: boolean;
        tick: (dt: any) => void;
    };
    defineFluid3D(spec: any): {
        dispose: () => void;
        positions: () => Float64Array<ArrayBuffer>;
        publish: () => boolean;
        readonly particleCount: number;
        readonly ready: boolean;
        tick: (dt: any) => void;
    };
    defineGameFSM(spec: any): {
        can(evt: any): any;
        is(s: any): any;
        matches(s: any): any;
        onTransition(fn: any): () => void;
        readonly context: any;
        readonly state: any;
        readonly timeInState: number;
        send(type: any, payload: any): {
            event: string;
            event: string;
            ok: boolean;
            ok: boolean;
            reason: string;
            reason?: undefined;
            state: any;
            state: any;
        } | {
        };
        stop(): void;
        tick(dt: any): void;
    };
    defineGameMode(spec: any): any;
    defineHealth(spec: any): {
        damage(amount: any, source?: null): any;
        heal(amount: any): any;
        kill(source?: null): void;
        readonly alive: boolean;
        readonly fraction: number;
        readonly hp: any;
        readonly max: any;
        respawn(hp: any): any;
        setMax(m: any): any;
    };
    definePath(points: any): any;
    definePickup(spec: any): {
        readonly collected: boolean;
        reset(): void;
        tick(dt: any): void;
    };
    definePlayerInventory(spec: any): {
        add(pid: any, item: any, n?: number): any;
        buy(pid: any, item: any): {
            currency: any;
            currency?: undefined;
            granted: {};
            granted?: undefined;
            ok: boolean;
            ok: boolean;
            reason: string;
            reason?: undefined;
        } | {
        };
        canAfford(pid: any, amount: any): boolean;
        clearAll(): void;
        count(pid: any, item: any): any;
        currency(pid: any): any;
        dropOnDeath(pid: any): {
            dropped: {};
            kept: {};
        };
        earn(pid: any, amount: any): any;
        has(pid: any, item: any, n?: number): boolean;
        items(pid: any): {
            [k: string]: any;
        };
        push(pid: any): void;
        remove(pid: any, item: any, n?: number): number;
        reset(pid: any): void;
        spend(pid: any, amount: any): boolean;
    };
    defineProgression(spec: any): {
        abilityTree: {
            applySnapshot: (snapshotData: any) => {
                dropped: never[];
                dropped: {
                    field: string;
                    reason: string;
                }[];
                hotkeys: number;
                hotkeys: number;
                ok: boolean;
                ok: boolean;
                players: number;
                players: number;
                reason: null;
                reason: string;
            } | {
            };
            bindHotkey: (hotkeyNumber: any, abilityId: any) => {
                ok: boolean;
                reason: any;
            };
            bindRefusal: (hotkeyNumber: any, abilityId: any) => string | null;
            buildSnapshot: () => {
                hotkeys: {};
                playerStates: {
                    cooldowns: any[];
                    playerId: any;
                }[];
            };
            canCastAbility: (playerId: any, abilityId: any, playerLevel: any) => {
                ok: boolean;
                reason: any;
            };
            castAbility: (playerId: any, abilityId: any, playerLevel: any) => {
                ok: boolean;
                reason: any;
            };
            castRefusal: (playerId: any, abilityId: any, playerLevel: any) => string | null;
            getAbility: (abilityId: any) => any;
            getAbilityCooldown: (playerId: any, abilityId: any) => number;
            getAllAbilities: () => any[];
            getAllHotkeyBindings: () => {};
            getCooldownsForNetwork: (playerId: any) => {
                abilityId: any;
                remaining: number;
            }[];
            getDefinitionRefusals: () => any[];
            getHotkeyBinding: (hotkeyNumber: any) => any;
            getHotkeyRefusals: () => any[];
            getPlayerAbilityInfo: (playerId: any, playerLevel: any) => {
                activeAbilities: any[];
                cooldowns: {
                    abilityId: any;
                    remaining: any;
                }[];
                unlockedAbilities: any[];
            };
            getPlayerAbilityState: (playerId: any) => any;
            getUnlockedAbilities: (playerLevel: any) => any[];
            removePlayer: (playerId: any) => void;
            tick: (dt: any) => void;
        };
        getNetworkState(playerId: any): {
            abilityTree: {
                cooldowns: {
                    abilityId: any;
                    remaining: number;
                }[];
                unlockedAbilities: any[];
            };
            progression: {
                level: any;
                progressRatio: number;
                totalXp: any;
                xp: any;
                xpForLevel: number;
                xpInLevel: any;
            };
        };
        onPlayerJoin(playerId: any): void;
        onPlayerLeave(playerId: any): void;
        progression: {
            addXp: (playerId: any, amount: any) => boolean;
            addXpResult: (playerId: any, amount: any) => {
                leveledUp: boolean;
                leveledUp: boolean;
                ok: boolean;
                ok: boolean;
                reason: null;
                reason: string;
            } | {
            };
            applySnapshot: (snapshotData: any) => void;
            buildSnapshot: () => {
                progressions: {
                    id: any;
                    lastLevelUpTick: any;
                    level: any;
                    levelUpEvents: any;
                    totalXp: any;
                    xp: any;
                }[];
            };
            calculateXpThreshold: (level: any, curve?: any) => number;
            drainLevelUpEvents: (playerId: any) => any;
            getAllStates: () => any[];
            getConfig: () => any;
            getPlayerState: (playerId: any) => any;
            getProgress: (playerId: any) => {
                level: any;
                progressRatio: number;
                totalXp: any;
                xp: any;
                xpForLevel: number;
                xpInLevel: any;
            };
            getState: (playerId: any) => any;
            removePlayer: (playerId: any) => void;
            tick: (dt: any) => void;
        };
        restoreGameState(state: any): any;
        setup(ctx: any): void;
        snapshotGameState(state: any): any;
        tick(ctx: any, dt: any): void;
    };
    defineQuestSystem(spec: any): {
        claimReward(pid: any, questId: any): {
            items: any;
            items?: undefined;
            ok: boolean;
            ok: boolean;
            reason: string;
            reason?: undefined;
            statBonuses: any;
            statBonuses?: undefined;
            xp: any;
            xp?: undefined;
        } | {
        };
        completeObjective(pid: any, questId: any, objectiveIndex: any, amount?: number): {
            ok: boolean;
            ok: boolean;
            reason: string;
            reason?: undefined;
        } | {
        };
        getAllQuestProgress(pid: any): {};
        getPlayerQuests(pid: any): {};
        getQuestState(pid: any, questId: any): {
            claimedAt: any;
            completedAt: any;
            progress: any[];
            questId: any;
            startedAt: any;
            state: any;
        } | null;
        push(pid: any): void;
        restore(data: any): void;
        snapshot(): {};
        startQuest(pid: any, questId: any): {
            ok: boolean;
            ok: boolean;
            reason: string;
            reason?: undefined;
        } | {
        };
    };
    defineShrinkingZone(spec: any): any;
    defineSoftbody(spec: any): {
        dispose: () => void;
        onChartReanchor({ transfer }: {
            transfer: any;
        }): void;
        positions: () => Float64Array<ArrayBuffer>;
        publish: () => boolean;
        readonly particleCount: number;
        readonly pinnedKeys: Set<any>;
        readonly ready: boolean;
        setPin: (col: any, row: any, pinned: any) => boolean;
        tick: (dt: any) => void;
    };
    defineStatsSystem(spec: any): {
        _levelFromXP(totalXP: any): number;
        _xpForLevel(level: any): number;
        addXP(pid: any, amount: any): boolean;
        addXPResult(pid: any, amount: any): {
            ok: boolean;
            ok: boolean;
            reason: null;
            reason: string;
        } | {
        };
        applyBonus(pid: any, stat: any, amount: any): boolean;
        applyBonusResult(pid: any, stat: any, amount: any): {
            ok: boolean;
            ok: boolean;
            reason: null;
            reason: string;
        } | {
        };
        equipItem(pid: any, equipmentId: any): boolean;
        equipItemResult(pid: any, equipmentId: any): {
            ok: boolean;
            ok: boolean;
            reason: null;
            reason: string;
        } | {
        };
        getBonuses(pid: any): {
            [k: string]: any;
        };
        getEquipment(pid: any): {};
        getLevel(pid: any): any;
        getLoadout(pid: any): {};
        getLoadouts(pid: any): {};
        getStats(pid: any): {
            level: any;
            xp: any;
        };
        loadLoadout(pid: any, loadoutName: any): boolean;
        loadLoadoutResult(pid: any, loadoutName: any): {
            ok: boolean;
            ok: boolean;
            reason: null;
            reason: string;
        } | {
        };
        push(pid: any): void;
        restore(data: any): {
            dropped: ({
                playerId: string;
                playerId: string;
                reason: string | null;
                reason: string;
                slot: string;
            } | {
            })[];
            dropped: never[];
            ok: boolean;
            ok: boolean;
            players: number;
            players: number;
            reason: null;
            reason: string;
        } | {
        };
        saveLoadout(pid: any, loadoutName: any): boolean;
        saveLoadoutResult(pid: any, loadoutName: any): {
            ok: boolean;
            ok: boolean;
            reason: null;
            reason: string;
        } | {
        };
        snapshot(): {};
        unequipSlot(pid: any, slot: any): any;
    };
    defineSteering(spec: any): {
        followPath(from: any, waypoints: any, dt: any, state: any, peers: any): {
            done: boolean;
            position: any[];
            state: any;
            velocity: number[];
        };
        step(from: any, target: any, dt: any, peers: any): {
            arrived: boolean;
            position: any[];
            velocity: number[];
        };
    };
    defineTeams(spec: any): {
        addScore(team: any, delta?: number): number | undefined;
        assignPlayer(playerId: any, team: any): string | null;
        broadcast(): void;
        getMembers(team: any): any[];
        getScore(team: any): number;
        getScores(): {
            color: any;
            id: any;
            label: any;
            members: any[];
            score: number;
        }[];
        getTeam(playerId: any): any;
        getTeams(): any[];
        leader(): any;
        removePlayer(playerId: any): boolean;
        reset(): void;
        setScore(team: any, n: any): number | undefined;
        smallestTeam(): any;
    };
    defineWeapon(spec: any): {
        canFire(): boolean;
        fire(shooterId: any, origin: any, dir: any, opts?: {}): {
            ammo: any;
            fired: boolean;
            fired: boolean;
            hit: boolean;
            killed: boolean;
            reason: string;
            targetPlayerId: null;
        } | {
        };
        readonly ammo: any;
        readonly magazine: any;
        readonly reloading: boolean;
        reload(shooterId: any): boolean;
        setAmmo(n: any): any;
    };
    easing(name: any, t: any): any;
    easingNames(): readonly string[];
    fallFloorY(x: any, z: any, depth: any): number;
    get bus(): any;
    get combat(): Readonly<{
        DEFAULT_COMBAT: Readonly<{
            buffRegenFractionPerSec: 0.1;
            damagePerHit: 20;
            fallKillDepth: 20;
            fallKillGraceSec: 0.5;
            headshotMultiplier: 2.5;
            headshotZone: 0.7;
            health: 100;
            hitKnockback: 4;
            magazineSize: 30;
            range: 1000;
            reloadTime: 2000;
            respawnTime: 1.5;
            shootKnockback: 2;
            spawnInvulnMs: 1500;
        }>;
        DEFAULT_HITBOX: Readonly<{
            centerHeight: 0.9;
            height: 1.8;
            radiusSq: 0.36;
        }>;
        buildLiveIndex: typeof import("../netcode/RewindSpatialIndex.js").buildLiveIndex;
        findHitLinear(players: any, shot: any): {
            dot: number;
            proj: any[];
            rewound: any;
            target: any;
            tp: any;
        } | null;
        findHitSpatial(players: any, shot: any, liveIndex?: null): null;
        hitHeightRatio(proj: any, tp: any, hitbox?: Readonly<{
            centerHeight: 0.9;
            height: 1.8;
            radiusSq: 0.36;
        }>): number;
        normalizeShotDirection(d: any): number[] | null;
        rayVsCapsule(origin: any, direction: any, range: any, tp: any, hitbox?: Readonly<{
            centerHeight: 0.9;
            dot: number;
            height: 1.8;
            proj: any[];
            radiusSq: 0.36;
        }>): {
        } | null;
        readHealth: typeof import("../behaviours/combat.js").readHealth;
        recordHit: typeof import("../netcode/OutlierDetector.js").recordHit;
        resolveFireRequest(lagComp: any, shooterId: any, shooterPosition: any, msg: any, hitbox?: Readonly<{
            centerHeight: 0.9;
            height: 1.8;
            origin: null;
            radiusSq: 0.36;
            viewTick: null;
        }>): {
        };
        resolveTargetPoint(target: any, lagComp: any, viewTick: any): {
            rewound: any;
            tp: any;
        };
    }>;
    get config(): any;
    get debug(): CliDebugger;
    get entity(): {
        custom: any;
        destroy: () => any;
        position: any;
        readonly bodyType: any;
        readonly children: any[];
        readonly id: any;
        readonly model: any;
        readonly parent: any;
        readonly worldTransform: any;
        rotation: any;
        scale: any;
        velocity: any;
    };
    get eventLog(): any;
    get files(): {
        has: (name: any) => any;
        read: (name: any) => Promise<string | null>;
        remove: (name: any) => any;
        write: (name: any, text: any) => any;
    } | null;
    get lagCompensator(): any;
    get llm(): any;
    get network(): {
        broadcast: (msg: any) => any;
        sendTo: (id: any, msg: any) => any;
    };
    get physics(): {
        addBoxCollider: (s: any, shapeKey: any) => void;
        addCapsuleCollider: (r: NonNegFinite, h: NonNegFinite) => void;
        addColliderFromConfig: (cfg?: {}) => Promise<void> | undefined;
        addConvexCollider: (points: any) => void;
        addConvexFromModel: (meshIndex?: number) => void;
        addConvexFromModelAsync: (meshIndex: number | undefined, shapeKeyOverride: any) => Promise<void>;
        addForce: (f: any) => any;
        addSphereCollider: (r: NonNegFinite) => void;
        addTrimeshCollider: () => Promise<void>;
        createTrackedVehicle: (wheelDefs: any, opts: any) => any;
        createVehicle: (wheelDefs: any, opts: any) => any;
        destroyVehicle: () => any;
        getAngularVelocity: () => any[];
        getBodyId: () => any;
        getRotation: () => any[];
        getVehicleWheelState: (wheelIndex: any) => any;
        getVehicleWheelTransform: (wheelIndex: any) => any;
        getVelocity: () => any[];
        hasVehicle: () => boolean;
        setAngularDamping: (v: NonNegFinite) => void;
        setCCDPolicy: (v: any) => void;
        setDynamic: (v: any) => void;
        setFriction: (f: any) => boolean;
        setInteractable: (radius?: NonNegFinite) => void;
        setKinematic: (v: any) => void;
        setLinearDamping: (v: NonNegFinite) => void;
        setMass: (v: NonNegFinite) => void;
        setMotionType: (motionType: any) => boolean;
        setPosition: (p: any) => void;
        setRestitution: (r: any) => boolean;
        setStatic: (v: any) => void;
        setTrackedVehicleInput: (forward: any, leftRatio: any, rightRatio: any, brake: any) => any;
        setVehicleInput: (forward: any, right: any, brake: any, handbrake: any) => any;
        setVelocity: (v: any) => void;
    };
    get players(): {
        attachEntity: (pid: any, entityId: any, offset: any, bone: any) => any;
        attachmentOf: (entityId: any) => any;
        broadcast: (msg: any) => any;
        broadcastNearby: (pos: any, radius: any, msg: any) => void;
        defineSeats: (entityId: any, seats: any) => any;
        detachEntity: (entityId: any) => any;
        dismount: (pid: any) => any;
        getAll: () => any;
        getById: (id: any) => any;
        getNearest: (pos: any, r: any) => any;
        handoffSeat: (fromPid: any, toPid: any) => any;
        mountInSeat: (pid: any, entityId: any, seatId: any) => any;
        nearestOtherPlayer: (playerId: any, radius: any) => any;
        onPlayerContact: (radius: any, cb: any) => () => void;
        playAnimation: (pid: any, clip: any, opts: any) => any;
        seatOf: (pid: any) => any;
        seatsOf: (entityId: any) => any;
        send: (pid: any, msg: any) => any;
        setAppearance: (pid: any, appearance: any) => any;
        setLifecycle: (pid: any, state: any, opts: any) => any;
        setModel: (pid: any, url: any) => any;
        setMovementOverride: (pid: any, overrides: any) => any;
        setName: (pid: any, name: any) => any;
        setPosition: (pid: any, pos: any) => any;
        setWeapon: (pid: any, name: any) => any;
        undefineSeats: (entityId: any) => any;
    };
    get seaLevel(): number | null;
    get spawnGeometry(): {
        DEFAULT_HITBOX: Readonly<{
            centerHeight: 0.9;
            height: 1.8;
            radiusSq: 0.36;
        }>;
        capsuleHeightM: typeof capsuleHeightM;
        capsuleRadiusM: typeof capsuleRadiusM;
        footprintBlockers: (sp: any, feetY: any, hitbox: any) => ({
            intrusionM: null;
            intrusionM: number;
            kind: string;
            kind: string;
            offsetM: number;
            offsetM: number;
            surfaceY: any;
            surfaceY: null;
            x: any;
            x: any;
            z: any;
            z: any;
        } | {
        })[];
        spawnSurfaceY: (sp: any, opts: any) => any;
    };
    get state(): any;
    get storage(): {
        delete: (key: any) => any;
        get: (key: any) => any;
        has: (key: any) => any;
        list: (prefix?: string) => any;
        set: (key: any, value: any) => any;
    } | null;
    get terrain(): {
        startStreaming: (tcfg: any) => Promise<{
            cover: (points: any) => Promise<any>;
            coversPosition: (x: any, z: any) => boolean;
            installPrepared: (prepared: any) => {
                installed: number;
                removed: number;
            };
            placeAllFields: () => void;
            prepareFields: ({ players, heightFn: preparedHeightFn, isAborted }: {
                fields: {
                    N: number;
                    center: number[];
                    cornerX: number;
                    cornerZ: number;
                    sampleMs: number;
                    samples: Float32Array<ArrayBuffer>;
                }[];
                heightFn: any;
                isAborted?: (() => boolean) | undefined;
                players: any;
                primaryIndex: number;
            }) => Promise<{
            } | null>;
            preparedSurfaceY: (set: any, x: any, z: any) => any;
            readonly bodyId: any;
            readonly busy: boolean;
            readonly center: any[] | null;
            readonly coverRadius: number;
            readonly fields: {
                bodyId: any;
                center: any;
            }[];
            readonly groundlessPlayers: any[];
            readonly lastError: any;
            readonly lastRefusal: any;
            readonly lattice: any;
            readonly liveHeightFn: any;
            readonly maxFields: any;
            readonly rebuildCount: number;
            readonly refusalCount: number;
            readonly staleEpochDiscards: number;
            resculpt: () => Promise<any>;
            setLattice: (next: any) => void;
            start: (fallbackCenter?: number[]) => Promise<void>;
            stop: () => void;
        } | null>;
    };
    get terrainBodyId(): any;
    get time(): {
        after: (seconds: any, fn: any) => void;
        every: (seconds: any, fn: any) => void;
        readonly deltaTime: any;
        readonly elapsed: any;
        readonly serverTime: number;
        readonly tick: any;
    };
    get world(): {
        applyImpulse: (entityId: any, impulse: any, worldPoint: any) => any;
        attach: (eid: any, app: any) => any;
        destroy: (id: any) => void;
        detach: (eid: any) => any;
        getEntity: (id: any) => any;
        isAtRest: (entityId: any, eps: any) => any;
        joint: (entityA: any, entityB: any, opts: any) => any;
        nearby: (pos: any, radius: any) => any;
        query: (filter: any) => any;
        readonly gravity: any;
        removeConstraint: (constraintId: any) => any;
        reparent: (eid: any, parentId: any) => any;
        sendToEntity: (entityId: any, msg: any) => any;
        setBodyActive: (entityId: any, active: any) => any;
        setGravityFactor: (entityId: any, factor: any) => any;
        setMotionType: (entityId: any, motionType: any) => any;
        setPosition: (entityId: any, position: any, rotation: any) => any;
        setVelocity: (entityId: any, velocity: any) => any;
        spawn: (id: any, cfg: any) => any;
        spawnChild: (id: any, cfg: any) => any;
        weld: (entityA: any, entityB: any, opts: any) => any;
    };
    interactable(config?: {}): void;
    leaderboard(key: any, opts: any): any;
    navCostAt(x: any, z: any): 0.5 | 1 | 2 | 3 | 8;
    navmesh(worldName?: any): any;
    onConfigChange(cb: any): () => void;
    onPlayerProximity(radius: any, callback: any): () => void;
    onShutdown(cb: any): () => void;
    persisted(key: any, initial: any, opts: any): any;
    pickSpawnPoint(spawnPoints: any, opts: any): any[];
    ragdoll(spec: any): Readonly<{
        active: boolean;
        explicit: readonly string[];
        strengths: Readonly<{
            [k: string]: number;
        }>;
    }>;
    raycast(origin: any, direction: any, maxDistance?: number, excludeBodyId?: null, cellSize?: number): any;
    seaLevelAt(x: any, z: any): number | null;
    senderOf(message: any): any;
    set state(v: any);
    terrainHeightAt(x: any, z: any): any;
    terrainKindAt(x: any, z: any): any;
    vibe(spec: any, sampleNames: any): Readonly<{
        bpm: number;
        length: number;
        steps: readonly Readonly<{
            beat: any;
            sample: any;
        }>[];
        swing: number;
    }>;
}
import { AnimationSystem } from '../animation/AnimationSystem.js';
import { CliDebugger } from '../debug/CliDebugger.js';
import { capsuleRadiusM, capsuleHeightM } from './AppGameplay.js';