LAMPORT-n-r129-4 | witness exec_js (gm-graph LAMPORT node, c:/dev/gm/skills/dream-rsi/gm-graph.json) exit=0 | RESULT: PASS nodes=111 principles=86 edges=209 forward=102 back=107 undefined=0 lamport_phase=P2 fwdToP4=1 fwdFromP2=1 backFromP4=1 backToP2=1 parse=ok | gm-hop receipt (session orch-main-r135-hop) VERDICT: HOLDS witness 1791668980754-500-570ebf31ac918f4f | 2026-10-10 | dispatch 1791668929368-500-cb10f30852d409de
RESULT rice-wtserver-catches-115 resolved 234f40b396c51203db1d7f344b812d87de977dac next=wtserver-start-reject-caller-unawaited
RESULT popper-n-r116-3 blocked blocker=popper-n-r116-3-blocker-orch-main-r132 holder=orch-main-r136/popper-n-r116-4 client/core/WorkerRenderer.js tree-clean
tick 88 live=18 ceiling=20 floor=10 shortfall=0 open_rows=938 done=a4dcec35cfe44ddb9 done=a18e8f8027e9aac5f launch orch-main-r140 hop=apps/tps-game launch orch-main-r141 hop=client/hud 1791669314
RESULT LAMPORT-n-r129-4 blocked blocker=LAMPORT-n-r129-4-blocker-orch-main-r135 holder=c:/dev/gm git_push gate_denied remote_moved pull-conflicts AGENTS.md+gm-mcp+rs-plugkit commit 6e6fe49a5b local-only 2nd gm lane blocked on gm git (r131 then r135)
FACT gm-git-contention two lanes blocked on the same c:/dev/gm git state inside one walk
tick 89 live=19 ceiling=20 floor=10 shortfall=0 open_rows=937 done=a3a8ebe1dafa27dfb launch orch-main-r142 hop=client/editor 1791669459
wit 1791668981495-500-5b28a71815c3d7b7 row=gm-friction-git-pull-blocked-by-dirty-submodules git_push A/B same-body request_fingerprint=6eb2fdf62f4f5185 cwd=c:/dev/gm new=has dirty_submodule_only+dirty_submodule_pointers+dirty_tracked_files+live_lane_markers next_dispatch=git_status one_line_hint=true old=blanket 'worktree or index is not clean' porcelain-blob next_dispatch=instruction fix=9dfa646ba7ce8b01172d2d4b569086be401bb4dc file=rs-plugkit/crates/plugkit-core/src/wasm_dispatch/verbs/git.rs utc=2026-10-10T22:00:49Z
RESULT gm-witness-log-clobber resolved 950fe5004c2b8a4d2d158f7adfd7312c4a39a7f6 next=gm-witness-log-clobber-live-refusal
FACT gm-commit-c283124-in-main-ancestry beneath 6e6fe49+37e6cee so next lane push carries it
tick 90 live=19 ceiling=20 floor=10 shortfall=0 open_rows=936 done=ad49e0a87ec17f0c2 launch orch-main-r143 hop=client/ui 1791669743
RESULT gm-codeinsight-src-static-unindexed resolved f31b02d5915c98214d1eacd93932b74a5d137c68 gm-main-50c55e42-pins-rs-plugkit-29c978ff rs-plugkit-efc2e2e2-comment-sweep 49dc2b31-AGENTS.md-41754to29840
RESULT popper-n-r116-4 resolved 00813d6ceba2b0210ca779362a76e8d5591f3e67 next=POPPER-r106-1
HOP src/transport CQS 8 violations witness=1791669481944-500-ab08160e7fdfaca9 next=PARNAS src/transport
tick 91 live=10 ceiling=20 floor=10 shortfall=0 refill_needed=10 open_rows=943 launch orch-main-r144..r153 rows=CQS-n-r139-1..8,DBC-n-r134-6,DBC-n-r134-7 1791669897
RESULT gm-friction-git-pull-blocked-by-dirty-submodules resolved 9dfa646ba7ce8b01172d2d4b569086be401bb4dc
tick 92 live=19 ceiling=20 floor=10 shortfall=0 open_rows=943 done=a195ee681e98a7e8b launch orch-main-r154 hop=client/xr 1791670045
2026-10-10T22:09:15.319Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=1 RESULT: FAIL (16 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-10T22-09-15-319Z-29360.txt sha256=3f7172e9824dc1041db8172c8fe297d1abc87346d6d303d3d6b4ad9a6d0df950
HOP apps/tps-game TOTALITY 4 violations witness=1791669629687-500-f5bf515df9a802a6 next=PARSEDV src/netcode
RESULT gm-friction-prd-yml-foreign-rows-blocks-path-scoped-finalize resolved 1c4435267a83f8e1873da476d8018f176d5e5e49 rs-plugkit-9dfa646-live-0.1.1571 own-rows-prd_own_rows_only:true
FACT pool-heartbeat-hop-has-no-row-key pool-observe reports malformed_heartbeats for orch-main-r143.live and orch-main-r154.live missing=row
tick 93 live=18 ceiling=20 floor=10 shortfall=0 open_rows=941 done=a76873fc640b686f4 done=a4123c4288539609a launch orch-main-r155 row=DBC-n-r134-5 launch orch-main-r156 row=gm-witness-log-clobber-live-refusal 1791670197
2026-10-10T22:11:30.698Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
2026-10-10T22:12:00.000Z | CQS-n-r139-2-undelivered | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 7/7 | dispatch 1791670289677-500-c4afeac501776920 | out - | sha256 -
tick 94 live=20 ceiling=20 floor=10 shortfall=0 open_rows=945 launchable=158 route=blocked 1791670407
FACT pool-heartbeat-r149-missing-start pool-observe reports malformed_heartbeats for orch-main-r149.live missing=start (third hop heartbeat defect after r143/r154 missing=row)
tick 94b live=20 ceiling=20 floor=10 shortfall=0 done=aab30b96545ce0b0f (blocked: gm-w577-clause1 holder=agentplug/crates/agentplug-runner/src/daemon) launch orch-main-r157 row=DRY-n-r141-4 1791670442

CQS-n-r139-5 | witness=exec_js(src/transport/WebTransportTransport.js + WebTransportClientTransport.js live sendUnreliable path) | exit=0 | RESULT: PASS pre-fix sendUnreliable answered true for BOTH the datagram command (dg=1 rel=0) and the reliable fallback (dg=0 rel=1) on both modules; post-fix it answers "datagram" (dg=1 rel=0), "reliable" (dg=0 rel=1), false when closed or when the reliable fallback itself fails, truthiness preserved for existing callers | ts=2026-10-10T22:14:26.811Z | dispatch=1791670319533-500-bb6c9a06e2854b2c | session=orch-main-r147-w1
CQS-n-r139-8 | witness=1791670363701-500-a5e4efa70c2db96 | exit=0 | RESULT: PASS | 2026-10-10T22:14:31.307Z | checks=20 failed=0 | script=scripts/transform-ring-witness.mjs | module=src/transport/TransformRing.js | session=orch-main-r144
2026-10-10T22:15:26.386Z | NetworkSimTransport-witness | exit 1 | RESULT: FAIL | module src/transport/NetworkSimTransport.js | claims 32/35 | out - | sha256 -
2026-10-10T22:15:51.481Z | NetworkSimTransport-witness | exit 1 | RESULT: FAIL | module src/transport/NetworkSimTransport.js | claims 32/35 | out - | sha256 -
RESULT gm-spool-error-receipt-no-dispatch-id resolved bc93cfa776602fed5a8909c416600d7c47e1793b next=gm-runner-pinned-local-build-never-adopts-release
HOP client/hud DRY 4 violations witness=1791670053297-500-77923077da562a21 next=KOLMOGOROV client/core
tick 95 live=20 ceiling=20 floor=10 shortfall=0 done=a0397b51 done=af860712 launch orch-main-r158 hop=KOLMOGOROV apps/tps-game launch orch-main-r159 row=DRY-n-r141-3 1791670555
CQS-n-r139-3 | exec_js | exit=0 | RESULT: PASS | 2026-10-10T22:16:43.041Z | dispatch=1791670557179-500-6509cbd8cd358cac | session=orch-main-r149-w | surface=src/transport/WebSocket{Transport,ClientTransport}.js
HOP client/ui ILLEGAL 8 violations witness=1791670113327 next=PARSEDV client/ui
tick 96 live=20 ceiling=20 floor=10 shortfall=0 done=a7354438 launch orch-main-r160 hop=PARSEDV client/ui 1791670655
2026-10-10T22:17:45.228Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
2026-10-10T22:17:46.970Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=1 RESULT: FAIL (16 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-10T22-17-46-970Z-9332.txt sha256=f5d274b65a12a4e54c420933a5187d8e7c516fa0e8ac8e522956d2c90c006c5f
20261010T221802Z | scripts/WebSocketClientTransport-witness.mjs | exit=0 | RESULT: PASS -- 25 of 25 claims | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=global WebSocket (runtime-provided) | output=.gm/witness-out/WebSocketClientTransport-witness-20261010T221802Z-23832-4e0df6.txt | sha256=e50f345462a2b5035dc792c434b37178ceab5fba08738b070e2a57727e2454ce
RESULT CQS-n-r139-8 resolved f5f1b12687118bf344ced966bc73371f0185d16b next=rice-dead-transformring-writer-capacity-115
tick 97 live=20 ceiling=20 floor=10 shortfall=0 open_rows=944 launchable=160 done=afad881c launch orch-main-r161 row=ILLEGAL-n-r143-8 1791670723
CQS-n-r139-6 witness=scripts/WireweaveTransport-witness.mjs exit=0 RESULT=PASS checks=51 failed=0 utc=2026-10-10T22:19:07.951Z dispatch=1791670612659-500-b31752abd87e8266 session=orch-main-r146-w1 acceptance_dispatch=1791670630028-500-48d103534118558e sha=2fe6ce711308084e941ac4740177f1371cd3cc0d
2026-10-10T22:19:12.481Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
RESULT gm-config-refresh-degraded-silent-nested-copy-cause resolved c0ee16ee40 push-blocked remote-moved next=gm-config-vendored-prose-shadows-config-cache
FACT gm-git-pull-refused-dirty-tracked-files git_pull in c:/dev/gm refuses while dirty: .gm/prd.yml skills/gm-orchestrate/SKILL.md skills/gm-prd/SKILL.md so an already-committed fix cannot be pushed
tick 98 live=20 ceiling=20 floor=10 shortfall=0 open_rows=950 done=aaf4e517 launch orch-main-r162 row=gm-git-pull-refused-dirty-tracked-files-blocks-push 1791670936
CQS-n-r139-7 | witness 1791670725757-500-b796d6a8934edeef | exit 0 | RESULT: PASS | 2026-10-10T22:22:59.014Z | dispatch 1791670725757-500-b796d6a8934edeef | sha 2da819261edc776ae6469d61fb72ff7b4e86d099 | session orch-main-r145-w1 | module src/transport/NetworkSimTransport.js
2026-10-10T22:23:02.329Z witness=exec_js/DBC-n-r134-6-channel-attribution module=src/transport/WebTransportTransport.js exit=0 RESULT: PASS (6 of 6 claims hold) dispatch=1791670905525-500-f0aab686b0564754 witness-session=orch-main-r153-sub1
HOP client/xr ILLEGAL 6 violations witness=1791670444869-500-6268792f901e7358 next=HUGHES client/xr
HOP client/editor ILLEGAL 9 violations witness=1791670566790-500-2bbc5014582c7fed next=PARSEDV client/editor
tick 99 live=20 ceiling=20 floor=10 shortfall=0 done=a2f13c53 done=a6e4164c launch orch-main-r163 hop=HUGHES client/xr launch orch-main-r164 hop=PARSEDV client/editor 1791671056
FACT pool-ceiling-refusal-20 verbatim: "Concurrent subagent limit reached. You can run 20 subagents at once" -- orch-main-r164 (hop PARSEDV client/editor) refused at live=20; queued as the next refill
tick 99b live=20 ceiling=20 floor=10 shortfall=0 r164-refused-queue=hop-PARSEDV-client/editor 1791671068
2026-10-10T22:24:35.866Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
CQS-n-r139-4 | witness=scripts/NetworkSimTransport-witness.mjs | exit=0 | RESULT: PASS (claims passed 35/35) | 2026-10-10T22:25:45.145Z | dispatch=1791671076218-500-5c54d13cd17656b9 | session=orch-main-r148-sub1 | head=32aa2845
20261010T222604Z | scripts/WebSocketClientTransport-witness.mjs | exit=0 | RESULT: PASS -- 25 of 25 claims | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=global WebSocket (runtime-provided) | output=.gm/witness-out/WebSocketClientTransport-witness-20261010T222604Z-26172-5ac8e0.txt | sha256=76344009073a77a4188433bcc0da2ce75d83bc674adaa8338886c09e6e9450af
2026-10-10T22:27:51.603Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
- ILLEGAL-n-r143-8 dev-dashboard memory-preset + state.resizing: exec_js exit=0 RESULT: {"ids":["panel-debug","panel-memory","panel-network","panel-performance"],"memory_equals_fps":false,"peakAt128":128,"peakAfter200":200,"memHtmlHasHeap":true,"memHtmlHasPeak":true,"memHtmlHasTextures":true} 2026-10-10T22:28:05Z dispatch 1791671163210-500-84c75377e2999e4c
RESULT CQS-n-r139-2 resolved 2da819261edc776ae6469d61fb72ff7b4e86d099 next=rice-netsim-pending-counter-115
RESULT CQS-n-r139-5 resolved f7ebb966bb3484ffd51b0088df6abc99f35606db next=DBC-n-r134-2
tick 100 live=20 ceiling=20 floor=10 shortfall=0 done=a8ad36a7 done=ae678b81 launch orch-main-r164 hop=PARSEDV client/editor (dequeued) launch orch-main-r165 row=DBC-n-r134-2 1791671304
2026-10-10T22:29:44.388Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
2026-10-10T22:29:57.335Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
2026-10-10T22:30:52.021Z | CQS-n-r139-1-TransportWrapper-witness | exit 0 | RESULT: {"sha":"378d7f4011c717ccb49243d3efed3c84ba2c11b4","exports":["SEND_ACCEPTED","SEND_REJECTED","SendContractError","TransportWrapper"],"acceptedStrict":true,"rejectedStrict":true,"threw":"SendContractError","answers":[true,false],"sendUnreliable":[true,false,true],"pm145":{"accepted":"delivered","rejected":"transport-refused"}} | session orch-main-r151-sub1 | dispatch 1791671274918-500-a3c6827a8c061ed4 | row CQS-n-r139-1 | sha 32aa284577dd0a327c6b03d7b855c73e684766f2
RESULT DBC-n-r134-6 resolved 378d7f4011c717ccb49243d3efed3c84ba2c11b4 next=CQS-n-r139-5-witness-C3-stale-orch-main-r147
RESULT CQS-n-r139-4 resolved c6ccb8b02db54d98aa5fc36136ae9f7b8b7c4275 next=rice-netsim-pending-counter-115
RESULT CQS-n-r139-7 resolved 2da819261edc776ae6469d61fb72ff7b4e86d099 next=CQS-n-r139-7-blocker-orch-main-r145
RESULT gm-witness-log-clobber-live-refusal resolved 541ddbadcb next=XY-SPOOL-FILENAME-WRITER
HOP client/xr HUGHES 5 violations witness=1791671228145-500-84e5d3e630cc58c2 next=BOHM-JACOPINI client/xr
HOP client/ui PARSEDV 7 violations witness=1791671134903-500-18509bd34116aa77 next=ILLEGAL client/ui
FACT pool-observe-starved-serial-lane verb pool-observe task orch-main-20380-1791671156482-7501 waited 120014ms error_code=dispatch_starved_waiting_for_serial_lane lane=state holder=orch-main-r145 lane_waiters=2 executed=false re_dispatch_safe=true
tick 101 live=20 ceiling=20 floor=10 shortfall=0 done=6 launch orch-main-r166 hop=BOHM-JACOPINI client/xr launch orch-main-r167 hop=ILLEGAL client/ui launch orch-main-r168 row=rice-netsim-pending-counter-115 launch orch-main-r169 row=XY-SPOOL-FILENAME-WRITER(gm) launch orch-main-r170 row=ILLEGAL-n-r142-3 launch orch-main-r171 row=LAMPORT-n-r129-3 1791671466
HOP apps/tps-game KOLMOGOROV 5 violations witness=1791670816567-500-f0ba9e9f4a598df4 next=PARNAS apps/tps-game
tick 102 live=20 ceiling=20 floor=10 shortfall=0 done=a4ecc8db launch orch-main-r172 hop=PARNAS apps/tps-game 1791671482
RESULT CQS-n-r139-1 resolved 32aa284577dd0a327c6b03d7b855c73e684766f2 next=DBC-n-r152-1
tick 103 live=20 ceiling=20 floor=10 shortfall=0 done=a58f61ee launch orch-main-r173 row=DBC-n-r152-1 1791671581
DBC-n-r134-7 | witness 1791671397641-500-4ec119d7dc74d2ba | exit 0 | RESULT: PASS 35/35 | 2026-10-10T22:33:43Z | dispatch 1791671397641-500-4ec119d7dc74d2ba | sha f3f0744e0dfa1a48aed2d659021e6d54fe2aaf75 | session orch-main-r152-wit | module src/transport/NetworkSimTransport.js | exec_js 1791671497942-500-b45fccdf7905ae2a
RESULT CQS-n-r139-6 resolved 2fe6ce711308084e941ac4740177f1371cd3cc0d next=HALTING-n-r101-1
tick 104 live=20 ceiling=20 floor=10 shortfall=0 open_rows=969 launchable=182 done=a55b60e4 launch orch-main-r174 row=HALTING-n-r101-1 1791671694
2026-10-10T22:34:56.624Z witness=scripts/ServerAPI-witness.mjs module=C:/dev/spoint/src/sdk/ServerAPI.js exit=0 RESULT: PASS (58 of 58 expectations hold) out=.gm/witness-out/ServerAPI-witness-2026-10-10T22-34-56-624Z-24524.txt sha256=cb9450c7004a9f43b63ee5286dd04b9bc7a94c79f6279678288e6ded534cb11e
RESULT DBC-n-r134-5 resolved e4d24a8e403c74f63933875728df5582360c4b74 next=DBC-n-r134-3
RESULT ILLEGAL-n-r143-8 resolved 6ea2dd34e6a8750563932cda447d14cc88ff793c next=player-manager-send-failure-witness-red-since-095eb522
tick 105 live=20 ceiling=20 floor=10 shortfall=0 done=2 launch orch-main-r175 row=DBC-n-r134-3 launch orch-main-r176 row=player-manager-send-failure-witness-red-since-095eb522 1791671808
HOP client/editor PARSEDV 5 violations witness=1791671689882-500-9ec3e7984f4ef898 next=ILLEGAL client/editor
tick 106 live=20 ceiling=20 floor=10 shortfall=0 done=a9b5f43e launch orch-main-r177 hop=ILLEGAL client/editor 1791671827
DRY-n-r141-3 | render-debug-panel-witness.mjs + pause-menu-witness.mjs + 10-module live ensureStyle run | exit 0 | RESULT: PASS -- 51 check(s) over 12 toggle write(s) on client/hud/RenderDebugPanel.js, 7/7 scratch mutant(s) caught; 32 of 32 check(s) passed; 10 of 10 modules inject once, idempotent, re-inject after removal | 2026-10-10T22:38:12.975Z | dispatch 1791671690779-500-4a4877e496118472
RESULT DBC-n-r134-7 resolved f3f0744e0dfa1a48aed2d659021e6d54fe2aaf75 next=DBC-n-r134-4
tick 107 live=20 ceiling=20 floor=10 shortfall=0 done=acc8be3e launch orch-main-r178 row=DBC-n-r134-4 1791671923
20261010T223914Z | scripts/WebSocketClientTransport-witness.mjs | exit=0 | RESULT: PASS -- 25 of 25 claims | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=global WebSocket (runtime-provided) | output=.gm/witness-out/WebSocketClientTransport-witness-20261010T223914Z-30568-5f489f.txt | sha256=72c3b3cb8d130fe62efc27db5c3aae2e3374be08587b650799f46ece938fa15f
2026-10-10T22:39:56.603Z witness=scripts/WorkerTransport-witness.mjs module=C:/dev/spoint/src/transport/WorkerTransport.js exit=1 RESULT: FAIL (57 of 59 expectations hold) out=.gm/witness-out/WorkerTransport-witness-2026-10-10T22-39-56-603Z-27204.txt sha256=1edb427eb757f0c35e35cc9e9ad65685f3579b80c88384fb70081e37d8db9c30
HOP client/ui ILLEGAL 8 violations witness=1791671820357-500-666c6d345b06d025 next=HUGHES client/ui
RESULT gm-git-pull-refused-dirty-tracked-files-blocks-push resolved 622fd1974cf044320a7c0738489657ab360515a1 next=gm-git-pull-refused-dirty-tree-blocks-served-recovery
tick 108 live=20 ceiling=20 floor=10 shortfall=0 done=2 launch orch-main-r179 hop=HUGHES client/ui launch orch-main-r180 row=gm-git-pull-refused-dirty-tree-blocks-served-recovery(gm) 1791672021
2026-10-10T22:40:29.601Z | NetworkSimTransport-witness | exit 1 | RESULT: FAIL | module src/transport/NetworkSimTransport.js | claims 34/35 | out - | sha256 -
- rice-netsim-pending-counter-115 | NetworkSimTransport in-flight pending counter | exit 0 | RESULT: PASS pending 0->2->0 stats 0->2->0 queue 2->0 delivered=2 lastScheduledAt=absent | 2026-10-10T22:40:36Z | dispatch 1791671977041-500-11af45b8bf86c744 (session rice-netsim-counter-w1)
2026-10-10T22:40:52.907Z | NetworkSimTransport-witness | exit 1 | RESULT: FAIL | module src/transport/NetworkSimTransport.js | claims 34/35 | out - | sha256 -
- ILLEGAL-n-r142-3 | exec_js 1791672089676-500-67f4ed06de0d25a9 | exit 0 | RESULT: PASS | 2026-10-10T22:42:26Z | session orch-main-r170-sub1
2026-10-10T22:36:24Z | DBC-n-r134-2 | WorkerTransport boundary (exec_js) | exit 0 | RESULT: PASS 29/29 | module src/transport/WorkerTransport.js | 2026-10-10T22:36:24Z | dispatch 1791671802630-500-64156283d0a5783e (session orch-main-r165)
2026-10-10T22:38:11Z | DBC-n-r134-2 | PlayerManager._deliver integration (exec_js) | exit 0 | RESULT: PASS 6/6 | module src/transport/WorkerTransport.js + src/netcode/PlayerManager.js | 2026-10-10T22:38:11Z | dispatch 1791671909748-500-ba65a994e071912c (session orch-main-r165)
2026-10-10T22:42:05.110Z | NetworkSimTransport-witness | exit 1 | RESULT: FAIL | module src/transport/NetworkSimTransport.js | claims 21/35 | out - | sha256 -
2026-10-10T22:42:09.382Z witness=scripts/WorkerTransport-witness.mjs module=C:/dev/spoint/src/transport/WorkerTransport.js exit=1 RESULT: FAIL (57 of 59 expectations hold) out=.gm/witness-out/WorkerTransport-witness-2026-10-10T22-42-09-382Z-30704.txt sha256=4661ef9c1fcc144945d8f0c207620c6d68b582825cf66ede2df579c681c5a9fa
2026-10-10T22:42:09.646Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=1 RESULT: FAIL (16 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-10T22-42-09-646Z-28860.txt sha256=f5d274b65a12a4e54c420933a5187d8e7c516fa0e8ac8e522956d2c90c006c5f
2026-10-10T22:42:49.236Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=1 RESULT: FAIL (16 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-10T22-42-49-236Z-30140.txt sha256=f5d274b65a12a4e54c420933a5187d8e7c516fa0e8ac8e522956d2c90c006c5f
RESULT DBC-n-r134-3 blocked next=DBC-n-r134-1 (not in slots.candidates; candidate taken instead)
HOP apps/tps-game PARNAS 7 violations witness=1791671873889-500-2aef7099518a1141 next=HOARE apps/tps-game
tick 109 live=20 ceiling=20 floor=10 shortfall=0 done=2 launch orch-main-r181 hop=HOARE apps/tps-game launch orch-main-r182 row=BOHM-JACOPINI-n-r166-2 1791672184
RESULT gm-wait-dispatch-orphaned-claim-reaped-after-60s resolved 6361c0974b464e74aa95450c51548b3d8e0ec293 next=none
tick 110 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r183 row=BOHM-JACOPINI-n-r166-1 1791672201
20261010T224321Z | scripts/player-manager-send-failure-witness.mjs + scripts/WebSocketTransport-witness.mjs + scripts/WebSocketClientTransport-witness.mjs + scripts/transport-connect-error-witness.mjs + scripts/netcode-profile-downgrade-witness.mjs | exit=0 | RESULT: PASS -- all five green: 17, 25 and 4 claims plus the two named RESULT lines | module=C:\dev\spoint\src\transport\WebSocketTransport.js + WebSocketClientTransport.js | independent session=orch-main-r149-witness-b | dispatch=1791671961084-500-38cb1229fc0a5624 | sha=58199b6f6f81d7ce61368cb001aab5331d0291a8 | row=CQS-n-r139-3
20261010T224333Z | scripts/WebSocketClientTransport-witness.mjs | exit=1 | RESULT: FAIL -- 2 of 25 claims failed | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=global WebSocket (runtime-provided) | output=.gm/witness-out/WebSocketClientTransport-witness-20261010T224333Z-4860-3c0f73.txt | sha256=4e6eed01d901cfe0a122706aabe44792c4c3f123abb65e42af244127deb17026
2026-10-10T22:43:41.556Z | NetworkSimTransport-witness | exit 1 | RESULT: FAIL | module src/transport/NetworkSimTransport.js | claims 21/35 | out - | sha256 -
20261010T224402Z | scripts/WebSocketClientTransport-witness.mjs | exit=0 | RESULT: PASS -- 25 of 25 claims | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=global WebSocket (runtime-provided) | output=.gm/witness-out/WebSocketClientTransport-witness-20261010T224402Z-30664-50e685.txt | sha256=77747376641940ea200ef11f6707e6d099f9356e04d7abb050aa3478b753f553
2026-10-10T22:44:07.458Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=1 RESULT: FAIL (16 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-10T22-44-07-458Z-22828.txt sha256=f5d274b65a12a4e54c420933a5187d8e7c516fa0e8ac8e522956d2c90c006c5f
node scripts/render-debug-panel-witness.mjs | exit 0 | RESULT: PASS -- 51 check(s) over 12 toggle write(s) on client/hud/RenderDebugPanel.js, 7/7 scratch mutant(s) caught | 2026-10-10T22:44:24Z | dispatch 1791672095853-500-96a6c97e9c827ec5
HOP client/xr BOHM-JACOPINI 6 violations witness=1791672061850-500-815d607fb613d7a5 next=IMMUT client/xr
tick 111 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r184 hop=IMMUT client/xr 1791672297
2026-10-10T22:45:09.012Z witness=scripts/WorkerTransport-witness.mjs module=C:/dev/spoint/src/transport/WorkerTransport.js exit=1 RESULT: FAIL (57 of 59 expectations hold) out=.gm/witness-out/WorkerTransport-witness-2026-10-10T22-45-09-012Z-19724.txt sha256=90f99b12c48cd003d3e49fce82bd4810a40210708003ad566f493ae7f06265c4
20261010T224509Z | scripts/WebSocketClientTransport-witness.mjs | exit=0 | RESULT: PASS -- 25 of 25 claims | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=global WebSocket (runtime-provided) | output=.gm/witness-out/WebSocketClientTransport-witness-20261010T224509Z-29268-91e8df.txt | sha256=51e4dfc134ffb24988a7d24a807b19a626c8b9d0ec0aa1ba6c3085557eba2f31
2026-10-10T22:45:14.316Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=1 RESULT: FAIL (16 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-10T22-45-14-316Z-29364.txt sha256=f5d274b65a12a4e54c420933a5187d8e7c516fa0e8ac8e522956d2c90c006c5f
2026-10-10T22:45:48.764Z | scripts/client-core-exact-patch-frame-witness.mjs | exit=0 | RESULT: PASS checks=15 failed=0 | run=honest | module=C:\dev\spoint\client\core\ExactPatchFrame.js | module_sha256=3c07d4ecc4a71c1167d12ae1a3f68977a3ceb56b35dcad7248cc6998801128b0 | out=.gm/witness-out/witness-gap-ClientCoreExactPatchFrame-honest-20261010T224548764Z.txt | out_sha256=715e26dc085673af961411f2130dc8a3478f74ff84aa2a4b1bdd825987c0e158
- rice-netsim-pending-counter-115 | SUPERSEDED: dispatch 1791671977041-500-11af45b8bf86c744 (commit 5d6a4138c8) added getStats().pending, which broke the exact key set pinned by scripts/NetworkSimTransport-witness.mjs claim stats-start-at-zero-and-copy; reverted in favour of deleting both dead fields
- rice-netsim-pending-counter-115 | NetworkSimTransport dead _pending + _lastScheduledAt removed | exit 0 | RESULT: PASS bothFieldsAbsent=true statsKeys=8 inboundQueue=1->0 inboundDelivered=1 | 2026-10-10T22:45:54Z | dispatch 1791672256590-500-fff4485900824b7e (session rice-netsim-counter-w2)
2026-10-10T22:46:15Z | DBC-n-r134-2 | independent witness orch-main-r165-sub1 (exec_js) | exit 0 | RESULT: PASS 51/51 | module src/transport/WorkerTransport.js | 2026-10-10T22:46:15Z | dispatch 1791672313763-500-e60f0367f7d62ed9 (session orch-main-r165-sub1)
2026-10-10T22:42:04Z | player-manager-send-failure-witness-red-since-095eb522 | exit=0 | RESULT: PASS | script=scripts/player-manager-send-failure-witness.mjs | sendFailuresDelta=4 (was 5) isOpen=false/readyState=2 (was isOpen=true) noTransportDelta=0 (was 2) logLines=2 encode-failed names symbol | dispatch=1791672124131-500-4fac7e93cc14f687 | session=orch-main-r176-w1 | CI run 38092191587 sha=58199b6f job check=success | fix=58199b6f ready is the one state owner isOpen reads
HOP client/editor ILLEGAL 9 violations witness=1791672126447-500-60684ff2e60d351f next=HUGHES client/editor
tick 112 live=20 ceiling=20 floor=10 shortfall=0 done=1(interim a98d8a5c still running bg) launch orch-main-r185 hop=HUGHES client/editor launch orch-main-r186 row=ILLEGAL-n-r177-7 1791672423
2026-10-10T22:48:19.161Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
RESULT player-manager-send-failure-witness-red-since-095eb522 resolved 58199b6f6f81d7ce61368cb001aab5331d0291a8 next=planet-snapshot-groups-by-load-not-headcount
RESULT DBC-n-r134-2 resolved e6337bb55d7483b0da86516ceac2f1803454a18c next=DBC-n-r134-3
tick 113 live=20 ceiling=20 floor=10 shortfall=0 done=2 launch orch-main-r187 row=ILLEGAL-n-r177-6 launch orch-main-r188 row=ILLEGAL-n-r177-5 1791672523
RESULT CQS-n-r139-3 resolved 58199b6f6f81d7ce61368cb001aab5331d0291a8 next=CQS-n-r139-2
tick 114 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r189 row=ILLEGAL-n-r177-4 1791672542
HOP client/ui HUGHES 9 violations witness=1791672459074-500-23e8a825a1dafb46 next=PBTAGENT client/ui
RESULT DRY-n-r141-3 resolved b39090197a9014eeaec3c95887064dc6be1f9598 next=DRY-n-r141-3-follow-orch-main-r159
tick 115 live=20 ceiling=20 floor=10 shortfall=0 done=2 launch orch-main-r190 hop=PBTAGENT client/ui launch orch-main-r191 row=ILLEGAL-n-r177-3 1791672559
tick 115 correction launch orch-main-r191 refused ceiling=20 row=ILLEGAL-n-r177-3 queued for next free slot 1791672579
HOP client/xr IMMUT 5 violations witness=1791672505748-500-c7d79a3d255d71a3 next=OWNERSHIP client/xr
tick 116 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r191 row=ILLEGAL-n-r177-3 (dequeued) queued=hop OWNERSHIP client/xr 1791672600
HOP apps/tps-game HOARE 7 violations witness=1791672470765-500-e92e86e8b8d2cd5d next=MILNER apps/tps-game
tick 117 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r192 hop=OWNERSHIP client/xr queued=hop MILNER apps/tps-game 1791672696
2026-10-10T22:52:00.754Z witness=scripts/WorkerTransport-witness.mjs module=C:/dev/spoint/src/transport/WorkerTransport.js exit=1 RESULT: FAIL (57 of 59 expectations hold) out=.gm/witness-out/WorkerTransport-witness-2026-10-10T22-52-00-754Z-27844.txt sha256=8935aea4c1edcb4c4421cb1bf791e975524ff4c9929cfe940657bf4c38b4ed22
20261010T225200Z | scripts/WebSocketClientTransport-witness.mjs | exit=0 | RESULT: PASS -- 25 of 25 claims | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=global WebSocket (runtime-provided) | output=.gm/witness-out/WebSocketClientTransport-witness-20261010T225200Z-27496-f2f74a.txt | sha256=0311b2038f263124573f1ba37411a56b1d44b469a9d90400805c28d80d962a8c
2026-10-10T22:52:05.619Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=1 RESULT: FAIL (16 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-10T22-52-05-619Z-18200.txt sha256=f5d274b65a12a4e54c420933a5187d8e7c516fa0e8ac8e522956d2c90c006c5f
HALTING-n-r101-1 | witness 1791672615741-500-1867ed341c0d438 | exit 0 | RESULT: PASS | 2026-10-10T22:52:12.280Z | dispatch 1791672615741-500-1867ed341c0d438 | sha 856dd5d83bebcac2e67982e04aac671acc2953c7 | session orch-main-r174-w1 | module client/core/MeshDebug.js | 22/22 checks, RED dispatch 1791672402627-500-9cd511452daae983 (unfixed: 6 polls and 0 console lines past the bound)
RESULT rice-netsim-pending-counter-115 resolved 27974172d73c682ba50aa43562fb04372a1a1029 next=CQS-n-r139-2
tick 118 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r193 hop=MILNER apps/tps-game 1791672794
RESULT DBC-n-r152-1 resolved e59d3a9f37e95fdfdb178038f4d6d5f2dbc292fb witness=1791672720113-500-af5bb1072357f601 next=DBC-n-r152-1-c2-orch-main-r173
2026-10-10T22:54:07.113Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
RESULT HALTING-n-r101-1 resolved 856dd5d83bebcac2e67982e04aac671acc2953c7 next=HALTING-n-r101-2
RESULT DRY-n-r141-4 resolved 646924ded94894b233fff0003568756dbb9c712f next=DRY-n-r141-1
RESULT DBC-n-r152-1 resolved e59d3a9f37e95fdfdb178038f4d6d5f2dbc292fb next=DBC-n-r152-1-c2-orch-main-r173
tick 119 live=20 ceiling=20 floor=10 shortfall=0 done=3 launch orch-main-r194 row=HALTING-n-r101-2 launch orch-main-r195 row=DRY-n-r141-1 launch orch-main-r196 row=ILLEGAL-n-r177-2 1791672907
- 2026-10-10T22:55:07.828Z | witness=fade-one-clock (client/xr/XRWidgets.js updateFade) | dispatch=1791672829722-500-2ec0bba782a14fb7 | exit=0 | RESULT: PASS | session=orch-main-r182 | row=BOHM-JACOPINI-n-r166-2
2026-10-10T22:56:09.097Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
2026-10-10T22:56:33.509Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
2026-10-10T23:04:12.000Z | XRWidgets-teleport-sequence-witness | exit 0 | RESULT: PASS | module client/xr/XRWidgets.js | claims 8/8 | out - | sha256 -
DBC-n-r134-4 scripts/NetworkSimTransport-witness.mjs exit=0 "RESULT: PASS" claims=35/35 ts=2026-10-10T22:56:09Z dispatch=1791672969414-500-24ba40e3b29551c9
DBC-n-r134-4 exec_js P1-P12+S1+R2a+R4 exit=0 "RESULT: PASS" claims=15/15 ts=2026-10-10T22:55:52Z dispatch=1791672952555-500-d460975d994b8902
DBC-n-r134-4 second-session witness orch-main-r178-sub1 scripts/NetworkSimTransport-witness.mjs exit=0 "RESULT: PASS" claims=35/35 ts=2026-10-10T22:56:33.509Z dispatch=1791672993942-500-2e5abd133bdc52ee
RESULT XY-SPOOL-FILENAME-WRITER resolved 9a6c73df2152480fe79140c93c2d455f98e26014 next=SPOOL-TEMP-STAGED-IN-INBOX
tick 120 live=20 ceiling=20 floor=10 shortfall=0 open=1023 launchable=221 done=1 launch orch-main-r197 row=BOHM-JACOPINI-n-r166-2-scandeps-orch-main-r182 1791673120
2026-10-10T22:59:23.088Z | row LAMPORT-n-r129-3 | witness exec_js consistent-cut (two writers interleaved, saturating + realistic duty arms) | exit 0 | RESULT: PASS consistent-cut | dispatch 1791673005169-500-2c8880bded3b4cf2 | session orch-main-r171-w1
ILLEGAL-n-r177-7 page-boot-witness(editor-overlay-visibility) exit=0 RESULT: PASS ts=2026-10-10T22:59:28.416Z dispatch=1791673100396-500-93bb087753880d75
2026-10-10T22:59:43.037Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
RESULT BOHM-JACOPINI-n-r166-2 blocked next=BOHM-JACOPINI-n-r166-2-blocker-orch-main-r182
tick 121 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r198 row=DBC-n-r152-1-c4-orch-main-r173 1791673212
scan_deps exit=0 RESULT: filesScanned=1325 blockedCount=0 failCount=0 symlinkEscapeCount=0 nodeModulesPresent=true warnCount=3 (./client/basis/basis_transcoder.js 3027, ./packages/streaming-gltf/src/basis/basis_transcoder.js 3027, ./packages/streaming-gltf/src/draco-loader.js 5519) - no dependency blocker on the fade-one-clock change | 2026-10-10T23:00:29.086Z | dispatch=1791673199937-500-1bbce94fa9955573 | session=orch-main-r197
HOP client/ui PBTAGENT 10 violations witness=1791672917977-500-bd927b9f5b6fb6d3 next=INVARIANTRUN client/ui
tick 122 live=20 ceiling=20 floor=10 shortfall=0 open=1039 launchable=237 done=1 launch orch-main-r199 hop=INVARIANTRUN client/ui 1791673360
HOP client/xr OWNERSHIP 8 violations witness=1791673025494-500-1906fdbbb1f667a9 next=DRY client/xr
tick 123 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r200 hop=DRY client/xr 1791673373
- DRY-n-r141-1: verify-doc-claims-witness (fixture) exit=0 RESULT: PASS 20/20 checks ok; real-tree scripts/lib/verify-doc-claims.mjs write-only key findings: 0, __dprAuto [0 consumer] NONE, fold findings: 17 unchanged from the pre-edit baseline (foreign AGENTS.md dirt); 2026-10-10T23:02:31Z; dispatch 1791673351104-500-21eb95b251245a0d
2026-10-10T23:11:44.000Z | xr-teleport-sequence-witness | exit 0 | RESULT: PASS | module client/xr/XRWidgets.js | claims 8/8 | out scripts/xr-teleport-sequence-witness.mjs | sha256 -
RESULT ILLEGAL-n-r177-4 blocked next=mapspinner-gl-render-has-no-dispose (not in slots.candidates; LAMPORT-n-r129-1 taken instead)
RESULT BOHM-JACOPINI-n-r166-2-scandeps-orch-main-r182 resolved f48a9c960e3e48f3b69096875320a850de26ce56 next=BOHM-JACOPINI-n-r166-2
RESULT LAMPORT-n-r129-3 resolved c7bfb61af75b2c3d1bace6932b9bc6c4cd0e1988 next=LAMPORT-n-r129-4
tick 124 live=20 ceiling=20 floor=10 shortfall=0 done=3 launch orch-main-r201 row=LAMPORT-n-r129-1 launch orch-main-r202 row=OWNERSHIP-n-r192-1 launch orch-main-r203 row=OWNERSHIP-n-r192-2 1791673568
RESULT BOHM-JACOPINI-n-r166-1 resolved 04f09e6f0c878fa7d7bf23c3413077472b53defb next=BOHM-JACOPINI-n-r166-5
RESULT DBC-n-r134-4 resolved cb0b06c261299a24d307ea4faa825d7d92f66adb next=planet-wrap-seamless
tick 125 live=20 ceiling=20 floor=10 shortfall=0 done=2 launch orch-main-r204 row=OWNERSHIP-n-r192-3 launch orch-main-r205 row=OWNERSHIP-n-r192-4 1791673672
scripts/cache-revalidation-sweep-halting-witness.mjs | exit=0 | RESULT: PASS | CHECKS 30 FAILS 0 | 2026-10-10T23:07:29Z | dispatch 1791673569888-500-b501d90fc6a2c077 (verifier session orch-main-r194-w1, editing session orch-main-r194)
scripts/cache-revalidation-sweep-halting-witness.mjs | exit=0 | RESULT: PASS | CHECKS 30 FAILS 0 | 2026-10-10T23:09:00Z | dispatch 1791673666439-500-e7033ca88f9cdde6 (verifier session orch-main-r194-w1, blob ce9a3e0a: re-run after the catch-binding follow-up edit)
RESULT ILLEGAL-n-r177-7 resolved 9bde6e66346d86dbcaa584d7bec534ccc092301c next=ILLEGAL-n-r177-8
tick 126 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r206 row=OWNERSHIP-n-r192-5 1791673774
HOP apps/tps-game MILNER 4 violations witness=1791673527312-500-e20eabede5c27825 next=ILLEGAL apps/tps-game
tick 127 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r207 hop=ILLEGAL apps/tps-game 1791673896
- 2026-10-10T23:11:42.483Z | DBC-n-r152-1-c4-orch-main-r173 | precondition-check: git_status scripts/lib/net-conditioner.mjs | exit 0 | RESULT: BLOCKED (file dirty, gate "work it when clean" unmet) | dispatch 1791673719696-500-4097e135ac8b6fd3

ILLEGAL-n-r177-5 | fsbrowse-save-base | exit=0 | RESULT: PASS | 2026-10-10T23:12:16.708Z | dispatch=1791673856033-500-60770e87a40e6860 | live import of client/editor/EditorFsBrowse.js under a resolution adapter for the anentrypoint-design importmap specifier; fsSaveBase(null)=null, fsSaveBase({mtimeMs:undefined})={mtimeMs:null}, fsSaveBase({mtimeMs:1700000000000})={mtimeMs:1700000000000}; component drive: Ctrl+S with nothing loaded -> onSave 0 calls, onGetSource 2; loaded with revision -> onSave("a.js","code",{mtimeMs:1700000000000}); loaded unversioned -> onSave("a.js","code",{mtimeMs:null})
ILLEGAL-n-r177-6 | client/editor/EditorFsBrowse.js: _loading/_unavailable/_tree collapsed to one tagged _state (loading|unavailable|ready), open-file path cannot skip unavailable | exit 0 | RESULT: PASS -- 15 check(s) | 2026-10-10T23:13:03.989Z | dispatch 1791673685970-500-acf3289d758a363f (session orch-main-r187-w1)
RESULT DBC-n-r152-1-c4-orch-main-r173 blocked next=chart-reanchor-client-relocation-bookmarks-transfer
tick 128 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r208 hop=ILLEGAL src/transport (unscanned surface, traversal) 1791673984
HOP client/xr DRY 11 violations witness=1791673540386-500-66c3813fc6c7cfe5 next=KISS client/xr
tick 129 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r209 hop=KISS client/xr 1791674001
OWNERSHIP-n-r192-2 click-ownership fix-shape witness exec_js exit=0 RESULT: PASS current after2 onStart:2/onEnd:1 (after1 1/0) == expected; single-owner after2 onStart:1/onEnd:1 (after1 1/0) == expected 2026-10-10T23:12:27Z 1791673947305-500-475585c7d885e10c
1791673824322-500-ca99e51e665844b9 wm-window-state live chrome exit=0 RESULT: PASS illegalBoth=false states=normal,minimized,maximized,minimized,normal,maximized,minimized ts=2026-10-10T23:13:37Z session=orch-main-r196-w row=ILLEGAL-n-r177-2 sha=968d07435a89d68f7618c35a6b8900da16a31f3c
HOP client/editor INVARIANTRUN 7 violations witness=1791674826903-500-5f179878f9e82b7c next=DBC client/editor
OWNERSHIP-n-r192-3 | exec_js (real extracted setupSessionListeners source, fake renderer.xr + controllable timer registry) | exit=0 | RESULT: PASS | 14/14 fields match (A_armed_timers=1 A_timers_after_end=0 A_handle=0 A_getReferenceSpace=0 A_setReferenceSpace=0 A_cameraSets=0 A_base=null B_getReferenceSpace=1 B_setReferenceSpace=1 B_cameraSets=[[10,6.6,-3]] B_base_notnull=true B_handle_after_fire=0 C_armed_timers=1 C_setReferenceSpace=1) | module=client/xr/XRSystem.js | 2026-10-10T23:16:16Z | dispatch=1791673976679-500-9c392f5eaf2a6d2e | session=orch-main-r204-w1
2026-10-10T23:14:01.386Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
2026-10-10T23:15:30.805Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
ILLEGAL-n-r177-6 | client/editor/EditorFsBrowse.js tagged _state re-witness incl. binary-arm null-node guard | exit 0 | RESULT: PASS -- 11 check(s) | 2026-10-10T23:17:09.290Z | dispatch 1791674188432-500-51bc7234180efe1a (session orch-main-r187-w2)

OWNERSHIP-n-r192-1 | client/xr/XRWidgets.js teleport stops borrowing the XR reference space (pending holds {pt}; moveTeleport reads the live space; sessionend cancels) | exit 0 | RESULT: PASS -- 3 check(s) | 2026-10-10T23:17:52.876Z | dispatch 1791674237413-500-e29027cce9cab09d (session orch-main-r202-w1)
LAMPORT-n-r129-1 | exec_js harness (live src/transport/NetworkSimTransport.js, seeded RNG + fake clock) exit=0 RESULT: PASS checks=13/13 (jitter arm receiver inversions 24 == inboundReordered 24, control 0/0, reorder 1/1 with the index paired to its own payload through the swap, loss 27/40 delivered leaving a 13-wide index gap, sendIndex present on every arm) | tracked scripts/NetworkSimTransport-witness.mjs exit=0 RESULT: PASS claims 35/35 | 2026-10-10T23:22:02.152Z | dispatch=1791674122152-500-3f6d899f7be43c76 (harness) dispatch=1791674131082-500-ee2fb27a4cb22001 (tracked) | witness session orch-main-r201-sub2, editing session orch-main-r201

ILLEGAL-n-r177-5 | fsbrowse-save-base-witness | exit=0 | RESULT: PASS | 2026-10-10T23:20:00.455Z | dispatch=1791674276606-500-db7a6d730c2eee98 | scripts/fsbrowse-save-base-witness.mjs: fsSaveBase(null)=null, fsSaveBase(unversioned)={mtimeMs:null}, fsSaveBase(revision)={mtimeMs:1700000000000}; Ctrl+S unloaded -> 0 saves + 2 reloads, loaded -> onSave carries {mtimeMs}
RESULT OWNERSHIP-n-r192-2 blocked next=OWNERSHIP-n-r192-2-blocker-orch-main-r203
RESULT DRY-n-r141-1 resolved b1e47bd900dae0858491c27f3168661fa55fbc6c next=HALTING-n-r101-3
RESULT OWNERSHIP-n-r192-3 resolved b11c54f21ed1c835c4301e8dd54ec4bdf5b85af3 next=OWNERSHIP-n-r192-4
tick 130 live=18 ceiling=20 floor=10 shortfall=0 done=3 launch orch-main-r210 row=DRY-n-r200-4 launch orch-main-r211 row=DRY-n-r200-5 1791674432
- 2026-10-10T23:25:20.601Z row=ILLEGAL-n-r177-3 witness=1791674407425-500-1187fd97cf71ef9c session=orch-main-r191-sub1 exit=0 RESULT=PASS CHECKS=26 FAILED=0 sha=cc1dedf935b477f0ef8b120c23d1b19e4fb47ba9 note=union-tagged setSource; error-with-source no longer renders a Save-enabled editor
RESULT ILLEGAL-n-r177-2 resolved 968d07435a89d68f7618c35a6b8900da16a31f3c next=ILLEGAL-n-r177-1
nomination HALTING-n-r101-3 not in slots.candidates (advisory only)
tick 131 live=17 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r212 row=DRY-n-r200-6 launch orch-main-r213 row=DRY-n-r200-8 launch orch-main-r214 row=DRY-n-r200-9 1791674525
2026-10-10T23:22:09.796Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
2026-10-10T23:22:10.334Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
RESULT gm-git-pull-refused-dirty-tree-blocks-served-recovery resolved d549b57808c83d3f4f93c88cd1843889a1cecf47 next=PLUGKIT-SEMVER-VERSION-SET (gm git lane free)
tick 132 live=20 ceiling=20 floor=10 shortfall=0 done=1 1791674564
RESULT HALTING-n-r101-2 resolved a4c6959eb2240ce82d971fff109181731d30f91a next=HALTING-n-r101-3
HOP apps/tps-game ILLEGAL 8 violations witness=1791674311362-500-aa4853e0219c8806 next=PARSEDV apps/tps-game
tick 133 live=18 ceiling=20 floor=10 shortfall=0 done=2 launch orch-main-r215 row=DRY-n-r200-10 launch orch-main-r216 hop=PARSEDV apps/tps-game 1791674621
PUBLISH gm skills/gm-orchestrate/SKILL.md sha=25fdb7feb4e4f1b34aa96abd16aca894f8245762 pushed ci=pending runs=38094885290,38094885353 1791674665
tick 134 live=20 ceiling=20 floor=10 shortfall=0 open=1083 launchable=258 blocked new-candidates=ILLEGAL-n-r208-1..7 1791674690
HOP src/transport ILLEGAL 8 violations witness=1791674324206-500-b4d4b4f37ce97b47 next=PARSEDV src/transport
RESULT ILLEGAL-n-r177-3 resolved cc1dedf935b477f0ef8b120c23d1b19e4fb47ba9 next=ILLEGAL-n-r177-1
tick 135 live=18 ceiling=20 floor=10 shortfall=0 done=2 launch orch-main-r217 row=ILLEGAL-n-r208-1 launch orch-main-r218 row=ILLEGAL-n-r208-2 1791674777

OWNERSHIP-n-r192-1 | client/xr/XRWidgets.js teleport stops borrowing the XR reference space (pending holds {pt}; moveTeleport builds the offset from the live space only while renderer.xr.isPresenting) | exit 0 | RESULT: PASS -- 3 check(s) | 2026-10-10T23:27:15.265Z | dispatch 1791674801433-500-2bd8683489b3309c (session orch-main-r202-w1) | supersedes dispatch 1791674237413-500-e29027cce9cab09d
ILLEGAL-n-r177-6 | EditorFsBrowse tagged _state: loading/unavailable/ready, open-file path surfaces the reason, binary arm guards the null node | exit 0 | RESULT: PASS -- 11 check(s) | 2026-10-10T23:27:03.308Z | dispatch 1791674823330-500-4ef6a6fda48d82e6 (session orch-main-r187-w3) | out .gm/witness-out/EditorFsBrowse-tagged-state-w187.txt sha256 0c42aefe21b4d49c87b704483dbe17b4456a5ce7ab8cdc8496ad6483db721559
PUBLISH gm sha=25fdb7feb4e4f1b34aa96abd16aca894f8245762 ci=success jobs=release,scan
RESULT OWNERSHIP-n-r192-5 blocked next=OWNERSHIP-n-r192-6
RESULT ILLEGAL-n-r177-5 interim (ci check still running, child work live)
tick 136 live=18 ceiling=20 floor=10 shortfall=0 done=2 launch orch-main-r219 row=ILLEGAL-n-r208-3 launch orch-main-r220 row=OWNERSHIP-n-r192-6 1791674893
RESULT ILLEGAL-n-r177-6 resolved ce9486350fd2b987d4ddb316726a77957dc84455 next=ILLEGAL-n-r177-1
tick 137 live=19 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r221 row=ILLEGAL-n-r208-4 1791674924
DRY-n-r200-4 | identity-rotation-constant-patch (in-memory, no write to a held file) | exit 0 | RESULT: PASS -- inline literal { x: 0, y: 0, z: 0, w: 1 } at XRSystem.js:101, XRSystem.js:146, XRWidgets.js:121 -> 0 remaining after patch; import { XR_IDENTITY_ROTATION } from './xrSpace.js' added to both; constant initializer byte-identical to the removed literal; both transformed sources parse (data-URL link TypeError, not SyntaxError) | 2026-10-10T23:28:44.586Z | dispatch 1791674897208-500-21cd836fb3022865
tick 138 live=20 ceiling=20 floor=10 shortfall=0 open=1088 launchable=258 blocked candidates=ILLEGAL-n-r208-5..8,ILLEGAL-TPS-r207-6,7 1791675042
tick 139 live=20 ceiling=20 floor=10 shortfall=0 open=1097 launchable=271 blocked candidates=KISS-n-r209-2..10,INVARIANTRUN-n-r185h1s1-2..4 1791675154
RESULT LAMPORT-n-r129-1 resolved de76088421608be3770dc1f6fb9bccf78867af81 next=mapspinner-gl-render-has-no-dispose
tick 140 live=19 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r222 hop=MILNER client/core (unscanned surface; advertised candidates KISS-n-r209-*,INVARIANTRUN-n-r185h1s1-* are children of live hops KISSRUN/hop:PBTAGENT) 1791675248
2026-10-11 2026-10-10T23:34:46.789Z | OWNERSHIP-n-r192-4 | exec_js xr-ownership-single-writer-witness | exit=0 | RESULT: PASS | dispatch=1791674908662-500-557a1b99223b85d (witness session orch-main-r205-sub1; first run 1791674814805-500-92154be86237c053 session orch-main-r205) | regression scripts/xr-teleport-sequence-witness.mjs exit=0 RESULT: PASS dispatch=1791674835661-500-ac8834c83f263d7b | state+res exec_js exit=0 RESULT: PASS dispatch=1791675012019-500-d7a492ff12e485f | delivery gated: see OWNERSHIP-n-r192-4-blocker-orch-main-r205
xr-ray-line-factory | exit 0 | RESULT: PASS laserPointer handRay teleportArc count/color/opacity/name/geometry equivalent | 2026-10-10T23:35:23.003Z | 1791675143999-500-c71ee6b352302fe0

DRY-n-r200-9 | latch-table-patch (in-memory, no write to a held file) | exit 0 | RESULT: PASS -- 19 check(s) | 2026-10-10T23:36:18.256Z | dispatch 1791675220163-500-30912267bb102178 (session orch-main-r214-w1) | out .gm/witness-out/DRY-n-r200-9-latch-table-r214.txt sha256 92eb8de7fc767c112b2832b45fc07c49e06d8d425eca80afa2185c821213555a
2026-10-10T23:37:15.398Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
