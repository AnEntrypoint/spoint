# Remaining plans (PRD)

Each row: id, what it asserts, what closes it, what witnesses it. Status as of main 8d442bf.

## plan-typings-ci-drift
- **Asserts:** main CI `check` fails with "generated SDK typings drift". The regenerated `client/editor/sdk-typings.generated.d.ts` (digest 2701ae60) is not committed, because `src/apps/AppContext.js` and `src/apps/AppRuntime.js` carry other lanes' uncommitted edits, and the digest would encode unpushed state.
- **Closes when:** those files are committed; then `node scripts/gen-sdk-typings.mjs` runs on a clean tree, the typings are committed by explicit path, and `check` is green on the new sha.
- **Witness:** `ci-status` on that sha: check success.

## plan-dirty-apprntime-syntax
- **Asserts:** the local, uncommitted `src/apps/AppRuntime.js` (another lane's edit) fails to parse near line 495, which blocks witnesses run from the working tree.
- **Closes when:** the owning lane commits or reverts that edit. Not ours to edit.
- **Witness:** `node --check src/apps/AppRuntime.js` exits 0 on the committed tree.

## plan-verify-same-session-resolved
- **Asserts:** `TOTALITY-w1-p-1-2` and `SPECDRIFT-ag-88-1` were resolved with a witness run by the executing session. The verifier rule requires a separate session.
- **Closes when:** a verifier in a different session re-runs each witness and the ledger binds it.
- **Witness:** ledger entry with a verifier-bound dispatch id for both rows.

## plan-verify-handoff-rows
- **Asserts:** these pushed executor edits await separate verification:
  - `WADLER-ub1-s2-1` (a18ab1d)
  - `WADLER-relocation-probegroundy-m2-s1` (114cd83)
  - `PARSEDV-n-r248-2` (c659bfd)
  - `PARSEDV-n-r248-3` (a4159db)
  - `PARSEDV-n-r216-4` (2820618; the named refusal for an unknown emote is still open)
  - `WADLER-ub1-s2-2` (ce65f83; no bindable witness, `scripts/QuestSystem-witness.mjs` is absent)
  - `WADLER-ub1-s2-4` (the owed QuestSystem/AbilityTree change is not in the tree)
- **Closes when:** each has a verifier witness and green CI on its sha, or is re-scoped to what exists.

## plan-owner-decisions
- **Asserts:** these blocked rows need an owner decision:
  - `PARNAS-ringbranch-ub2-p1`: the gm MCP was bound to the wrong project.
  - `PARSEDV-ub1-s2-3`: `scripts/EventChainManager-witness.mjs` is missing, though the defect is live in StatsSystem, EventChainManager and ProgressionSystem.
  - `PARSEDV-0-sub1-2`: the cited `worldSeedOf` is gone. Close as obsolete, or re-scope.
  - `PARSEDV-n-r248-4`: a branded proven-world type across 7 callers, or narrow to the terrain double-check.
  - `WADLER-n-r249sub1-2`: the `AppContext.js` hunk belongs to a sibling lane.
  - `WADLER-n-r249sub1-1`: the AppContext and hydrate producers are still open.
- **Closes when:** each is closed as obsolete, re-scoped with a witness, or resolved by the chosen option.

## plan-sdk-generator-blocker
- **Asserts:** `WADLER-ub1-w1-3` and `WADLER-ub1-s2-3` need a generator change. `client/editor/sdk-typings.generated.d.ts` comes from `scripts/gen-sdk-typings.mjs` over `src/apps/AppContext.js`, which has no JSDoc, so the `(v: any)` sinks come from the generator.
- **Closes when:** JSDoc or the generator is changed, and the typings are regenerated.
- **Witness:** regenerated typings carry the sink parameter types; check green.

## plan-snapshot-pin-after-commit
- **Asserts:** the committed `origin/main` produces `SNAPSHOT_ENCODE_CODE_VERSION` 81635ead29de, which matches `src/shared/cacheCodeVersions.js`. The local mismatch comes only from the dirty `AppRuntime.js`.
- **Closes when:** that lane commits, and a clean tree passes `check-cache-keys`.
- **Witness:** `node scripts/check-cache-keys.mjs` exits 0 on the clean tree.

## plan-multiplayer-live-verify
- **Asserts:** the Pages build serves the game, but `?room=` host and `?wwjoin&room=` join were only checked over HTTP. Joining needs two real browsers and the public nostr relays.
- **Closes when:** two browser sessions join one room on the live site and exchange a state update.
- **Witness:** a captured CDP run of the joined room on the live URL.

## plan-undici-audit
- **Asserts:** Node 24.21's undici asserts `!this.paused` in `Parser.finish` when a socket ends mid-response. The capture-server probe moved to `node:http`. Other `fetch` callers in the server path may hit the same assertion.
- **Closes when:** each server-path `fetch` is `node:http`, or shown not to hit it.
- **Witness:** CI witnesses pass after the audit commit.

## plan-gm-routing
- **Asserts:** gm lanes saw the gm MCP bound to `/workspace/gmweb` and `/workspace/oscraft`, not spoint. PRD and codeinsight calls answered from other projects. Reported in AnEntrypoint/gm issue #3.
- **Closes when:** calls with cwd `/workspace/spoint` hit spoint's store, or are refused loudly.

## plan-gm-git-friction
- **Asserts:** `git_commit` rejects subjects over 50 characters and body lines over 72 (50% of observed runs). The combined commit and push call returns no push result. The commit author email drifts between the noreply address and `almagestfraternite@gmail.com`. Reported in gm issue #3.
- **Closes when:** the limits are documented, the push result is returned, and one author identity is configured.

## plan-dream-rsi-walk
- **Asserts:** graph walk evidence is zero: 0 of 130 principle nodes walked, 136 backreference edges unfired. The hop pipeline depends on the gm daemon. Observations lack error classes, so Part A cannot tell real errors from no-match results.
- **Closes when:** a lean-walk record exists per walked node, and observation records carry an error class.

## plan-agents-md-facts
- **Asserts:** `AGENTS.md` was compacted to 29851 bytes (commit 31b90c2). Its path claims were checked by hand, and `scripts/agents-md-facts-witness.mjs` has not run on a clean tree since.
- **Closes when:** the witness exits 0 with `RESULT: PASS` on main.

## plan-open-backlog
- **Asserts:** about 40 PRD rows remain pending after wave 2. Most need a verifier from another session, which the single-orchestrator setup does not provide yet.
- **Closes when:** each is resolved, blocked with a named blocker, or retired.
