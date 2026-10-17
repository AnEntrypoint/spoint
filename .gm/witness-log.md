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
tick 141 live=20 ceiling=20 floor=10 shortfall=0 open=1101 launchable=273 blocked candidates=PARSEDV-n-r216-3/5,INVARIANTRUN-n-r185h1s1-1..4,METAMORPH-n-r199-1..6 aging=orch-main-r218(332s) 1791675500
HOP apps/tps-game PARSEDV 10 violations witness=1791674880310-500-dca0e7e50b94bb50 next=WADLER apps/tps-game
tick 142 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r223 hop=WADLER apps/tps-game 1791675525
2026-10-10T23:39:34.575Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=1 RESULT: FAIL (16 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-10T23-39-34-575Z-28016.txt sha256=5dc9826f9db375dc741a47aca7689ab8341537715615b6c250f5bd81d35c5965
witness=xr-screen-quad-witness.mjs row=DRY-n-r200-8 exit=0 result=RESULT: PASS utc=2026-10-10T23:40:03Z dispatch=1791675582956-500-4a41fa9f933ef4d7 session=orch-main-r213-sub1
RESULT OWNERSHIP-n-r192-1 resolved ba46f35af072e64299642aa7e1cb500c51ea0e4b next=OWNERSHIP-n-r192-1-blocker-orch-main-r202
RESULT DRY-n-r200-4 blocked next=DRY-n-r200-4-blocker-orch-main-r210
tick 143 live=20 ceiling=20 floor=10 shortfall=0 done=2 launch orch-main-r224 hop=KISS client/hud launch orch-main-r225 hop=HUGHES src/netcode (advertised PARSEDV-n-r216-*,METAMORPH-n-r199-*,INVARIANTRUN-n-r185h1s1-* are hop children on surfaces apps/tps-game,client/ui held by live hops WADLER,FUZZ) 1791675638
VERIFY ba46f35af072e64299642aa7e1cb500c51ea0e4b author=lanmower ci=success jobs=check(success) frame-time(skipped,no gpu runner) run=38095122333 1791675697
2026-10-10T23:41:49.599Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=1 RESULT: FAIL (16 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-10T23-41-49-599Z-14424.txt sha256=5dc9826f9db375dc741a47aca7689ab8341537715615b6c250f5bd81d35c5965
20261010T234256Z | scripts/WebSocketClientTransport-witness.mjs | exit=0 | RESULT: PASS -- 25 of 25 claims | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=global WebSocket (runtime-provided) | output=.gm/witness-out/WebSocketClientTransport-witness-20261010T234256Z-29264-d6e112.txt | sha256=06b5d8feed1a7897899c0b4bf2435f970b7f4a92481d474e7be1ea8a26d680f3
2026-10-10T23:43:35.602Z | inline exec_js lifecycle witness | exit=0 | RESULT: PASS -- 11 of 11 checks | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=ws polyfill on globalThis.WebSocket | dispatch=1791675693488-500-3e2d995892d39601 | session=orch-main-r218-w1 | row=ILLEGAL-n-r208-2
2026-10-10T23:43:35.602Z | scripts/WebSocketClientTransport-witness.mjs (pre-existing on disk, untracked) | exit=0 | RESULT: PASS -- 25 of 25 claims | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | dispatch=1791675781466-500-6e3bc16963ad68dd | session=orch-main-r218-w1 | row=ILLEGAL-n-r208-2 regression
2026-10-10T23:42:15.000Z | DRY-n-r200-10 | exec_js xr-handsdetected-single-owner-witness | exit=0 | RESULT: PASS | module client/xr/XRWidgets.js | claims 6/6 | dispatch=1791675440030-500-f92fbb2faa116078 (session orch-main-r215) | baseline dispatch=1791675344298-500-3890eba75890e0d3 exit=0 RESULT: PASS | regression scripts/xr-teleport-sequence-witness.mjs exit=1 pre-existing (XRWidgets.js:3 imports ./XRRayLine.js, harness copies XRWidgets.js only; already FAIL at dispatch 1791674493565 per prd.yml) | out - | sha256 -
tick 144 live=20 ceiling=20 floor=10 shortfall=0 open=1102 launchable=283 blocked candidates=ILLEGAL-n-r209-1,PARSEDV-n-r216-3/5,INVARIANTRUN-n-r185h1s1-1..4,METAMORPH-n-r199-2..6 removed-dirty=perf-baseline-gap-to-60fps-measured-spoint-orch-b186-u4 1791675878
interim DRY-n-r200-9 (CI check run 38095700239, monitor armed; slot not refilled) 1791675878
2026-10-10T23:44:38.774Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
20261010T234439Z | scripts/WebSocketClientTransport-witness.mjs | exit=0 | RESULT: PASS -- 25 of 25 claims | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=global WebSocket (runtime-provided) | output=.gm/witness-out/WebSocketClientTransport-witness-20261010T234439Z-29952-7b19e9.txt | sha256=b2a5d63b294f60df2774eb7e22c17f2716770333199b2fed05cddc675ee50185
2026-10-10T23:44:43.847Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=1 RESULT: FAIL (16 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-10T23-44-43-847Z-22808.txt sha256=5dc9826f9db375dc741a47aca7689ab8341537715615b6c250f5bd81d35c5965
2026-10-10T23:44:44.061Z witness=scripts/WorkerTransport-witness.mjs module=C:/dev/spoint/src/transport/WorkerTransport.js exit=1 RESULT: FAIL (57 of 59 expectations hold) out=.gm/witness-out/WorkerTransport-witness-2026-10-10T23-44-44-061Z-24780.txt sha256=31f44389be9432fd8cac3c430342360d3eef5f93834c502306040637f2599d67

2026-10-10T23:43:55.000Z | OWNERSHIP-n-r192-6 | inline exec_js AR ownership witness (real client/xr/XRSystem.js, stubbed DOM + fake XRSession) | exit=0 | RESULT: PASS | module client/xr/XRSystem.js | claims 5/5 (color/texture/null identity restore, failed-start untouched, post-failure cycle) | dispatch=1791675802800-500-77fb17db6ece3896 | session=orch-main-r220-w1 | baseline dispatch=1791675533545-500-5f3e77d1c6de3c85 exit=0 RESULT: FAIL (endBg=Color#87ceeb, endDisp="block") | out - | sha256 -
tick 145 live=20 ceiling=20 floor=10 shortfall=0 open=1107 launchable=289 blocked candidates=FUZZ-n-r199-1..4,MILNER-n-r222-1,ILLEGAL-n-r209-2,PARSEDV-n-r216-3/5,INVARIANTRUN-n-r185h1s1-2..4 1791676024
20261010T234747Z | scripts/WebSocketClientTransport-witness.mjs | exit=0 | RESULT: PASS -- 25 of 25 claims | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=global WebSocket (runtime-provided) | output=.gm/witness-out/WebSocketClientTransport-witness-20261010T234747Z-30296-c820c7.txt | sha256=1d5e2a431b808adfe76fa01b11217ebf83c30c99b3b5c212c44f65332f22958d
tick 146 live=20 ceiling=20 floor=10 shortfall=0 open=1114 launchable=295 blocked candidates=DBC-n-r185h1s2-4/5,FUZZ-n-r199-1.. aging=orch-main-r214(379s) orch-main-r225(348s) 1791676133
2026-10-10T23:49:20.000Z | DRY-n-r200-10 | exec_js xr-handsdetected-single-owner-witness (independent replay against committed e231b952) | exit=0 | RESULT: PASS | module client/xr/XRWidgets.js | claims 5/5 | dispatch=1791676137126-500-6cfcf93d1be4d58d (session orch-main-r215-sub1) | out - | sha256 -
20261010T234922Z | scripts/WebSocketClientTransport-witness.mjs | exit=0 | RESULT: PASS -- 25 of 25 claims | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=global WebSocket (runtime-provided) | output=.gm/witness-out/WebSocketClientTransport-witness-20261010T234922Z-20652-45c7e2.txt | sha256=292b7c31da41dcb91c5959175d743c1b9545d0961c12119c9e65e8b462d2f714
DRY-n-r200-5 | witness=exec_js(client/xr live: XRControls.init, createXRButton, XRSystem.createXRSystem under navigator.xr absent / present-unsupported / present-supported, plus isSessionSupported occurrence census) | exit=0 | RESULT: PASS | checks=13 failed=0 | ts=2026-10-10T23:49:30Z | dispatch=1791675314387-500-6f7cd4c4fcfe609c | session=orch-main-r211-w
2026-10-10T23:51:06.581Z | inline exec_js lifecycle witness re-run against the landed twin-converged shape | exit=0 | RESULT: PASS -- 12 of 12 checks | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=ws polyfill on globalThis.WebSocket | dispatch=1791676161202-500-b5fd19384b1ce5e8 | session=orch-main-r218-w1 | row=ILLEGAL-n-r208-2
20261010T235137Z | scripts/WebSocketClientTransport-witness.mjs | exit=0 | RESULT: PASS -- 25 of 25 claims | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=global WebSocket (runtime-provided) | output=.gm/witness-out/WebSocketClientTransport-witness-20261010T235137Z-15076-e5b5a8.txt | sha256=38e43d9ccccce94afcbc2014e7cdd49a7f558267804501e33a07e58e2f571dd9
HOP client/core MILNER 1 violations witness=1791675794273-500-d810fabf28123f1f next=ILLEGAL client/core
RESULT DRY-n-r200-8 resolved e231b952da917860090a7252980c0d043bc56e73 next=KISS-n-r209-3
tick 147 live=20 ceiling=20 floor=10 shortfall=0 done=2 launch orch-main-r226 hop=ILLEGAL client/core launch orch-main-r227 hop=METAMORPH src/apps (advertised DBC-n-r185h1s2-*,FUZZ-n-r199-*,KISS-n-r209-* sit on client/editor,client/ui,client/xr held by live hops) 1791676346
- r208-3 ready-accessor: exit 0, RESULT: PASS claims=32 failed=0, 2026-10-10T23:51:37Z, dispatch 1791676279869-500-fbe4684430b2bd03
VERIFY e231b952da917860090a7252980c0d043bc56e73 author=lanmower (DRY-n-r200-8, OWNERSHIP-n-r192-6 both name this sha)
RESULT OWNERSHIP-n-r192-6 resolved e231b952da917860090a7252980c0d043bc56e73 next=OWNERSHIP-n-r192-7
tick 148 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r228 hop=HUGHES src/spatial (client/xr already carries 4 live writers; OWNERSHIP-n-r192-7 deferred) 1791676446
RESULT DRY-n-r200-6 resolved e231b952da917860090a7252980c0d043bc56e73 next=DRY-n-r200-1
tick 149 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r229 hop=DBC src/terrain (unscanned; client/xr keeps 3 live writers) 1791676460
2026-10-10T23:54:38.361Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=1 RESULT: FAIL (16 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-10T23-54-38-361Z-11780.txt sha256=5dc9826f9db375dc741a47aca7689ab8341537715615b6c250f5bd81d35c5965
tick 150 live=20 ceiling=20 floor=10 shortfall=0 open=1115 launchable=304 blocked held=7 hops=10 rows=10 1791676495
2026-10-11 2026-10-10T23:55:18.299Z | OWNERSHIP-n-r192-4 | exec_js xr-ownership-single-writer-witness on the landed tree e231b952 | exit=0 | RESULT: PASS | dispatch=1791676478168-500-1e54345ac1544082 (witness session orch-main-r205-sub2) | 17/17 | partial-patch contract surfaced by the first run dispatch=1791676438234-500-71bb1bd42a6e0719 | regression scripts/xr-teleport-sequence-witness.mjs exit=0 RESULT: PASS dispatch=1791674835661-500-ac8834c83f263d7b | landed at e231b952, CI run 38095966870 check=success (ci-status dispatch=1791676329717-500-aead05f40c03754d) | row closed
tick 151 live=20 ceiling=20 floor=10 shortfall=0 open=1114 launchable=304 blocked 1791676598
RESULT OWNERSHIP-n-r192-4 resolved e231b952da917860090a7252980c0d043bc56e73 next=KISS-n-r209-8 (4th row closed on this sha)
tick 152 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r230 row=KISS-n-r209-8 1791676679
RESULT DRY-n-r200-10 resolved e231b952da917860090a7252980c0d043bc56e73 next=KISS-n-r209-8 (already launched as orch-main-r230, not re-launched)
tick 153 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r231 hop=KISS src/behaviours (unscanned) 1791676698
20261010T235830Z | scripts/WebSocketClientTransport-witness.mjs | exit=0 | RESULT: PASS -- 25 of 25 claims | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=global WebSocket (runtime-provided) | output=.gm/witness-out/WebSocketClientTransport-witness-20261010T235830Z-30600-2b182f.txt | sha256=826678ef962d1738fc377c3afb305451b1915a0bbebf3db91dc963b3c835af83
tick 154 live=20 ceiling=20 floor=10 shortfall=0 open=1112 launchable=300 blocked held=6 1791676750
RESULT ILLEGAL-n-r208-2 resolved 8f811d7d1665d627eec0fef981c4fc6dfa065572 next=ILLEGAL-n-r208-5
HOP src/netcode HUGHES 5 violations witness=1791676145150-500-b22ead2983a76469 next=ILLEGAL src/netcode
HOP client/hud KISS 4 violations witness=1791676324474-500-cf751176e5690106 next=YAGNI client/hud
tick 155 live=20 ceiling=20 floor=10 shortfall=0 done=3 launch orch-main-r232 hop=ILLEGAL src/netcode launch orch-main-r233 hop=YAGNI client/hud launch orch-main-r234 hop=PARSEDV src/sdk (ILLEGAL-n-r208-5 deferred: src/transport keeps 3 live writers) 1791676837
RESULT DRY-n-r200-5 resolved a6828f93d1d23da0517249f5ecc29430469e01bf next=DRY-n-r200-7
VERIFY a6828f93d1d23da0517249f5ecc29430469e01bf ci-run=38096551001 check=success frame-time=skipped
tick 156 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r235 hop=DBC packages/ecs (DRY-n-r200-7 deferred: DBC hop still holds client/xr) 1791677063
RESULT ILLEGAL-n-r208-4 resolved 619ea4e9a61d869a0067d7384a0d67f0879a53ad next=transport-wrapper-base-ready-field-unread
tick 157 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r236 hop=HUGHES packages/mapspinner/src (transport-wrapper-base-ready-field-unread deferred: r208-1 and r208-3 still hold src/transport) 1791677086
tick 158 live=20 ceiling=20 floor=10 shortfall=0 open=1118 launchable=306 blocked held=3 candidates=WADLER-n-r223-1/2,METAMORPH-n-r227-1/2,webtransport-send-throw-leaves-open,DBC-n-r209-1/2,KISS-r224-1/2,HUGHES-n-r225-2/3/4 1791677130
HOP src/apps METAMORPH 4 violations witness=1791676679539-500-7efdd77130d233c6 next=FUZZ src/apps
RESULT ILLEGAL-n-r208-3 resolved 8f811d7d1665d627eec0fef981c4fc6dfa065572 next=DRY-n-r141-1-blocker-orch-main-r195 (blocker row, not a candidate)
tick 159 live=20 ceiling=20 floor=10 shortfall=0 done=2 launch orch-main-r237 hop=FUZZ src/apps launch orch-main-r238 hop=MILNER src/stage (unscanned; src/transport still holds r208-1) 1791677227
ILLEGAL-n-r208-1 | scripts/WebSocketTransport-witness.mjs | exit=0 | RESULT: PASS claims=19/19 | module=src/transport/WebSocketTransport.js | utc=2026-10-11T00:08:03Z | dispatch=1791677160202-500-47ca5a9633af9bf1 | session=orch-main-r217-w1 | corroborating: player-manager-send-failure-witness RESULT: PASS dispatch=1791676269603-500-1f41eef36fdc6264, real-ws live lifecycle run dispatch=1791676707710-500-a240bc2a38178e, idempotency dispatch=1791676852727-500-9dd6495c23257cb8, witness-audit --gate PASS dispatch=1791677036031-500-8f868edc6f102466 | source landed 8f811d7d (merged with ILLEGAL-n-r208-3)
tick 160 live=20 ceiling=20 floor=10 shortfall=0 open=1125 launchable=303 blocked held=2 candidates=PARSEDV-n-r199-2-1/2,ILLEGAL-n-r226-3/4,WADLER-n-r223-1/2,METAMORPH-n-r227-1/2 1791677367
- 2026-10-11T00:10:50.412Z | xr-widgets-single-owner-witness | exit 0 | RESULT: PASS 28/28 | dispatch 1791677373009-500-7f53abf6d4fed894 | session orch-main-r230 | KISS-n-r209-8
- 2026-10-11T00:10:50.412Z | xr-widgets-single-owner-witness (baseline pre-edit) | exit 1 | RESULT: FAIL 25/28 | dispatch 1791677264555-500-902071adf42bd990 | session orch-main-r230 | KISS-n-r209-8
tick 161 live=20 ceiling=20 floor=10 shortfall=0 open=1142 launchable=324 blocked held=2 r235 DBC packages/ecs logged 10 rows 1791677582
HOP packages/ecs DBC 13 violations witness=1791677418911-500-edf35f7dc2266c78 next=LAMPORT packages/ecs
tick 162 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r239 hop=LAMPORT packages/ecs 1791677598
- 2026-10-11T00:14:24.167Z | xr-widgets-single-owner-witness-verifier1 | exit 0 | RESULT: PASS 49/49 | dispatch 1791677614540-500-b3713aacbc1e11da | session orch-main-r230-sub1 | KISS-n-r209-8
tick 163 live=20 ceiling=20 floor=10 shortfall=0 open=1145 launchable=325 blocked held=2 (5th consecutive saturated blocked observation; churn row filed) 1791677715
RESULT ILLEGAL-n-r208-1 resolved 36fd41d2d17d67f3233e5707264f77873081c25a next=KISS-n-r209-3
HOP src/sdk PARSEDV 5 violations witness=1791677292093-500-8b4587705d1d1e88 next=ILLEGAL src/sdk
tick 164 live=20 ceiling=20 floor=10 shortfall=0 done=2 launch orch-main-r240 hop=ILLEGAL src/sdk launch orch-main-r241 row=transport-wrapper-base-ready-field-unread (src/transport free: r208-1/2/3/4 all closed) 1791677807
HOP src/stage MILNER 7 violations witness=1791677493853-500-9b67e6bc7d1f58d3 next=ILLEGAL src/stage
tick 165 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r242 hop=ILLEGAL src/stage 1791677896
RESULT KISS-n-r209-8 resolved ec115e6878361f565d556803aff9b7918d982237 next=KISS-n-r209-9
tick 166 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r243 hop=MILNER src/shared (unscanned; KISS-n-r209-9 deferred pending surface check) 1791677999
HOP client/hud YAGNI 2 violations witness=1791677719835-500-4f7ed982ea61ecb2 next=TARPIT client/hud
tick 167 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r244 hop=TARPIT client/hud 1791678083
HOP client/ui INVARIANTRUN 12 violations witness=1791673828440-500-f3196f6b960b642f next=METAMORPH client/ui (chain closed at depth 6: 33 node-only rows INVARIANTRUN/METAMORPH/FUZZ/PARSEDV/WADLER; client/ui edits BLOCKED-ON-EDIT by foreign uncommitted hunks in DevDashboard.js and NetworkInspector.js)
tick 168 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r245 hop=DBC client/workers 1791678179
HOP packages/ecs LAMPORT 9 violations witness=1791677953922-500-571bef7c8e39e680 next=INVARIANTRUN packages/ecs
tick 169 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r246 hop=INVARIANTRUN packages/ecs 1791678274
2026-10-11T00:25:29.727Z witness=scripts/WorkerTransport-witness.mjs module=C:/dev/spoint/src/transport/WorkerTransport.js exit=1 RESULT: FAIL (57 of 59 expectations hold) out=.gm/witness-out/WorkerTransport-witness-2026-10-11T00-25-29-727Z-6068.txt sha256=9e975cb32a4cc10880c088f0ec09c98af1b89b16470782f592501e86ae2347e8
2026-10-11T00:25:30.001Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
20261011T002541Z | scripts/WebSocketClientTransport-witness.mjs | exit=0 | RESULT: PASS -- 25 of 25 claims | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=global WebSocket (runtime-provided) | output=.gm/witness-out/WebSocketClientTransport-witness-20261011T002541Z-22756-e5cf28.txt | sha256=b28267fb1f023b15159f0ac3103ce8eecfacf840914aede717d5d6efde1ef890
tick 170 live=20 ceiling=20 floor=10 shortfall=0 open=1186 launchable=353 blocked held=2 candidates=PARSEDV-n-2-sub1-1/2,WADLER-n-r185h1s4-2
HOP client/editor HUGHES 5 violations witness=1791673200373-500-e9c4215508678c23 next=WADLER-n-r185h1s4-2 (chain closed: PBTAGENT/INVARIANTRUN/DBC/PARSEDV/WADLER 25 node-only rows)
tick 171 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r247 row=WADLER-n-r185h1s4-2 (client/editor free: r185 chain closed)
HOP src/shared MILNER 3 violations witness=1791678510377-500-6bd56eae67190690 next=PARSEDV src/shared
tick 172 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r248 hop=PARSEDV src/shared
HOP src/apps FUZZ 10 violations witness=1791677757444-500-fb0d9dbc126bd3b5 next=PARSEDV src/apps
tick 173 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r249 hop=PARSEDV src/apps
2026-10-11T00:32:09.472Z | NetworkSimTransport-witness | exit 0 | RESULT: PASS | module src/transport/NetworkSimTransport.js | claims 35/35 | out - | sha256 -
20261011T003220Z | scripts/WebSocketClientTransport-witness.mjs | exit=0 | RESULT: PASS -- 25 of 25 claims | module=C:\dev\spoint\src\transport\WebSocketClientTransport.js | websocket=global WebSocket (runtime-provided) | output=.gm/witness-out/WebSocketClientTransport-witness-20261011T003220Z-30048-05afc1.txt | sha256=14cd5b9e55a4bb3f42f4a4b24b14ae6ed779196f37664ef234401e18aebf1494
GM skills/gm-orchestrate/SKILL.md commit a047ccf19d pushed 89291cd00a74161eead17b01be77e822e97cd6d7 ci=unknown(no workflow runs for sha) author=lanmower -- rule: no timer re-dispatch of pool-observe while saturated
tick 174 live=20 ceiling=20 floor=10 shortfall=0 open=1186 launchable=353 blocked saturated -- observing on completion per new rule, not on timer
2026-10-11T00:32:25Z witness=gm:exec_js module=src/transport/TransportWrapper.js dispatch=1791678745397-500-de9eea0da41df89a session=orch-main-r241-verifier exit=0 RESULT: PASS (75 of 75 expectations hold) out=.gm/exec-spool/out/exec_js-orch-main-r241-verifier-20380-1791678727336-12051.txt sha256=dd6deba6a78db76c2c5cdfbc58d542d197ff0f19bb129cb9b3bdd83445528e7b
HOP client/hud TARPIT 2 violations witness=1791678581507-500-cff94a9e768328be next=ILLEGAL client/hud
tick 175 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r250 hop=ILLEGAL client/hud
HOP src/sdk ILLEGAL 8 violations witness=1791678602167-500-2fbccb50ad30b7da next=HUGHES src/sdk
tick 176 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r251 hop=HUGHES src/sdk
2026-10-11T00:36:10Z witness=gm:exec_js module=client/editor/EditHistory.js dispatch=1791678901995-500-ae59b55cc95bb7a2 session=orch-main-r247 exit=0 RESULT: PASS (29 of 29 expectations hold) out=.gm/exec-spool/out/exec_js-orch-main-r247-20380-1791678896107-12144.json sha256=51f942a88cd494f66054336aac602490bad10d7275e4ff6483ab25759b397c90
HOP packages/ecs INVARIANTRUN 2 violations witness=1791678808768-500-35b15ccda57f3334 next=METAMORPH packages/ecs (5 rows INVARIANTRUN-n-r246-1..5; world.js+query.js carry foreign uncommitted edits)
tick 177 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r252 hop=METAMORPH packages/ecs
HOP client/workers DBC 6 violations witness=1791678836535-500-153345334fc38434 next=LAMPORT client/workers
tick 178 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r253 hop=LAMPORT client/workers
VERIFY 158c437a32edf11485148d3e293d9c26aafc9522 ci-run=38099162637 check=pending frame-time=skipped(no gpu runner)
RESULT transport-wrapper-base-ready-field-unread resolved ae3457b582475311837ee20c890146681b89c633 next=DRY-n-r141-1-blocker-orch-main-r195 (blocker row, not a candidate)
RESULT WADLER-n-r185h1s4-2 resolved 2eeb58eb096cc2d5289323020773a378ee705eef next=WADLER-n-r185h1s4-1
VERIFY ae3457b582475311837ee20c890146681b89c633 author=lanmower subject=fix(transport): derive ready and isOpen from one lifecycle state
tick 179 live=20 ceiling=20 floor=10 shortfall=0 done=2 launch orch-main-r254 row=WADLER-n-r185h1s4-1 (client/editor free) launch orch-main-r255 row=webtransport-send-throw-leaves-open (src/transport free: r241 done)
HOP src/shared PARSEDV 1 violations witness=1791679019712-500-cdbe96244b29ffa7 next=ILLEGAL src/shared
tick 180 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r256 hop=ILLEGAL src/shared
VERIFY 158c437a32edf11485148d3e293d9c26aafc9522 ci-run=38099162637 check=success frame-time=skipped
2026-10-11T00:53:13.955Z witness=exec_js:webtransport-send-throw-parity session=orch-main-r255-sub1 exit=0 RESULT: PASS sha256=7366f13ac57a3a380264060633bf413257d0ac5db928d5d58a5689d929c40dc8
HOP packages/ecs METAMORPH 9 violations witness=1791679560005-500-a76838f7c223fec1 next=FUZZ packages/ecs (not spawned: gm-hop spawns its own successor; slot used for a fresh surface)
tick 181 live=20 ceiling=20 floor=10 shortfall=0 done=1 launch orch-main-r257 hop=ILLEGAL apps/world (unscanned, unheld)
WADLER-n-r185h1s4-1 | exec_js 1791679955547-500-9586eba9a2070e20 | exit 0 | RESULT: PASS -- A_dup names root-a and root-b (two distinct locations); B_dup reports one location and says so; C_dup unchanged root-a/root-b; find_cmp n100=0 n200=0 n400=0 (flat.find re-derivation gone); map_probe n100=100 n200=200 n400=400 ratio=4.00 linear=true; clean= byte-identical to pre-fix | 2026-10-11T00:55:17.859Z | dispatch 1791679955547-500-9586eba9a2070e20
2026-10-11T00:55:43.767Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=1 RESULT: FAIL (16 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-11T00-55-43-767Z-11884.txt sha256=d6f09e7b4b55a0649761d345c49c8465d893c7659feb69fb5c4312ab61e55019
2026-10-11T00:56:25.251Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=1 RESULT: FAIL (16 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-11T00-56-25-251Z-14428.txt sha256=d6f09e7b4b55a0649761d345c49c8465d893c7659feb69fb5c4312ab61e55019
CEILING spawn refusal confirms ceiling=20 at tick 181: hop METAMORPH packages/ecs self-spawned FUZZ packages/ecs and filled the slot before the orchestrator launch
RULE-CONFIRMED orchestrator spawns a hop successor only when the hop returns next: none
tick 182 live=20 ceiling=20 floor=10 shortfall=0 saturated (wait 60s; no pool-observe on timer per new rule)
HOP src/behaviours KISS 4 violations witness=1791677595599-500-728f1475e99fdfa7 closed src/behaviours/fire.js pass-through re-export removed; successor YAGNI self-spawned orch-main-r231-sub1 VIOLATED witness=1791679937128-500-89f7cb371224421a row YAGNI-1-sub1-3
RESULT webtransport-send-throw-leaves-open resolved 9640a070100f50ffe947eb51c6b0bad15f818921 next=ILLEGAL-n-r208-4
HOP src/spatial HUGHES back-verify closed 14 properties 2400/960 0 violations sha256 4f53cda1 row HUGHES-n-r228-1 pending
tick 183 live=20 ceiling=20 floor=10 shortfall=0 done=2 launch orch-main-r258 row=ILLEGAL-n-r208-4 launch orch-main-r259 hop=ILLEGAL apps/world
CORRECTION tick 183: orch-main-r259 launched as hop ILLEGAL src/protocol (unscanned dir from readdir sweep), not apps/world
UNSCANNED-SURFACES src: animation connection debug editor effects fluid game input pathfinding procgen protocol sharding static stdlib-apps storage | apps: 37 demo dirs + _lib | client: dev landing worlds vendor assets | packages: ecs mapspinner spoint-core streaming-gltf
2026-10-11T01:02:37.423Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=1 RESULT: FAIL (16 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-11T01-02-37-423Z-17704.txt sha256=d6f09e7b4b55a0649761d345c49c8465d893c7659feb69fb5c4312ab61e55019
tick 184 live=145 (ledger launches-done-cancel=200-177) ceiling=20 floor=10 shortfall=0 saturated; observing on completion per rule
CORRECTION tick 184: ledger-derived live=145 is INFLATED and unusable -- gm-hop agents self-spawn successors (ids like orch-main-rNNN-subK) that never get a ledger launch/done line, so launches-done counts chains that ended. Count of record = ListAgents (20 running) + .gm/pool/*.live. Filed gm row gm-pool-ledger-live-inflated-by-self-spawned-successors
tick 185 live=20 ceiling=20 floor=10 shortfall=0 saturated heartbeat_markers=17 stale_gt_600s=3
REAP 3 stale heartbeat markers >600s: orch-main-r188/214/230 (r214 task out age 5051s = dead chain) -- live markers 17 -> 14
tick 186 live=20 ceiling=20 floor=10 shortfall=0 launch orch-main-r260 hop=MILNER src/game launch orch-main-r261 hop=DBC src/pathfinding launch orch-main-r262 hop=ILLEGAL src/effects (all unscanned, unheld)
CEILING r262 refused at tick 186 after 3 stale markers reaped: harness count is 20 running, so the reaped markers did NOT free slots (their agents or their self-spawned successors still occupy them)
MEASUREMENT heartbeat marker staleness is not evidence a slot is free; the spawn refusal is the only live-count signal
2026-10-11T01:10:31.944Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=1 RESULT: FAIL (16 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-11T01-10-31-944Z-29860.txt sha256=5a1d7652091ea35c4a2e83746771871f8e288d0d4c029d3f82a26af40f387175
RESULT WADLER-n-r185h1s4-1 resolved 813c6720f435f769159d868fd6cbf0208807d7d9 next=none (client/editor chain complete)
GM skills/gm-orchestrate/SKILL.md commit 0f64f7ee5fcead8df04edb34372fbe9735785d68 pushed ci=pending run=38100919051 (skill-release release, doc-drift scan) author=lanmower -- rule: ledger live advisory, stale marker frees no slot
tick 187 live=20 ceiling=20 floor=10 shortfall=0 done=1 (r254)
MEASUREMENT tick 187: r254 completion did not free a slot -- the refill spawn was refused at 20. A completion frees a slot only when the finishing chain spawns no successor; at saturation the harness count, not the notification, decides.
tick 188 live=20 ceiling=20 floor=10 shortfall=0 saturated; waiting for a completion that actually frees a slot
2026-10-11T01:12:27.491Z witness=scripts/WebTransportTransport-witness.mjs module=C:/dev/spoint/src/transport/WebTransportTransport.js exit=0 RESULT: PASS (17 of 17 claims hold) out=.gm/witness-out/WebTransportTransport-witness-2026-10-11T01-12-27-491Z-7260.txt sha256=09a4adf82e0114a7ce3d7badcef2792d776d4c65d6f8bb185493becc6e6ba6ff
HOP src/apps PARSEDV 2 violations witness=1791680574843-500-4dcd5c6458dcb001; successor MILNER src/apps self-spawn BLOCKED by 20 limit, spec parked at .gm/pool/orch-main-r249.next
tick 189 live=20 ceiling=20 floor=10 shortfall=0 done=1 (r249) launch orch-main-r264 hop=MILNER src/apps (from parked .next spec)
MECHANISM parked .next spec + orchestrator relaunch recovers a successor blocked by the ceiling -- the pool stayed at 20 across the handoff
2026-10-11T02:59:06.343Z | scripts/BlendTree-witness.mjs | label=honest | exit=1 | RESULT: FAIL (checks=45 correct=43 characterized=1 failed=1) :: [characterized] Blender: updateBlend does not evaluate a stored blend tree (correct would be calls > 0) | module=src/animation/BlendTree.js | module_sha256=ecc37bfc68e2a958031f3362160f21fc9d986c6bcb3b5cc3b47e00e552e5c103 | out=.gm/witness-out/BlendTree-witness-honest-2026-10-11T02-59-06-343Z-5a98322c.txt | out_sha256=fd704dea07162068b96b446f525a76b263c02fc77d013d868ef977a56e927e22 | session=unknown | row=witness-gap-BlendTree
2026-10-11T03:04:27.868Z | scripts/BlendTree-witness.mjs | label=honest | exit=1 | RESULT: FAIL (checks=45 correct=42 characterized=1 failed=2) :: Blender: setBlendTree stores the tree and returns this | [characterized] Blender: updateBlend does not evaluate a stored blend tree (correct would be calls > 0) | module=src/animation/BlendTree.js | module_sha256=64f61a0066480479f3ad48a24e2cc543282aaa129786bec7fcba13b15a5eb465 | out=.gm/witness-out/BlendTree-witness-honest-2026-10-11T03-04-27-868Z-24b8b625.txt | out_sha256=0e625864a38012db8e30408516254d03444b67a1cb125d767c00eac3b9bde3fa | session=unknown | row=witness-gap-BlendTree
2026-10-11T03:05:34.592Z | scripts/BlendTree-witness.mjs | label=honest | exit=1 | RESULT: FAIL (checks=45 correct=42 characterized=1 failed=2) :: Blender: setBlendTree stores the tree and returns this | [characterized] Blender: updateBlend does not evaluate a stored blend tree (correct would be calls > 0) | module=src/animation/BlendTree.js | module_sha256=ab09de8bd76c1ddbea08b5b0b60667788ab4f1d9bd5d0324e4d4e82e35daaa6a | out=.gm/witness-out/BlendTree-witness-honest-2026-10-11T03-05-34-592Z-749397d8.txt | out_sha256=7aa0cae04147b83644661f0003271abd7d760c024108e06e1c675c95fb673bef | session=unknown | row=witness-gap-BlendTree
2026-10-11T03:14:02.699Z | gm git serial lane | PREDICT before dispatch: git_status into C:/dev/spoint while the git lane is held answers either ok with admission_waited_ms, or dispatch_starved_waiting_for_serial_lane carrying lane_position (integer >= 1, 1 = next) and lane_holder_age_ms (integer > 0); every row of C:/dev/spoint/.gm/exec-spool/.dispatch-wait.json carries the same two fields. | session=orch-main-r280 | row=gm-friction-git-serial-lane-fifo | predict_only=true

2026-10-11T03:17:53.465Z | WITNESS | DRY-n-r141-1 | delivery: 38fc8636a534575c8e858659dfaac04e4bbd0069 on AnEntrypoint/spoint main, AGENTS.md line 185 1+/1- (parent a39ec5b5), verified by fetch dispatch 1791688514782-500-4b1c88f5bc160cbd HTTP 200
tick live=21 event=refill-h22-h23parked-h24parked 2026-10-11T03:53:20.586Z
2026-10-11T04:01:30.686Z witness=scripts/game-fsm-witness.mjs exit=0 RESULT: PASS claims=35/35 module=src/behaviours/game-fsm.js sha256=- out=-
2026-10-11T04:04:34.862Z witness=scripts/game-fsm-witness.mjs exit=0 RESULT: PASS claims=35/35 module=src/behaviours/game-fsm.js sha256=- out=-
tick live=20 event=done-a66e9e8da0c6c2985-done-a1b6d27ed50891387-launch-ae0f05cabedd61bd7-bake-hf 2026-10-11T04:05:14.664Z
tick live=20 event=refill-bake-hf-h23parnas-h25minsky-r260dbc 2026-10-11T04:08:38.362Z
tick live=20 event=refill-h26parnas-apps-tps-game-h27totality-src-sharding push-starved-x2 2026-10-11T04:17:16.880Z
tick 3 event=done-3 live=22 2026-10-11T04:47:14Z
tick 4 event=launch-2 live=22 2026-10-11T04:47:14Z
2026-10-11T04:49:24.957Z | gm git serial lane | OBSERVED: agentplug c63097d222 (merged 02188c28446169dacf9478b18f07493f7751c74e) adds lane_admissible's network yield plus selfcheck-lane-network-yield; CI run 38111707190 job 114388478739 (build macos-14 aarch64-apple-darwin) printed "[selfcheck-lane-network-yield] a commit was admitted ahead of a fresh push, a push never overtook a commit ahead of it, and a push that waited out its yield budget stopped yielding and took the lane" then "witnessed live against the real GmFairnessGuard: PASS" then "RESULT: PASS"; all 8 jobs of run 38111707190 concluded success, publish included | dispatches bash 1791693322025-500-27edecdf292ca689 (whole selfcheck step log), bash 1791693417921-500-ad573f24b0485a66 (yield lines only), ci-status 1791693219424-500-531a17ef6868d905 (8/8 success) | captured_log_sha256=4269e23b5745553d6fe6422bffd6821d615c6f9ed2d5b3e186ad4d182ca5cd57 | caller rule prose landed as gm 649d389468b7004670e874301c980c772e707cbb (skills/gm-orchestrate/SKILL.md, d57a79d..649d389 on AnEntrypoint/gm main) | NOT observed in spoint: its daemon is the pre-fix local build (v0.1.272, 91ebbdff, release_build false), so C:/dev/spoint/.gm/exec-spool/.dispatch-wait.json at ts 1791693113358 still carries no lane_position/lane_holder_age_ms -- the fix is verified on the freshly built release binary in CI, not on this box's daemon | row=gm-friction-git-serial-lane-fifo | predict_only=false
tick 5 event=done-2 live=20 2026-10-11T04:59:27.924Z
tick 6 event=launch-3 live=23 2026-10-11T04:59:27.924Z
2026-10-11T05:06:15.067Z witness=scripts/game-fsm-witness.mjs exit=0 RESULT: PASS claims=35/35 module=src/behaviours/game-fsm.js sha256=- out=-
tick 7 event=done-1 live=22 2026-10-11T05:06:40.387Z
tick 8 event=launch-1 live=23 2026-10-11T05:06:40.387Z
note: r270-sub1 parked slice was stale (already closed by a5b54083d2e84a812); the relaunch was redirected onto its open rows
note: stale parked slices removed (already running or closed): orch-main-r310-sub2.next orch-main-r316-sub1.next orch-main-r275.next orch-main-h21.next orch-main-h23.next orch-main-r301-sub1.next
tick 190 event=done-1 live=24 2026-10-11T05:11:39.902Z
tick 191 event=launch-2 live=24 2026-10-11T05:11:39.902Z
note: PARSEDV src/netcode closed: 9feaf62d97 (tick integer gate, RollbackInputTransport.js:48), 4 rows PARSEDV-r315sub1-1..-4, 4 stale retired; successor TOTALITY src/netcode parked at .gm/pool/orch-main-r315-sub1.next
tick 192 event=done-2 live=24 2026-10-11T05:12:41.543Z
tick 193 event=launch-1 live=24 2026-10-11T05:12:41.543Z
note: DBC src/shared/clusterConfig closed: 59d6263a60 unpushed, rows DBC-ub1h1-1..-3, successor LAMPORT src/sharding/ClusterRuntime.js parked at .gm/pool/orch-main-r301-sub1-sub1-h1.next (src/sharding held by WADLER a72757906aef9d4bf)
note: MINSKY src/terrain closed: c6db604b34 unpushed (PlanetFrame.js), rows ILLEGAL-in-h25-1..-3; its successor chain (PARSEDV src/terrain -> WADLER depth 3) already ran and landed a438864021
tick 194 event=park-1 live=24 2026-10-11T05:13:30.741Z
note: PARSEDV src/game spawn refused by ceiling (20); parked at .gm/pool/orch-main-parsedv-game-w2.next as a ready slice for the first freed slot
tick 195 event=done-1 live=24 2026-10-11T05:14:23.271Z
note: PARSEDV src/behaviours closed: 4881662d16 (fireWeather.js) unpushed; gen-typings --check reports sdk-typings.generated.d.ts up to date (619 lines), so the CI gen-typings failure at 9feaf62d97 is cleared by the landed artifact
note: parked slices retired as already-closed work: removed orch-main-r249.next; removed orch-main-sub36.next; removed orch-main-r270-sub1.next
tick 194 event=done-15 live=19 2026-10-11T05:24:42.502Z
tick 195 event=launch-4 live=22 2026-10-11T05:27:19.727Z
note 195a docclaim-rs-plugkit-main-1 filed: rs-plugkit main CI red at HEAD cddd358 (2 failing runs), prior head 3f66830 green -- upstream consolidation slice, not C:/dev/gm
- 2026-10-11T05:28:52Z OBSERVED (claim-reap, r280): agentplug 2dc6f908ccbd9e1d9972f8c9419f38bc4451a3ac (commit a46cabddfb502775911ab47d27e22f852739b01a) CI run 38114871431 job 114397688062 -- selfcheck-claim-reap printed RESULT: PASS: "an untracked claim no live dispatch owns was reaped and stopped counting against the project's in-flight cap, while the same sweep left a claim the ledger names as running alone"; the sweep wrote dispatch_orphaned for git_commit/reap-task and left git_commit/owned-task alone. dispatch ids: git_commit 1791696386843-4-b20cf7859808e7b0, git_push 1791696490092-6-72ad7712594359b3, ci-status 1791696561247-7-b1673b8d7489f2b5, bash 1791696661560-11-828e02f90cfe8ef1, fs_read 1791696694508-500-1104e5ed6ea9e747
- 2026-10-11 PREDICT (claim-reap, r280, recorded before the push): the release workflow lane-selfcheck step builds the runner and runs the new selfcheck, which reaps the untracked claim (claim removed, out-file dispatch_orphaned written) and leaves the claim the ledger names as running, printing RESULT: PASS. MATCHED by the OBSERVED line above.
tick 196 event=done-2 live=17 2026-10-11T05:39:15.784Z
tick 197 event=done-4 live=17 2026-10-11T05:41:33.267Z
tick 198 event=launch-4 live=21 2026-10-11T05:41:33.267Z
tick 199 event=done-batch-13 live=15 20261011T055208Z
tick 200 event=launch-5 live=21 2026-10-11T06:05:40.828Z
tick 201 event=done-1 live=20 2026-10-11T06:14:10.105Z
tick 202 event=done-7 live=22 2026-10-11T06:17:35.767Z
tick 203 event=done-1 live=22 2026-10-11T06:20:47.065Z
tick 204 event=observe live=20 source=ListAgents ceiling=20 saturated=true 2026-10-11T06:21:12.740Z
tick 205 event=done-1 live=22 2026-10-11T06:22:45.113Z
tick 206 event=done-1 live=22 2026-10-11T06:25:13.733Z
PREDICT (lane FIFO place on retry, r280, recorded before the publish): agentplug 3c89ac67326ebc37fc6f73c7b27c5ce79aa40efa adds re_dispatch_keeps_lane_place:true to the dispatch_starved_waiting_for_serial_lane answer and spells out in its error text that a lane place is keyed on verb+body hash, never the task id, so a byte-identical re-dispatch keeps its FIFO position while resume_task can only re-read the stored answer; CI run 38117569926 builds the runner and concludes all 8 jobs success, publish included.
OBSERVED (lane FIFO place on retry, r280): agentplug 3c89ac67326ebc37fc6f73c7b27c5ce79aa40efa (commit 3c89ac67, build-fix c6e1bc98eea08771e5115b4bfa17908ece924a40 repairing the E0425/E0277/E0382 main break) merged and pushed as tip 2249822b11ec832d1dd28fd92266875ab50bdd65; CI run 38117569926 all 8 jobs success incl. publish. Live binary on this box is still the pre-fix build: C:/Users/user/.gm-tools/agentplug-runner.exe mtime 2026-10-11T02:12:56.177Z size 17069056 has_re_dispatch_keeps_lane_place=false has_lane_position=false, so the daemon uplift has not landed here yet and C:/dev/spoint cannot yet emit the new fields. Caller rule prose landed as gm 316273d76090c1f65fb7d7de88689be748e1e364 (skills/gm-orchestrate/SKILL.md) pushed as 6753250dadc86212c39927bb8008196f3c63ec43 author=lanmower. | dispatches: agentplug push 1791698772141-3-512d579c8725ff3d, build-fix commit 1791699263404-9-9f5ee38c7c3d9f1, push tip 2249822b 1791699455593-11-82b43a2e02ac0a67, ci-status 1791699657268-13-819e7c5000d7105b, binary baseline 1791699594991-500-1d18b23dc375d302, binary post-publish 1791699677193-500-a148e197bba66c78, binary recheck 1791700189094-500-aa26bcd41dd5ab17, skill commit 1791699758892-13-45d80cdf933ed847, skill push 1791699882201-14-81e4b29714b16a6f | row=gm-friction-git-serial-lane-fifo | session=orch-main-r280
tick 207 event=done-1 live=23 2026-10-11T06:33:59.888Z
tick 208 event=done-1 live=22 2026-10-11T06:35:03.599Z
tick 209 event=done-1 live=21 2026-10-11T06:39:13.134Z
2026-10-11T06:42:46.877Z witness=scripts/game-fsm-witness.mjs exit=1 RESULT: FAIL claims=18/35 module=src/behaviours/game-fsm.js sha256=- out=-
2026-10-11T06:43:31.381Z witness=scripts/game-fsm-witness.mjs exit=0 RESULT: PASS claims=35/35 module=src/behaviours/game-fsm.js sha256=- out=-
tick 210 event=done-1 live=19 2026-10-11T06:49:30.749Z
tick 211 event=done-2 live=18 2026-10-11T06:49:30.749Z
tick 212 event=launch-1 live=19 2026-10-11T06:49:30.749Z
tick 213 event=launch-2 live=20 2026-10-11T06:49:30.749Z
2026-10-11T06:52:21Z terrain-composeheight-wgsl label=wadler-before exit=0 RESULT: PASS -- 16 of 16 checks passed module_sha256=d656ed381807413a45cd226185403f300e33efe4a2c43958953af456b2ac8fb2 sha256=d89befeb81dcce9402c1bdb608554f0af603892ca58675706a4a5c9b7f81c02e out=.gm/witness-out/terrain-composeheight-wgsl-wadler-before-20261011T065221Z-3a4dfe16.txt module_sha256=d656ed381807413a45cd226185403f300e33efe4a2c43958953af456b2ac8fb2 session=orch-main-msp-dry1-wadler-wgpu row=witness-gap-terrain-composeheight-wgsl
tick 214 event=done-1 live=20 2026-10-11T06:54:54.087Z
tick 215 event=done-2 live=19 2026-10-11T06:54:54.087Z
tick 216 event=launch-1 live=20 2026-10-11T06:54:54.087Z
tick 217 event=launch-2 live=21 2026-10-11T06:54:54.087Z
tick 218 event=done-1 live=20 2026-10-11T06:55:50.742Z
tick 219 event=done-2 live=19 2026-10-11T06:55:50.742Z
tick 220 event=launch-1 live=20 2026-10-11T06:55:50.742Z
2026-10-11T06:56:01Z terrain-composeheight-wgsl label=wadler-after exit=0 RESULT: PASS -- 16 of 16 checks passed module_sha256=0e93e286c2117c3041e3412241a96241a7b238d146677fb3fa51881de3156b94 sha256=7415bd53ddf188f35b93b099e68e36a25945399074978252d63966a188b19127 out=.gm/witness-out/terrain-composeheight-wgsl-wadler-after-20261011T065601Z-b57b90dd.txt module_sha256=0e93e286c2117c3041e3412241a96241a7b238d146677fb3fa51881de3156b94 session=orch-main-msp-dry1-wadler-wgpu row=witness-gap-terrain-composeheight-wgsl
tick event=launch live=20 ceiling=20 rows=2 pending=353 2026-10-11T06:57:34Z
tick 221 event=done-1 live=19 2026-10-11T06:58:31.058Z
tick 222 event=done-2 live=18 2026-10-11T06:58:31.058Z
tick 223 event=launch-1 live=19 2026-10-11T06:58:31.058Z
tick 224 event=ceiling-1 live=20 2026-10-11T06:58:31.058Z
tick 225 event=done-118 live=24 2026-10-11T07:03:48.184Z
tick 226 event=done-119 live=24 2026-10-11T07:03:48.184Z
tick 227 event=launch-283 live=25 2026-10-11T07:03:48.184Z
tick 228 event=ceiling-2 live=25 2026-10-11T07:03:48.184Z
tick 229 event=launch-284 live=20 2026-10-11T07:04:51.930Z
tick event=launch live=18 ceiling=20 rows=2 pending=341 2026-10-11T07:05:27.430Z
2026-10-11T07:07:56.157Z | scripts/fire-duel-witness.mjs | exit=0 | RESULT: PASS claims=15/15 failed=0 | run=7aa9dec8-ad3b-4d1f-94f9-cb705cf155c7 | module=C:/dev/spoint/apps/fire-duel.js | module_sha256=5b0ea8fc5f9a0cb9c64b7640310912eceb72dfe7d83181dd43b61edaee208ca2 | witness_sha256=bde0854fb79f02de4d3c8b99562b034c66d9720fb4f7b999d7cc7be852a76dfc | out=-
tick 230 event=ci-green live=20 sha=39211f75 run=38119969333 check=success 2026-10-11T07:08:46.701Z
- DBC-red-w2-2 :: src/shared/relocation.js resolveTarget y+standNearY refusal :: exit=0 :: RESULT: PASS :: 2026-10-11T07:12:36Z :: dispatch 1791702555952-500-c53a382329316657
tick 231 event=done-120 live=19 2026-10-11T07:13:46.952Z
tick 232 event=launch-285 live=20 2026-10-11T07:13:46.953Z
tick 233 event=ci-green live=20 sha=010cd982 run=38120412846 check=success frame-time=skipped 20261011T071927Z
tick 234 event=gm-install-fix live=20 note=skill-assets-copied-to-claude-and-agents-installs-graph-resolves 20261011T071927Z
tick 235 event=launch-286 live=20 slice=PARSEDV-src-behaviours-fire-js depth=3 20261011T071927Z
tick 236 event=push live=20 sha=2fcde4bf range=ce00efbe..2fcde4bf count=3 authors=lanmower 20261011T072042Z
tick 237 event=ci-watch-start live=20 sha=2fcde4bf 20261011T072042Z
- DBC-red-w2-2 :: src/shared/relocation.js resolveTarget y+standNearY refusal :: exit=0 :: RESULT: PASS :: 2026-10-11T07:22:34.430Z :: dispatch 1791703334005-500-571d9127b0fddc94 :: .gm/witness-out/witness-1791703334005-500-571d9127b0fddc94.mjs
tick 238 event=done-illegal-src-game live=19 commit=a7999d9e0c witness=19of19 rows=ILLEGAL-legal-1,ILLEGAL-legal-2 20261011T072335Z
tick 239 event=ci-green live=20 sha=2fcde4bf run=38121014574 check=success(6m6s) frame-time=skipped
tick 240 event=push live=20 sha=7a979751 range=f167cc0f..7a979751 count=1 authors=lanmower
tick 241 event=done-illegal-client-xr live=18 commit=f167cc0f witness=4of4 rows=OWNERSHIP-n-r192-2-blocker-orch-main-r203,KISS-n-r209-6
2026-10-11T07:31:31.125Z | AbilityTree-witness | module=C:\dev\spoint\src\game\AbilityTree.js | out=C:\dev\spoint\.gm\witness-out\AbilityTree-witness-hughes-pre-w509.txt | exit=1 | RESULT: FAIL
2026-10-11T07:32:02.223Z | AbilityTree-witness | module=C:\dev\spoint\src\game\AbilityTree.js | out=C:\dev\spoint\.gm\witness-out\AbilityTree-witness-hughes-post-w509.txt | exit=0 | RESULT: PASS
ILLEGAL-h24-s2-4 | witness exec_js (live EventTarget bridge data listener: LockstepInputTransport + RollbackInputTransport + ConsensusVoter) | exit=0 | RESULT: PASS | 2026-10-11T07:35:36.677Z | dispatch=1791704067836-500-3b4a0ba7e1509d5e | session=orch-main-gm-w2-3-w1 | module=src/netcode/controlFrame.js | checks 17/17 | remote unknown-kind / malformed-payload / foreign-prefix counted per status in stats.rejects + stats.unknownKind, no uncaught in the data listener, stats.received untouched, later good frame still received=2, local encodeControlFrame + controlFrameHandlers still throw
tick 242 event=ci-green live=20 sha=7a979751 run=38121417199 check=success frame-time=skipped
tick 243 event=ceiling-confirmed live=20 note=20-refusal-on-gm-gitpush-fix-spawn-parked
tick event=park-launch-refused live=19 ceiling=20 rows=1 pending=341 2026-10-11T07:38:45Z
tick event=relaunch-parked live=20 ceiling=20 rows=1 pending=341 2026-10-11T07:39:25Z
tick event=hold live=20 ceiling=20 ci=unknown(76fa5dc5 not on remote) 2026-10-11T07:42:23Z
2026-10-11T07:47:18.224Z | scripts/ground-source-port-witness.mjs | exit=0 | RESULT: PASS checks=18 failed=0 | run=honest | out=.gm/witness-out/witness-gap-GroundSourcePort-honest-20261011T074718224Z.txt | out_sha256=5e58fab34a42c51da6b61937e8b9a0d0a506ea11500148b30d74bfebf478c621
ci sha=2820618bdafbefdfa9008be09c5d7e9e018bb813 status=success check=success frame-time=skipped(no-gpu-runner) run=38122278039 2026-10-11T07:51:08Z
tick event=hold live=20 ceiling=20 ci-green=2820618b 2026-10-11T07:51:08Z
tick 244 event=gm-merge live=20 sha=f2d09e87 repo=gm check=scan+release success 2026-10-11T07:51:38Z
tick 245 event=push live=20 sha=60fb8125 range=2820618b..60fb8125 count=2 authors=lanmower recovered=remote_moved 2026-10-11T07:51:38Z
tick 246 event=done-hops live=20 receipts=PARSEDV-fire.js, HUGHES-AbilityTree, DEEPMOD-src/terrain, DRY-AppPhysics, TOTALITY-client/core, DRY-mapspinner 2026-10-11T07:51:38Z
tick 247 event=park live=20 parked=orch-main-ms-milner (ceiling refusal) relaunched=ILLEGAL-fireSpec, PBTAGENT-AbilityTree, YAGNI-AppPhysics 2026-10-11T07:51:38Z
1791704403082-500-66eb1faad71908a2 exit=0 RESULT: PASS  .gm/witness-out/wadler-shared-w4.mjs --expect=c46266fc66b01fa0348513b742671e8da5b28ab247ca3589963ba59682a7acf1  (WADLER-red-w4-1, session orch-main-gm-w2-2-w, 2026-10-11) -- bake-minimap takes the parsed record straight through; digest unchanged, real-world bake of 'index' byte-identical to HEAD
tick 248 event=bake live=20 world=tps-game recheck=clean 2026-10-11T07:56:18.374Z
tick event=stage-refill live=20 ceiling=20 staged=DBC-red-w2-1 2026-10-11T07:56:19Z
tick 249 event=push live=21 sha=9007d203 range=60fb8125..9007d203 count=14 authors=lanmower 2026-10-11T07:59:49.407Z
2026-10-11T07:59:38Z DBC-red-w2-3 witness=.gm/witness-out/DBC-red-w2-3-dirToLocalXZ-heightAt.mjs exit=0 RESULT: PASS checks=18 failed=0 dispatch=1791705578368-500-d3d106948c2cedc4 session=orch-main-gm-w2-5-wit commit=fe0006f474
2026-10-11T08:02:56.533Z | scripts/ground-source-port-witness.mjs | exit=0 | RESULT: PASS checks=18 failed=0 | run=char-est-s1-4-pre | out=.gm/witness-out/witness-gap-GroundSourcePort-char-est-s1-4-pre-20261011T080256533Z.txt | out_sha256=733cafa686203b2bc50408def21c9fa1cdbf3c507f47993a5080362b303873a8
2026-10-11T08:02:59.689Z | scripts/client-core-exact-patch-frame-witness.mjs | exit=0 | RESULT: PASS checks=15 failed=0 | run=char-est-s1-4-pre | module=C:\dev\spoint\client\core\ExactPatchFrame.js | module_sha256=3c07d4ecc4a71c1167d12ae1a3f68977a3ceb56b35dcad7248cc6998801128b0 | out=.gm/witness-out/witness-gap-ClientCoreExactPatchFrame-char-est-s1-4-pre-20261011T080259689Z.txt | out_sha256=7d2f4178803b3c6e7a3b637802d015f0652893a7dbf563b02e715006c1c12d23
2026-10-11T08:05:11.901Z | scripts/ground-source-port-witness.mjs | exit=0 | RESULT: PASS checks=19 failed=0 | run=char-est-s1-4-post | out=.gm/witness-out/witness-gap-GroundSourcePort-char-est-s1-4-post-20261011T080511901Z.txt | out_sha256=57a81f72507cc8b95345af75dc0c747e0f4da71172ea9d3e1074281b1de6b2b7
2026-10-11T08:05:14.833Z | scripts/client-core-exact-patch-frame-witness.mjs | exit=0 | RESULT: PASS checks=15 failed=0 | run=char-est-s1-4-post | module=C:\dev\spoint\client\core\ExactPatchFrame.js | module_sha256=42cde2af09b67c8b38c91d90d7dcb85e7aa00f60bced46aba6a1f0f53a18673a | out=.gm/witness-out/witness-gap-ClientCoreExactPatchFrame-char-est-s1-4-post-20261011T080514833Z.txt | out_sha256=024a05b9249615b942ee1042dcbb94740f12a0caa7b784efffbbec4aefa0738e
rows-filed WADLER-red-w4-1-follow-minimapbake minimap-bake-cwd-module-resolve 2026-10-11T08:05:33Z
WADLER-octree-mutations-contract-m2-s1 | exec_js 1791706037970-500-500c8d9381b48e73 | exit 0 | RESULT: {"radiusDefault":200,"m0":2,"g0":0,"wide":[1,2],"m1":3,"g1":1,"narrow":[1],"m2":4,"g2":1,"m3":4,"g3":1,"checks":{"totalWitness":true,"attributable":true,"geometryChangedResult":true,"populationOnly":true,"idempotentReseat":true,"epochSplit":true},"pass":true} | 2026-10-11T08:09:55.928Z
tick 250 event=launch-19 live=7 2026-10-11T08:10:14.142Z
tick 251 event=launch-20 live=7 2026-10-11T08:10:14.142Z
ClientHudMinimapHUD-refusal (exec_js live run of client/hud/MinimapHUD.js over the tps-game terrain) exit 0 RESULT: PASS 2026-10-11T08:11:01Z dispatch 1791706198540-500-fc400083fa595e6a
ClientHudMinimapHUD-seed-parse (exec_js live run of client/hud/MinimapHUD.js over the tps-game terrain) exit 0 RESULT: PASS 2026-10-11T08:11:01Z dispatch 1791706213885-500-b531b01c882e547
prediction-wedge-witness.mjs exit 0 RESULT: PASS (local worktree, dispatch 1791706812082-500-97f75bb6ddf8cfdf, 2026-10-11T08:20:12Z) -- kinematic-headon serverPathM 55.1958 predPathM 57.8931 samplesAtWall 201 heldMaxPenetrationM 0; static-headon 55.1958; slide-25 17.9289; slide-75 19.3609
ci e851e557 check job FAIL (run 38123922186) -- prediction-wedge-witness.mjs exit 1 RESULT: FAIL with serverPath 0 m and NaN for every arm, unreproduced locally; cause handed to the two bisect lanes

2026-10-11T08:22:59Z WADLER-aoi-positionofentity-m2-s1 scripts/aoi-delivered-sphere-witness.mjs exit=0 "RESULT: PASS (10 of 10 claims)" dispatch=1791706456219-500-23d716b8e53afad6 module_sha256=17dc71a1e11af8a078228ffdef6a9b46d825860d3d8f9ab8336aa4b3e22e218c
2026-10-11T08:22:25Z docclaim-rs-plugkit-main-1 .gm/witness-out/rs-plugkit-main-ci-green.mjs exit=0 "RESULT: PASS" dispatch=1791706945466-500-f68c2d28ca6d107a session=orch-main-r275-w1 output_sha256=afd134d36d3fac23b12d12bc3f5b718b8512180dcbf23aea364488e7ed1b7f84
tick 2026-10-11T08:24:00Z event=launch-WADLER-red-w4-1-follow-minimapbake live=19 ceiling=20 wedge-ci-bisect=2lanes
DBC-red-w2-1 .gm/witness-out/DBC-red-w2-1-equipment-contract.mjs exit=0 RESULT: PASS 2026-10-11T08:27:42.199Z dispatch=1791706765818-500-6b43695c7c715ebd
ci 82a8658f check job FAIL (run 38125192671) -- check died before any witness ran: [gen-sdk-typings] STALE, committed addForce (f: any) => void vs generated (f: any) => any; fixed by 34941040, so this red is a stale generated artifact, not the wedge regression
wedge reconciliation 2026-10-11T08:45Z -- lane a55927b47e760bf7d blames 347b4ad8 (BaseClient passed the {data,cases} wrapper to predEngine.addInput and _plainInputs); lane af9877c3a2eb2eaf6 witnessed a clean detached worktree at 3df86b9e exit 0 RESULT: PASS (dispatch 1791707525436-500-d5e7db69c1ba4889). Both hold: the repair is committed between e851e557 and 3df86b9e, and the e851e557 CI red predates it -- no fix commit is owed, the row closes on the first green check that reaches the witnesses
2026-10-11T08:41:34.882Z | scripts/minimap-bake-witness.mjs | exit 0 | RESULT: PASS -- 34 of 34 claims of MinimapBake (module sha256_16=4ad11e2bcf90fe1f, code version 3240e15a3689) | dispatch 1791707873654-500-f16ab882901f0e3e | row WADLER-red-w4-1-follow-minimapbake
2026-10-11T09:00:59.266Z | scripts/ground-source-port-witness.mjs | exit=0 | RESULT: PASS checks=19 failed=0 | run=honest | out=.gm/witness-out/witness-gap-GroundSourcePort-honest-20261011T090059266Z.txt | out_sha256=7e34ff1c8b091fa76081c0b8f58b083e2cbc114e72b9de4fc265169f6ebc34c0
tick orch-main-r259 2026-10-11T09:13:49Z live=19 ceiling=20 rows_open=6 hops_running=18
launch orch-main-r259-cs1 2026-10-11T09:13:49Z relaunch parked orch-main-cs-il1.next ILLEGAL src/protocol/ComponentSchema.js
launch orch-main-r259-spt1 2026-10-11T09:13:49Z relaunch parked orch-main-spt-i1.next PARNAS src/apps
launch orch-main-r259-rl1 2026-10-11T09:13:49Z relaunch one parked .next spec on an unheld surface
prd-add ORCH-agents-md-compaction-r259 2026-10-11T09:13:49Z AGENTS.md 29532B, 1188B under the 30kb INVARIANT 3 trigger
event 2026-10-11T09:13:49Z tip 7816296d published (2 lanmower commits) and CI run 38126707626 check=completed success frame-time=skipped
launch orch-main-r259-cam1 2026-10-11T09:18:01Z row PARSEDV-s1-s1-1 client/core/camera.js retained-height parse boundary
prd-add gm-codeinsight-impact-rejects-path-scope 2026-10-11T09:18:01Z witness dispatch 1791709083677, surface c:/dev/gm
done aa909c16cbec2e293 2026-10-11T09:18:01Z row ILLEGAL-llegal-7 closed, sha 59f1ddc9 pushed, CI run 38127350176 check=success frame-time=skipped
FAILURE 2026-10-11T09:23:05Z main RED: CI run 38127766386 at origin/main 8a559b2c3f check=completed failure, frame-time=skipped
event 2026-10-11T09:23:05Z red cause witnessed: [check-cache-keys] SNAPSHOT_ENTITY_ENC_CODE_VERSION pins 421295f4bc8e, producing source hashes to 9a91fbc543ee
launch orch-main-r259-bp1 2026-10-11T09:23:05Z row ORCH-bake-pin-crosslane-race-r259: recompute the pin in a throwaway worktree at the publish tip, bump, push, confirm check=success
event 2026-10-11T09:23:05Z local HEAD c3f9cee244 is unpushed (gh compare vs main 404s); origin/main 8a559b2c
tick 1791712 2026-10-11T09:36:38.378Z live=18 ceiling=20 event=hop-done add04b5c12077a0c1 HOARE packages/mapspinner/src/webgpu VERDICT=VIOLATED rows=4 sha=85bd426829 next=PARSEDV depth=5
tick 1791712 2026-10-11T09:36:38.379Z event=ci 38128865486 396e0946 completed failure [check-cache-keys] 2 stale-bake: COLLISION_GRID 3e24b726a9a7->df8bf8c5654e, SNAPSHOT_ENTITY_ENC 421295f4bc8e->9a91fbc543ee
tick 1791712 2026-10-11T09:36:38.379Z event=ci 38128911554 aeee0327 in_progress
tick 1791712 2026-10-11T09:36:38.379Z event=relay coordinator pin instruction -> a7b9655c30200dbab (ComponentSchema+pin one commit, no push); two-pin CI values -> a8fa767b15169f83c
tick 1791712 2026-10-11T09:52:06.219Z event=pin-red-cleared 466dd83f published via Git API by m23 (ac94c54828ef742cd); check reports all 8 bake transforms match; values SNAPSHOT_ENTITY_ENC 1aa78fb4e515 COLLISION_GRID df8bf8c5654e
tick 1791712 2026-10-11T09:52:06.219Z event=ci 38129471834 466dd83f completed failure: generated SDK typings drift src/apps/AppContext.js 0706f9f51207 committed vs a17bb18e273f (only remaining failure)
tick 1791712 2026-10-11T09:52:06.219Z event=local 814050c4 + 203289c0 duplicate pins-only commits unpushed; push held until typings regeneration lands
tick 1791712 2026-10-11T09:52:06.219Z event=row ORCH-bakepin-hash-committed-blobs-r259 filed (check-cache-keys hashes work tree, CI hashes commit)
tick 1791712 2026-10-11T09:52:06.219Z event=done ae17237050599a6e8 MILNER-1-sub1-3 sha 6abdb41f001c513c2a90a89981d938cf5d677511 published; done ac94c54828ef742cd MILNER-s2-m1-3 resolved cc986e19 + 466dd83f; done a8fa767b15169f83c blocked no-commit (lane starved + writer collision); done add04b5c12077a0c1 HOARE mapspinner/webgpu VIOLATED 4 rows sha 85bd426829
CI 38129471834 @466dd83f: check FAILURE, sole cause [gen-sdk-typings] STALE (digest 0706f9f51207 committed vs a17bb18e273f generated; 632 vs 632 lines, only the digest line differs); all 8 bake transforms "declare their whole import closure" and SNAPSHOT_ENTITY_ENC=1aa78fb4e515 / COLLISION_GRID=df8bf8c5654e / SNAPSHOT_ENCODE=07b97a0e8caf all "match their producing source" -- pin red CLEARED. frame-time: skipped (no self-hosted gpu runner), never success.
DONE PARSEDV-arsedv-6 (aafed0d9eb1b8dfc4) ade929f8973f36fc4c4bbe99862255577cc37efe: 53 STALE CITATION retired in FOLD_CORRECTED, 49 REAL DRIFT symbols restored into AGENTS.md; verifier dispatch 1791711084428-500-ae71c037a315d697 RESULT: PASS fold findings 0. Constraint it handed down: verify-doc-claims.mjs matches every BACKTICKED token of git show 55cd0199:AGENTS.md against AGENTS.md+docs/measurement-figures.md, so those symbol names are freeze-dried for the compaction.
DONE PARSEDV-arsedv-5 (a7d98b6fa96942bf7) 8a559b2c3fe407a4c4cbadd3a51e75d29f3f06aa: StageConfigError now carries cause + reasonCode, 3 witnesses branch on reasonCode instead of prose; planet-cube-sphere 93/93 PASS.
LAUNCH orch-main-r259-comp (ab6c02595aa2d0f08) row ORCH-agents-md-compaction-r259: AGENTS.md measured 31819 bytes (over30kb) so INVARIANT 3 fired; briefed to keep JULES STOPGAP block + @includes byte-identical, keep every backticked symbol token, run verify-doc-claims.mjs before commit, delete consumed memories, commit path-scoped lanmower-only, do NOT push.
NOTE correction accepted: CI check job does NOT run verify-doc-claims.mjs (zero hits in job log), so the doc-claims verifier is a local-only gate; the typings drift is peer aa10875d09bf1c977 surface, not the doc-claims lane.
hop PARSEDV src/terrain done sha=050e7ae76c witness=1791712522074-500-800709fbfa48ef1b row WADLER-13-s1-3 reopened rerun_pass 2026-10-11T10:00:49Z
bake-pin hazard: SNAPSHOT_ENTITY_ENC pins 1aa78fb4e515, work tree hashes 9f3cb264710e; only dirty closure member is src/protocol/ComponentSchema.js; routed to a7b9655c30200dbab and coordinator 2026-10-11T10:03:20Z
2026-10-11T10:07:37.018Z witness=scripts/game-fsm-witness.mjs exit=0 RESULT: PASS claims=35/35 module=src/behaviours/game-fsm.js sha256=- out=-
GM FRICTION: a read-only wait dispatch (task orch-main-r259-20380-1791713243788-26669, claim_age 60475 ms) came back dispatch_orphaned -- claimed by a daemon that stopped answering, reaped by orphan sweep pid 36180. Under runner 0.1.294 (handoff landed this session) that is the second daemon-death class seen; lane af885c2b29bddc0a9 is measuring agentplug CPU/IO churn on the same box. A version handoff is documented NOT to be a cause (it re-queues claims), so a reaped READ-ONLY claim at 60 s points at the daemon dying, not at a handoff.
2026-10-11T10:09:33.719Z witness=scripts/game-fsm-witness.mjs exit=0 RESULT: PASS claims=35/35 module=src/behaviours/game-fsm.js sha256=- out=-
tick 1 event=wave-1-launch live=10 floor=10 2026-10-11T18:39:05.400Z
tick 2 event=done-w1-1,w1-3,w1-9 refill=w1-11,w1-12,w1-13 live=10 floor=10 2026-10-11T18:41:29.580Z
tick 3 event=done-w1-13(NA,principle LISKOV absent) refill=w1-14 live=11 floor=10 2026-10-11T18:43:58.396Z
tick 4 event=done-w1-2(HOLDS,1 row) refill=w1-15 live=10 floor=10 2026-10-11T18:44:17.762Z
tick 5 event=done-w1-11(HOLDS; succ w1-11-s5 HOLDS) refill= live=10 floor=10 2026-10-11T18:46:37.053Z
tick 6 event=completions(w1-12,w1-4-chain,w1-7-chain,w1-6-chain) live=6 floor=10 2026-10-11T18:48:47.830Z ids=orch-main-w1-10,orch-main-w1-15d2,orch-main-w1-7-d5,orch-main-w1-8-d3,orch-main-w2-14,orch-main-w1-15d3
tick 7 event=refill-to-floor refill=w1-17,w1-18,w1-19,w1-20 live=10 floor=10 2026-10-11T18:48:58.335Z
tick 8 event=completions(w1-14,w1-15,w1-8-chain) live=8 floor=10 2026-10-11T18:51:16.719Z ids=orch-main-w1-10,orch-main-w1-7-d5,orch-main-w1-8-d4,orch-main-w1-17,orch-main-w1-18,orch-main-w1-19,orch-main-w1-20,orch-main-w3-14
FAILURE: 2026-10-11T18:51:26.350Z live=8 floor=10 pending=open-parked-slices cause=refill-lag (w1-14, w1-15 and the w1-8 chain completed; refill not issued in the same turn)
tick 9 event=refill refill=w1-21,w1-22 live=10 floor=10 2026-10-11T18:51:26.350Z
tick 10 event=poll live=10 floor=10 2026-10-11T18:53:40.748Z ids=orch-main-w1-21,orch-main-w1-22,orch-main-w1-18-g1,orch-main-w1-10-d2,orch-main-w2-20,orch-main-w3-14-d4,orch-main-w1-17-p5,orch-main-w1-21-d6,orch-main-w1-18-g1-slap,orch-main-w1-8-d6
tick 11 event=completions(w1-21 chain,w1-22,w1-18-g1,w1-10-d2,w1-17-p5,w1-20,w1-21-d6,w1-8-d6) before=4 refill=orch-main-w1-23,orch-main-w1-24,orch-main-w1-25,orch-main-w1-26 live=8 floor=10 2026-10-11T18:55:51.576Z
FAILURE: 2026-10-11T18:56:00.612Z live=7 floor=10 pending=0-open-slices-in-parked-list cause=no-slice (parked list exhausted after 4 refills; 2 fresh hops added)
tick 12 event=refill refill=w1-27,w1-28 live=9 floor=10 2026-10-11T18:56:00.612Z
tick 13 event=refill refill=w1-29 live=10 floor=10 2026-10-11T18:56:07.285Z ids=orch-main-w3-14-d4,orch-main-w3-20,orch-main-w1-17-p6,orch-main-w1-23,orch-main-w1-24,orch-main-w1-25,orch-main-w1-26,orch-main-w1-27,orch-main-w1-28,orch-main-w1-29
tick 14 event=completions(w1-26,w1-25,w1-24?) live=7 floor=10 2026-10-11T18:58:31.233Z ids=orch-main-w1-28,orch-main-w1-23-d2,orch-main-w3-14-d5,orch-main-w2-28,orch-main-w2-29,orch-main-w4-21,orch-main-w1-24-d2
tick 15 event=refill refill=w1-30,w1-31,w1-32 live=10 floor=10 2026-10-11T18:58:38.259Z
tick 16 event=poll live=10 floor=10 2026-10-11T19:01:02.893Z ids=orch-main-w1-23-d2,orch-main-w2-29,orch-main-w4-21,orch-main-w1-30,orch-main-w1-31,orch-main-w1-32,orch-main-w3-14-d6,orch-main-w1-23-d3,orch-main-w1-24-d4,orch-main-w3-28
note 2026-10-11T19:03:18.601Z tick 14 live=7 was below floor and not logged as FAILURE when observed (orchestrator miss); refilled in tick 15
collision 2026-10-11T19:03:18.601Z orch-main-w2-29.live was rewritten to surface src/apps by a foreign writer while w1-28 (src/apps) was live; the w2-29 hop deleted that file as step 1
tick 17 event=poll live=11 floor=10 2026-10-11T19:03:18.601Z ids=orch-main-w1-23-d2,orch-main-w1-31,orch-main-w3-14-d6,orch-main-w1-24-d4,orch-main-w4-22,orch-main-w2-33,orch-main-w1-30-d2,orch-main-w3-29,orch-main-w1-23-d4,orch-main-w4-23,orch-main-w2-30
tick 18 event=poll live=6 floor=10 2026-10-11T19:06:14.810Z
FAILURE: 2026-10-11T19:06:27.055Z live=6 floor=10 pending=open cause=refill-lag (no refill issued after tick 17 completions)
tick 19 event=refill refill=orch-main-w1-33,orch-main-w1-34,orch-main-w1-35,orch-main-w1-36 live=10 floor=10 2026-10-11T19:06:27.055Z
tick 20 event=completion(w1-35) live=6 floor=10 2026-10-11T19:11:37.190Z
- .gm/witness-out/ColliderStreamer-spec-admission-wadler.mjs exit=0, RESULT: PASS (22/22 checks, 0 failing), 2026-10-12T05:30:47.183Z, dispatch 1791783047183-500-ba4c9f75156ec8d6, row DBC-13-s1-2, session orch-main-r270-1
- 2026-10-12T05:33:56.000Z UTC | witness-awaitstopped-query-purity | exit 0 | RESULT: PASS | dispatch 1791783236001-500-472793242637fafb | row CQS-w5c-awaitstopped-query-registers-waiter | client/core/WorkerRenderer.js awaitStopped adds 0 timers, 0 posts, returns not-stopping / the command-owned stop settlement
- apps/combat-bot/index.js weapon-range single-owner (exec_js inline, out-of-repo scratch) exit 0 RESULT: PASS 2026-10-12T05:37:05Z dispatch 1791783363016-500-baa65b3414a312d5 (baseline drift run 1791783304559-500-e204172acf6658e)
2026-10-12T05:40:11.203Z | scripts/ground-source-port-witness.mjs | exit=0 | RESULT: PASS checks=19 failed=0 | run=honest | out=.gm/witness-out/witness-gap-GroundSourcePort-honest-20261012T054011203Z.txt | out_sha256=11f0e51b21a4f0b7c67f0b4903900add95364c6ebe785ec79c16bd7f5f26862a
scripts/netcode-profile-witness.mjs (node, exec_js 1791783288214-500-a6a58075e93c6b90) exit 0 RESULT: PASS -- 31 of 31 check(s) held over src/netcode/NetcodeProfile.js | netcode non-object netcode now rejected at the netcode path | 2026-10-12T05:40:25.117Z
- 2026-10-12T05:40:35Z lag-compensator-witness.mjs exit 0 RESULT: PASS (checks 102/102) dispatch 1791783368165-500-76df720c277b541c session orch-main-r270-5-witness row DBC-w5i-view-tick-no-contract-on-latest
- ILLEGAL-w5p-terrain-boolean-admitted-unparseable | witness=scripts/terrain-boolean-admitted-witness.mjs | exit=0 | RESULT: PASS (12 candidates: admitted=7 refused=5; terrain:true now refused at the boundary with path "terrain", code "world-field-invalid"; assertWorld throws WorldResolveError) | 2026-10-12T05:40:36.172Z | dispatch=1791783394341-500-80f175047266c | session=orch-main-r270-9-w1 | module=src/shared/worldResolve.js
2026-10-12T05:42:07.646Z | scripts/netcode-profile-witness.mjs | exit=0 | RESULT: PASS -- 32 of 32 check(s) held over src/netcode/NetcodeProfile.js | dispatch 1791783696309-500-1b50aa2f52aa4510 | row ILLEGAL-w5p-netcode-non-object-resolves-authoritative | session orch-main-r270-10 | witnessLog=yes
- 2026-10-12T05:43:23.687Z | DBC-w5e-buildlive-duplicate-ids | exec_js 1791783747015-500-c90f12348bb6be92,1791783757429-500-67b041b4109bfee6,<this> | exit 0 | RESULT: PASS W1..W6 | session orch-main-r270-16-w1
- 2026-10-12T05:43:23.687Z | DBC-w5e-buildlive-duplicate-ids | exec_js 1791783808644-500-7f844eb50bbf6879 (W1-W6, session orch-main-r270-16-w1; supporting 1791783747015-500-c90f12348bb6be92, 1791783757429-500-67b041b4109bfee6) | exit 0 | RESULT: PASS W1..W6 6/6 | session orch-main-r270-16-w1
2026-10-12T05:45:26.735Z | scripts/ground-source-port-witness.mjs | exit=0 | RESULT: PASS checks=19 failed=0 | run=honest | out=.gm/witness-out/witness-gap-GroundSourcePort-honest-20261012T054526735Z.txt | out_sha256=039681c55999114df4875d36d4c72243bd4de7321175218c867d4e186be558c8
MILNER-w5f-input-depth-parse-unnamed-throw-on-bigint-symbol | witness exec_js (live import src/shared/inputDepthWire.js + src/netcode/SnapshotEncoder.js decodeSelfBlock/encodeSelfBlock) exit=0 | RESULT: PASS thrown=0 badBytes=0 fails=0 consumer 5n->-1 3->3 null->-1 roundTrip=7 roundTripBigInt=-1 | 2026-10-12T05:47:31.358Z | dispatch 1791783753238-500-fbe8222d006c1c34
2026-10-12T05:51:59.283Z | DBC-w5i-linear-hit-no-nearest-postcondition | exec_js (live import src/netcode/Hitscan.js: findHitLinear vs findHitSpatial) | exit=0 | RESULT: PASS 20/20 expectation(s), 2076 permutation shot(s) over 30 random 3-to-5 player scene(s), 0 mismatch(es), linearVarying=0 spatialVarying=0; the same scenes gave 1648 mismatch(es) and linearVarying=30/30 before the change | dispatch 1791784245894-500-1a4b0534523ee4cd | session orch-main-r270-4-w1 | module=src/netcode/Hitscan.js | commit 3913295e5bb530ce0ff8f74a90490ade069508a9 | expectation recorded before the run in .gm/witness-out/hitscan-linear-nearest-witness.mjs EXPECT
- scripts/surface-solve-tolerance-witness.mjs exit=0 RESULT: PASS (12 passed / 0 failed) 2026-10-12T05:38:26.168Z dispatch 1791783506168-500-b03f3ef31d35afa2 (row MILNER-w5d-tolerance-param-untyped-infinity-accepted)
2026-10-12T05:53:52Z | witness=scripts/SnapshotProcessor-witness.mjs | run=orch-main-r270-8-final | target=src/client/SnapshotProcessor.js | module_sha256_16=cefc71d07515f543 | exit=0 | RESULT: PASS -- 39 claim(s) of SnapshotProcessor hold, module sha256_16=cefc71d07515f543 | out=none | sha256=n/a | row=UBIQ-w5e-reduced-tier-position-y | session=orch-main-r270-8
2026-10-12T05:54:00.082Z | DBC-w5i-linear-hit-no-nearest-postcondition | exec_js (live import src/netcode/Hitscan.js: findHitLinear vs findHitSpatial), run by an independent witness session, no repo edit | exit=0 | RESULT: PASS 20/20 expectation(s), 2076 permutation shot(s) over 30 random 3-to-5 player scene(s), 0 mismatch(es), linearVarying=0 spatialVarying=0 | dispatch 1791784361322-500-10aa6b42d0e3be05 | session orch-main-r270-4-w1 (subagent, distinct from the editing session orch-main-r270-4) | module=src/netcode/Hitscan.js | commit 3913295e5bb530ce0ff8f74a90490ade069508a9 | witnessLog=yes
launched 20 at 2026-10-16T14:25:38Z
- csproto-6 | src/protocol/msgpack.js asymmetric useFloat32 round-trip | exit 0 | RESULT: PASS | 2026-10-16T14:28:18Z | dispatch 1792160887681-191-1594fbe8a41b869e | output .gm/receipts/csproto-6/witness-output.txt
2026-10-16T14:28:47.781Z | scripts/ground-source-port-witness.mjs | exit=0 | RESULT: PASS checks=19 failed=0 | run=honest | out=.gm/witness-out/witness-gap-GroundSourcePort-honest-20261016T142847781Z.txt | out_sha256=9a35cd1c70856e03f66915b36463d46cf57fc3202bf73dc0d4e9aaf918be67ef
- 2026-10-17T09:33:29Z ILLEGAL-r250-3 session gmfin-s1-15: node scripts/ClientHudMinimapPlacements-witness.mjs checks 30 failures 0 RESULT: PASS exit 0 (local run, no gm dispatch id); mutation without stale guard RESULT: FAIL 1 of 30; commit c15b491c85160c0521abe3abe4d3eb89d24c4ddd
2026-10-17T10:19:29.745Z | scripts/ground-source-port-witness.mjs | exit=0 | RESULT: PASS checks=19 failed=0 | run=honest | out=.gm/witness-out/witness-gap-GroundSourcePort-honest-20261017T101929745Z.txt | out_sha256=d732a4f6d035e923954d915ca7405ce7ebaacb1274e72b4c42434630b981ae79
2026-10-17T10:20:22.492Z | scripts/ground-source-port-witness.mjs | exit=0 | RESULT: PASS checks=19 failed=0 | run=honest | out=.gm/witness-out/witness-gap-GroundSourcePort-honest-20261017T102022492Z.txt | out_sha256=bbca0de1d7350b4d13d78795363911fbf972bcbeaf064c20cf21abd29a1600f1
2026-10-17T10:20:26.421Z | scripts/ground-source-port-witness.mjs | exit=0 | RESULT: PASS checks=19 failed=0 | run=honest | out=.gm/witness-out/witness-gap-GroundSourcePort-honest-20261017T102026421Z.txt | out_sha256=5752e90ef7f38cfe6c580b17d529b2304f49a95194ba5bba528d17fb3d306319
2026-10-17T10:21:01.552Z | scripts/ground-source-port-witness.mjs | exit=0 | RESULT: PASS checks=19 failed=0 | run=honest | out=.gm/witness-out/witness-gap-GroundSourcePort-honest-20261017T102101552Z.txt | out_sha256=0719ef5de86336141a24918e3cbe40057759d67a026da9bdc3de682eafd4620e
2026-10-17T10:21:06.254Z | scripts/ground-source-port-witness.mjs | exit=0 | RESULT: PASS checks=19 failed=0 | run=honest | out=.gm/witness-out/witness-gap-GroundSourcePort-honest-20261017T102106254Z.txt | out_sha256=45d0807a19669bb445443c5b291a2b1828df958993ecea7d687d46ad17281864
2026-10-17T10:21:24.659Z | scripts/ground-source-port-witness.mjs | exit=0 | RESULT: PASS checks=19 failed=0 | run=honest | out=.gm/witness-out/witness-gap-GroundSourcePort-honest-20261017T102124659Z.txt | out_sha256=3f8224faaa7dba2aa855eeaf57535cbaf54ab3906e0f38e5c01597bfd0b707b9
