# Constraints -- spoint (standing decision-arbiter, checked every phase)

## Rendering architecture
- Single frame orchestrator: client render/update ordering lives in the RenderGraph (client/core/RenderGraph.js). No new implicitly-ordered steps in animate(); a new pass is a node with declared reads/writes.
- Single writer per resource key; construction-time throw is the enforcement surface. Marker resources express order-only edges.
- window.* globals are read-only debug mirrors, never inter-pass data channels. Inter-pass data rides ctx.res.
- One shared occlusion verdict/policy module. No hand-copied hysteresis/fail-open variants; per-consumer constants live in config objects.
- Every rendering change gates on BOTH: fixed-pose screenshot parity AND p50/p95 frame-time parity (curtain-correct fresh-page protocol -- gate on window.__app.revealedAt).
- Instrumentation/inspection surfaces cost ~zero when off (one branch, no allocation), witnessed not assumed.
- Loud-fail: a broken rendering invariant names itself once, loudly, with node id + remediation hint (watchdogs). Silent wrongness is the enemy this repo's history keeps re-finding.

## Repo shape
- packages/mapspinner + packages/streaming-gltf are the ONLY source of truth post-merge; no vendored copies, no sync bridges, no second checkout edited in anger. Import specifiers stay stable through node_modules links.
- Server announces its identity (checkout root, HEAD sha, resolved package paths) at boot; a served page must be attributable to a checkout in one glance.

## Verification
- Real execution only: exec_js / browser page.evaluate. Single root test.js is the only test-file surface; no *.test.js / *.spec.js / test dirs / assertion frameworks.
- Screenshot is the decisive witness for visual claims; a proxy measurement never closes a visual bug.
- A tuned constant is re-derived after any fix to the system it was tuned against (stopgaps re-earn their keep or are removed).

## Process
- Sequential main-repo execution: no concurrent agents committing to this repo within one session (git-thrash incident 2026-07-06; parallel work isolates in worktrees or waits).
- ASCII only in code/docs -- no decorative glyphs.
- Smaller maintained surface wins: replace bespoke code with native/library only when it nets fewer maintained lines.
- Apps (games) API stays stable or improves; no rendering-infra change may leak complexity into apps/_lib consumers.
