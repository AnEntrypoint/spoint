# Compiled FSM gate predicates

Reference for `gates.predicate` in .gm/instructions/fsm/graph.json's `gates` array -- generated from the SAME registry transitions.rs's predicate_result() dispatches on, so this can never silently drift out of sync with what actually exists. A predicate name here is the ONLY thing a graph's gates array can reference directly; a genuinely new condition needs a jit hook instead (see hooks/example.js) or a Rust change to add a new compiled predicate.

- `residual-scan-fired` -- true once `residual-scan` has been dispatched in this stop window (the .gm/residual-check-fired marker is present AND non-empty -- it is invalidated by truncation)
- `prd-all-closed` -- true when .gm/prd.yml has zero rows with an open status (pending/in-progress, not completed)
- `mutables-all-resolved` -- true when .gm/mutables.yml has zero rows still in unknown/pending status
- `worktree-clean` -- true when `git status --porcelain` is empty -- no uncommitted/unpushed delta
- `ci-validated-fresh` -- true when .gm/exec-spool/.ci-validated exists and its head_sha matches the current `git rev-parse HEAD` -- a witnessed-green CI run for the exact pushed commit
- `browser-witness-coverage` -- true when every client-side file edited this session (per .gm/exec-spool/.turn-browser-edits.json) has a matching entry in .gm/exec-spool/.turn-browser-witnessed with the same content hash
- `claim-audit-clean` -- true when the claim audit finds no unwitnessed completion claims -- see orchestrator::claim_audit
- `submodules-clean` -- true when no submodule has drifted from its recorded commit -- see orchestrator::submodule_drift
- `no-synthetic-test-files` -- true when the working diff introduces no standing test file (*.test.*, *.spec.*, or a test/tests/__tests__ directory). VERIFY doctrine forbids them: verification is a live exec_js/browser witness against real code, never a suite asserting against mocks. Emits deviation.synthetic-test-file naming the offending paths when it fails.
- `remote-hook-refused` -- always false. Substituted by fsm::graph() for a gate whose ONLY condition was a hook supplied by a non-local tier: hooks execute only from the project-vendored graph, so the author's condition is genuinely not being evaluated and the edge it guards must not be waved through. Vendor the graph (and its hook) locally to restore the gate.