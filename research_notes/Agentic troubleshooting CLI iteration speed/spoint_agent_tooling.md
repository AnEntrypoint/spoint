# Agent tooling of spoint: iteration speed and debuggability from the CLI

Measured on 2026-10-18. Sources: `/workspace/spoint/.gm/exec-spool/.watcher.log` (947 `dispatch.end` events, `ms` field), `/workspace/spoint/.gm/exec-spool/.dispatch-ledger.json` (500 rows), `/workspace/spoint/.gm/exec-spool/.status.json`, and the code paths below. `out/*.json` is almost empty now (6 files), so durations come from the watcher log, not out/. The ledger has no `duration_ms` field (0 of 500 rows), so the watcher is the only duration source.

## Key question 1: slowest verbs and why

Per-verb `dispatch.end` wall time (ms), from `.watcher.log`:

| verb | n | p50 | p90 | max | cause |
|---|---|---|---|---|---|
| sleep | 39 | 15003 | 15005 | 15017 | fixed 15 s sleep verb, by design |
| crawl | 8 | 70871 | 90702 | 90702 | browser helper, see Q2 |
| git_push | 31 | 4008 | 6816 | 139703 | serial git lane (git verbs are fifo per lane, `.status.json` `tool_serialization`) |
| phase-status | 113 | 14 | 268 | 138719 | max 138.7 s, one outlier; p50 14 ms |
| git_pull | 7 | 2220 | 39471 | 39471 | serial git lane |
| codeinsight | 58 | 298 | 1184 | 45169 | index rebuild |
| ci-status | 32 | 2932 | 4117 | 9316 | gh API round trip |
| ci-log | 15 | 1986 | 3973 | 6273 | gh API round trip |
| exec_js | 107 | 717 | 1303 | 15007 | node child |
| codesearch | 127 | 403 | 7560 | 16657 | p90 spikes from the per-chunk embedding cap |
| prd-list | 65 | 28 | 35 | 98 | cheap, but 21 dispatches across 14 sessions in the ledger |

Why the tails exist:
- Queueing. `.status.json` (read at 2026-10-18 14:40): `queue_wait_ms` 559, `runner_update_in_progress` true, `runner_update_waiting_ms` 99631. A runner update alone held a dispatch for about 100 s. The fifo rule is `tool_serialization` in the same file: state-changing verbs and git share one fifo per plugin and verb.
- Embedding budget. `.watcher.log` holds 1178 `code_index_chunk_cap` events, each with `pessimistic_ms_per_chunk: 16000` and `remaining_ms` as low as 2693. A codesearch that needs an embedding waits on this budget, which explains the codesearch p90 of 7560 ms.
- Stale gm-mcp. The codesearch reply in this session reported `gm-mcp: this server is serving bundle 0.2.128 ... 0.2.129 is installed ... restart required`. The MCP server keeps the old bundle until relaunched (`/data/cache/gm/.gm-tools/gm-mcp-server.mjs`). Every verb measured here ran on the older bundle.
- Sleep is a fixed poll. The 39 `sleep` dispatches each take 15.0 s. Any agent that uses `sleep` to wait adds a fixed 15 s granularity, so a 2 s wait costs 15 s.

Repeated work (same verb, same fingerprint, from the ledger): `phase-status|14ece1c08a6acb0a` 6 times, `phase-status|88327cefd6245cf8` 4 times, `phase-status|cb84bf7da81fbf8b` 3 times, `git_status|65231267994449da` 3 times, `prd-list|11248cd099049165` 2 times. `phase-status` is 113 dispatches at p50 14 ms, so the cost is in the tail (138.7 s max), not in the average.

## Key question 2: crawl budget and a call sequence

Recorded crawl dispatches (ledger ts, exit_code, output_bytes, session):
- 12:11:04 exit 1, 0 bytes (watcher: 23 ms, failed fast)
- 12:12:38 exit 1, 842 bytes
- 12:13:50 exit 0, 29596 bytes, no session
- 12:26:19 exit 0, 27796 bytes, session
- 12:27:44 exit 0, 29965 bytes
- 12:29:05 exit 0, 2054 bytes
- 12:30:22 exit 0, 27775 bytes, session
- 12:31:32 exit 0, 27230 bytes, session

Watcher durations for these 8 calls: 23, 65415, 65639, 65806, 70871, 75432, 79267, 90702 ms. One call (90702 ms) reached the 90 s figure. 1 of 8 calls was at the budget and 2 of 8 exited 1.

Where the budget actually lives (I could not find a literal 90 s constant):
- `/workspace/gm/agentplug/crates/agentplug-host/src/crawl.rs:19` `CDP_HELPER_BUDGET = Duration::from_secs(100)`, used at `crawl.rs:1011` in `crawl_cdp` (`crawl.rs:983`). The helper is killed at this budget by `run_helper_with` (`crawl.rs:864`, wait_timeout at `:899`), which logs `crawl helper exceeded its time budget and was killed` (`crawl.rs:951`).
- `crawl.rs:17` `CDP_READY_DEADLINE` = 30 s, the CDP endpoint wait.
- The 90 s observed value is consistent with the 100 s helper budget plus the poll margin, but the observed max is 90702 ms, so the cap the user quoted (90 s) is not a constant in this code path. Treat the 90 s figure as observed, not as a named limit (gap).

Timeout loses the partial steps. `crawl.rs:945` sets `result = run.result.clone().unwrap_or(Null)`, and `crawl.rs:964` takes `steps` from it. On a kill, `steps` is `[]` and only `error` says "exceeded its time budget". Steps that finished before the kill are not returned. (Whether `run.result` is ever populated after a kill was not verified.)

Recommended split. Observed p50 for a crawl call is 71 s, so a body must finish in well under 60 s to leave margin.
- Keep one body to one navigation plus a few steps. Use `session=<name>` so the tab and `uid=N` numbers carry across calls (`verbs.md:620`, state in `.gm/crawl-cdp-sessions/<name>.json`).
- Put `wait_for=<text>` before any `wait=` (a fixed `wait=` burns budget; `wait=` max is 60000 per `verbs.md:640`).
- Minimum calls for a full load, click, capture: 1 if load + click + `console` + `screenshot` fit in about 60 s. Otherwise 2 calls:
  1. `session=run1`, `url=<url>`, `wait_for=<ready text>`, `snapshot`, `console`
  2. `session=run1`, `click=<uid>` (uids from call 1 snapshot), `wait_for=<result text>`, `console`, `screenshot=<path>`
  A third call is only needed when the click starts a slow load, which should be split at that point.
- Put `console` in every call: see Q4.

## Key question 3: the browser lease and the second agent's wait

Two lease implementations exist.
- spoint side: `/workspace/spoint/scripts/lib/browser-lease.mjs`. Constants: `HEARTBEAT_MS = 2000` (line 6), `DEFAULT_TTL_MS = 120000` (line 7), `DEFAULT_WAIT_MS = 600000` (line 8), `POLL_MS = 500` (line 9), `TICKET_MAX_AGE_MS = 3600000` (line 12). A second agent polls every 500 ms for up to 600 s. Waiters are FIFO tickets in `${dir}-waiters` (`addTicket`, `oldestLiveTicket`, around lines 213-240). `cdp-browser.mjs:6` imports `acquire as acquireLease`, and `cdp-browser.mjs:482-488` calls it with `waitMs: opts.leaseWaitMs`, `ttlMs: opts.leaseTtlMs`.
- gm side: `crawl.rs:991` `crawl_lease::acquire(cwd, &agent, parsed.headful)`; the lease dir is `root/.gm/crawl-cdp-profile` (`/workspace/gm/.gitignore:178`). Its wait constants were not read.

Recorded state now:
- `/workspace/spoint/.gm/browser-lease/session/`: `owner.json` is absent (no holder), and there is no `-waiters` directory (no queue). The `profile/` directory is present (last written 14:41), so a browser ran and released.
- `/workspace/spoint/.gm/crawl-cdp-sessions/`: four sessions (`live-play`, `live-play2..4`), all with `nextUid: 0` and `uids: {}`. The tab ids were written at 14:13 to 14:31 and not reused.

Measured second-agent wait: not recorded. `.watcher.log` has no lease-wait event. The 12 watcher lines that mention "lease" are `code_index_chunk_cap` and `deferred_set` entries that name `browser-lease-single-session-witness.mjs` as a path. So the wait is only the 500 ms poll plus queue position, and no run logs it. A cheap fix is to log `waited_ms` and `ticket_position` when `acquire` returns (`browser-lease.mjs`, `claim`), so the wait can be measured next time.

## Key question 4: what is missing when a browser test fails

- `console` step returns nothing silently. In `crawl_cdp_tools.mjs`, `consoleMessages` starts empty per helper run (`:92`), and `consoleReport` (`:483-485`) returns `{op:'console', count:0, messages:[]}` with no marker when nothing was captured.
- Console capture is attached only when the same call has a console op: `crawl_cdp_tools.mjs:631-635` (`attachConsole` only if `steps.some(CONSOLE_OPS)`). Messages from earlier steps or earlier calls are never captured. A `console` placed at the end of a call only sees messages after the helper started, and `session=` keeps the tab but not the console buffer (`:92` is per helper run, so a new call starts empty).
- The field that is empty on failure is `steps`. `crawl.rs:1002` sets `steps: []` on an expectation failure, and `crawl.rs:977` returns `steps: []` on timeout (see Q2).
- Dialogs are recorded (`crawl_cdp_tools.mjs:608-617`) only while the helper is attached, with `handled` set to accept or dismiss.
- Suggested change: in `consoleReport`, return `captured_from: <helper start ts>` and `capture_attached: true|false`, and in `crawl.rs` keep `steps` completed before a kill (write the partial steps array to `result_file` or `stdout` before `wait_timeout` expires).

Also a witness-side gap (spoint): `scripts/lib/cdp-browser.mjs` has no `console` string at all (codesearch of `console` in that file: 0 hits, `exhaustive: true`). The spoint CDP launcher does not capture console itself; it depends entirely on the gm crawl step.

## Key question 5: repeated operations worth caching

- `phase-status` (6, 4, 3 repeats of one fingerprint, see Q1). Cache key: `verb + args-hash + git HEAD sha + prd.yml mtime`. The reply does not change until HEAD or the PRD changes, so the cached reply is safe while both are equal.
- `git_status` (3 repeats). Key: `HEAD sha + worktree stat digest`.
- `prd-list` (21 dispatches, 14 sessions). Key: `.gm/prd.yml` content hash. Note the concurrent-lane lost update in AGENTS.md (PRD rows) means the cache must re-read on a write.
- `ci-status` and `ci-log` (32 and 15 dispatches, gh API). Key: commit sha. A finished CI run is immutable, so cache it by sha forever; only a pending run needs a re-query. AGENTS.md states `ci-status` ignores `rev` (`AGENTS.md`, CI section), so the cache key must be the sha passed to `gh api .../commits/<sha>/check-runs`.
- AGENTS.md re-reads: not measured (no read verb shows up in the ledger for it), so the cost is unknown. The file is injected via CLAUDE.md and re-read by each subagent.
- `describe` (`gm.describe(name)` per verb): not in the ledger at all, so its cost is zero in this record. A per-run memo keyed by verb name is still cheap to add.

## Changes proposed (file or verb, observed cost, risk)

1. `browser-lease.mjs` `acquire`: log `waited_ms` and queue position. Observed cost: second-agent wait is not recorded at all. Risk: none, log only.
2. `crawl_cdp_tools.mjs` `consoleReport` (`:483`) and `attachCapture` (`:631`): attach console capture for every call, not only calls with a console op, and return `capture_attached`. Observed cost: an empty `messages: []` cannot be told from "no messages". Risk: low; adds a `Runtime.enable` on every call (small CDP cost).
3. `crawl.rs` `crawl_reply_from_run` (`:939-981`): keep steps completed before the budget kill. Observed cost: 1 of 8 recorded crawls hit the budget and returned `steps: []`. Risk: parsing partial output; write steps as they complete.
4. `crawl.rs:19` `CDP_HELPER_BUDGET` (100 s): expose per call through the body (for example `budget=<s>`), so a slow body can be split without guessing. Observed cost: the 90 s figure is observed, not a named constant. Risk: a larger budget holds the lease longer (`browser-lease.mjs` TTL 120 s).
5. `sleep` verb: replace fixed 15 s with `wait_ms` in the body. Observed cost: 39 calls at 15.0 s each. Risk: none.
6. `.status.json` runner update: a runner update held a dispatch for 99.6 s (`runner_update_waiting_ms`). Observed cost: one ~100 s stall. Risk: moving updates to idle time only.
7. `gm-mcp` relaunch: the MCP serves 0.2.128 while 0.2.129 is installed. Observed cost: every verb in this run is on the older bundle. Risk: a relaunch drops the client, so do it between walks.
8. `codesearch` literal mode: a multi-word `query` matches verbatim and returns zero, and a zero over a partial scan reads as a finding unless `complete` is checked. Observed: `query:"crawl budget 90"` returned 0 with `hint: no line matched as ONE phrase`. Change: auto-split on spaces when `combine` is unset, or report `unproven_zero` in the first line of the reply.
9. Cache the verbs listed in Q5 by the keys given there. Observed: 13 `phase-status` dispatches and 3 `git_status` dispatches reuse an already-seen fingerprint in the ledger. Risk: staleness, so key on HEAD sha and file mtime.

## Gaps

- The 90 s crawl figure is not a named constant in the code I read (`crawl.rs:19` is 100 s). Source of the 90 s cap not found.
- `run.result` after a budget kill was not verified, so Q2's "steps lost" claim is from the code path, not from a recorded failing reply.
- `out/*.json` is nearly empty (6 files) so the watcher log is the only duration source. The ledger has no `duration_ms`.
- Lease wait time was not recorded by any run.
- The gm-side lease constants in `crawl_lease.rs` were not read.
