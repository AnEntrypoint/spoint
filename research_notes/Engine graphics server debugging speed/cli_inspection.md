# CLI inspection loop for the live game (crawl engine=cdp, console, events, server logs)

Scope: how an agent reads client console, exceptions, network, screenshots and state from the CLI, and how it would correlate with server output. Code-read only; nothing below was executed against the live game unless marked "unverified".

Path roots: `gm` = `/workspace/gm`; `spoint` = `/workspace/spoint`. The crawl host code is in `/workspace/gm/agentplug/crates/agentplug-host/src/`.

## Key corrections to the brief

- `scripts/lib/cdp-browser.mjs` does NOT forward `Runtime.consoleAPICalled` or `Log.entryAdded`. Only `Runtime.exceptionThrown` is turned into a page error (`scripts/lib/cdp-browser.mjs:387-399`, emitted via `_emitPageError` at `:162-165`). The generic dispatcher at `scripts/lib/cdp-browser.mjs:377` (`if (page) page._emit(m.method, m.params)`) already emits every CDP event by method name, so `page.on('Runtime.consoleAPICalled', h)` works today. The only gap is that `Log.enable` is never sent: `_newPage` enables `Runtime` (`:336`), `Page` (`:337`) and lifecycle (`:338`), not `Log`. Console capture from a witness therefore needs one `page.on(...)` plus a `Log.enable` line at `:338`.
- The `[terrain] shared lattice ... terrain key ...` warning is emitted by `spoint/src/terrain/LatticeSurface.js:135` (`console.warn`). The `[spawn-hold]` tag is built in `spoint/src/sdk/Relocation.js:162`.
- The gm stale-bundle state at the time of research: the server serves gm-mcp 0.2.128 while 0.2.129 is installed (the `bundle_stale` note in every codesearch reply). A restart of `node /data/cache/gm/.gm-tools/gm-mcp-server.mjs` is needed before the newer code paths are seen.

## 1. Verb surface (what exists)

- `crawl` with the first body line `engine=cdp` (or no engine line) drives headful Chrome. A `headless` line is refused. Reply fields: `ok, engine, headless, stdout, stderr, exit_code, duration_ms, timed_out, target_id, pages, error` (`/workspace/gm/skills/gm/docs/verbs.md:593-603`). The reply also carries `steps` and `tab` (`crawl.rs:962-979`), which the doc omits.
- `chrome` is the same body as `crawl`, with the engine line optional (`verbs.md:610-614`).
- Body grammar: optional `session=<name>` (or `sessionId=`), then one step per line; `#` lines are comments (`crawl.rs:276-290`). Step table: `verbs.md:623-643`.
- Per-step reply entries go to `pages` (`crawl_cdp.mjs:223-254`); per-step records (`index, action, tab, url_before, url_after, closed`) go to `steps` (`crawl_cdp.mjs:214-222`, `:254`).

## 2. Budgets and the `steps: []` loss

- Helper budget: `CDP_HELPER_BUDGET = 100 s` (`crawl.rs:19`).
- Helper watchdog: `watchdogMs = budget - 10 s` = 90 s (`crawl.rs:1125`). When it fires it writes `out`, which already contains the finished `steps` and `pages` (`crawl_cdp.mjs:180-188`). So a watchdog hit keeps finished steps.
- Hard kill: Rust waits on the child with `wait_timeout(budget)` and kills it (`crawl.rs:899-905`). The helper only prints its JSON at the end (`crawl_cdp.mjs:265`), so a killed helper leaves no parseable line. `run.result` is `None`, and `crawl_reply_from_run` then defaults `steps` and `pages` to `[]` (`crawl.rs:962-964`). This is the `steps: []` the brief describes.
- Mechanism that makes the watchdog fail to write: the watchdog calls `await cleanup()` (`crawl_cdp.mjs:184`). `cleanup` awaits `currentUrl(session)` (`:165-168`), which calls `evaluate` (`:118-124`, `:92-99`). `evaluate` has no deadline. A page with a busy main thread (a JS loop) never answers `Runtime.evaluate`, so the watchdog never reaches `process.stdout.write` and the 100 s kill fires with no output. Cause is a claim until instrumented; the code path is the reading.
- Windows risk (unverified, Node documented behaviour from memory): the watchdog writes then calls `process.exit(1)` (`crawl_cdp.mjs:185-186`). Pipe writes are async on Windows, so `exit` may truncate the JSON line. The repo targets Windows too.

Verb-level budget numbers an agent can rely on:
- Navigation: `pageTimeoutMs = 30000` (`crawl.rs:876`), used by `url=` (`crawl_cdp.mjs:141-143`) and `wait_for`/`wait` polling (`crawl_cdp_tools.mjs:437-445`, `ctx.timeoutMs`).
- `wait=<ms>` max 60000 (`crawl.rs:20`, `MAX_WAIT_MS`).
- Sum of waits + navigation + `wait_for` must stay under 90 s or the watchdog truncates the reply.

## 3. Which steps return empty when they should not

Console (`crawl_cdp_tools.mjs`):
- Capture is armed per call: `attachConsole` runs only when the body contains a `console` step (`crawl_cdp_tools.mjs:631-635`). Messages emitted in an earlier call on the same `session=` are never seen. The tab persists across calls (`crawl_cdp.mjs:194-210`), the listener does not.
- `consoleReport` evaluates `count` eagerly at the step (`crawl_cdp_tools.mjs:483-485`: `count: ctx.consoleMessages.length`) but passes the live array as `messages`. Serialized at the end of the call, `messages` contains everything from the call, while `count` shows only what existed at the `console` line. A `console` line placed before the actions reads `count: 0` with a non-empty `messages` array, or with `messages` cut at that point depending on serialization timing. This is the likely cause of the empty-versus-full difference in the brief (unverified against a live run).
- `Runtime.enable` is awaited without a catch (`crawl_cdp_tools.mjs:633`); `Log.enable` is swallowed (`:634`). A console step that silently lacks `Log` events loses `Log.entryAdded` entries (network errors, deprecations) without any signal.
- Dialogs are pushed into the same list (`crawl_cdp_tools.mjs:608-618`).

Network (`crawl_cdp_tools.mjs:499-501`, `:560-604`):
- `networkReport` maps entries eagerly (`requests: ctx.networkEntries.map(networkSummary)`), so requests that start after the `network` line are missing from the reply. A request in flight has `finished: false` and `body: null` (`:506-515`).
- Requests fired before the call attached are missing (`Network.enable` at attach, `:636-639`).

Events (`crawl_cdp_tools.mjs:111-133`, `:640-653`): armed at attach, so events from earlier steps are kept. `where` compares only fields that exist; a missing field never matches (`:113-114`). Overflow is counted in `dropped` (`:124-127`).

Screenshot: `captureBeyondViewport` only when `full` (`crawl_cdp_tools.mjs:666`). A `uid` clip uses `boxOf`, which fails on an unrendered element (`:210-217`).

## 4. Filter for "[terrain]" or "[spawn-hold]" lines

- There is no filter on `console`. `console` takes no arguments (`crawl.rs:274` grammar, `crawl_cdp_tools.mjs:765`).
- An existing filter does work today: `events` with `where`. Recipe (unverified against the parser for bracket characters):

  ```
  events Runtime.consoleAPICalled where args.0.value~[terrain] limit=200
  ```

  `eventField` walks dotted paths, and array indices are plain property keys, so `args.0.value` resolves (`crawl_cdp_tools.mjs:102-109`). It only matches a string or number first argument. An object first argument has `description`/`preview` instead of `value`, so use `args.0.description` for those. Use `Log.entryAdded where entry.text~[spawn-hold]` for `Log` entries.
- Missing piece for a proper console filter: add `console [where text~<s>] [limit=N]` to the grammar (`crawl.rs:274`, `parse_cdp_crawl_body` `:276`) and to `consoleReport` (`crawl_cdp_tools.mjs:483`), reusing `eventMatches` (`:111`) over `{ text }`.

## 5. Minimum crawl calls for one live-site check

One call is enough when no `uid` is needed (coordinates or `wait_for`). Proposed body (not executed):

```
session=live
url=<game URL>
wait_for=<text the HUD shows when ready>
events Runtime.consoleAPICalled where args.0.value~[terrain] limit=200
events Runtime.exceptionThrown limit=50
click_at=<x>,<y>
wait 3000
screenshot=.gm/shots/live.jpg
console
```

Notes on the body:
- `events` lines must precede the actions only for readability; capture is armed at attach either way (`verbs.md:648-649`).
- `console` last, so `count` is correct (see section 3).
- `.jpg` cuts screenshot bytes (`crawl_cdp_tools.mjs:656-661`); the reply returns a path and byte count, not the image. Read the file with the Read tool.
- `url=` does nothing if the tab is already on that URL (`crawl_cdp.mjs:136-151`); add `reload` to force a fresh load.
- Budget: keep the sum under about 60 s (navigation up to 30 s, `wait_for` up to 30 s, plus waits). The watchdog fires at 90 s.

If a `uid` click is needed: call 1 = `session=live`, `url=`, `snapshot`. Call 2 = `session=live`, `click=<uid>`, `wait 3000`, `screenshot=...`, `console`. uids persist in `.gm/crawl-cdp-sessions/live.json` (`crawl_cdp.mjs:170-171`, `crawl.rs:1030-1034`). Console from call 1 is lost (section 3), so do the console-sensitive phase in a single call.

Calls per check: 1 (no uid), 2 (one uid click), plus one `crawl` per additional phase. Each call is serialized on its session (`verbs.md:620`).

## 6. Server logs and correlation

- No server log file exists. `scripts/dev.mjs:18` forks `server.js` with `stdio: 'inherit'`, so server stdout and stderr go only to the terminal running `npm run dev`. Nothing tees them (grep for `tee`, `createWriteStream`, and `logs/` in `spoint/scripts` and `spoint/src` returns no logging sink; `spoint/src/sdk/UploadHandler.js:49` is the only file write stream).
- Existing sinks: `spoint/.gm/witness-out/*.txt` (per-witness stdout, named `<witness>-<ISO ts>-<pid>-<hash>.txt`; seen in `git status`). These cover witnesses, not the dev server.
- Correlation options today:
  - Client-side: include `tick` and `serverTime` in any client log line. Those fields are in the wire record (`msgpack.js` `WIRE_STRUCTURES[1]`, listed in `spoint/AGENTS.md`), so a client console line can carry the server tick it rendered.
  - Wall-clock window: the crawl reply has `duration_ms` (`crawl.rs:973`) but no start timestamp. Adding `started_ms` to `crawl_reply_from_run` (`crawl.rs:966-980`) gives an agent a window to slice a server log.

## 7. Proposed changes, each with verb/file, cost, risk

1. `crawl.rs:966-980` (`crawl_reply_from_run`): drop the `stdout` duplicate when `ok` is true. Cost: the reply repeats the entire JSON (`stdout` field `:970` plus `pages`/`steps`), roughly doubling tokens on every crawl. Risk: a caller that reads `stdout` breaks; grep callers first.
2. `crawl_cdp.mjs:254` and `:265`: write the partial `out` to a file (`GM_CRAWL_CONFIG.partialFile`) after each step; `crawl.rs:909-913` reads that file when `run.result` is `None`. Fixes `steps: []` on the 100 s kill. Cost: one small file write per step. Risk: stale file if the name is reused; key it by `session` or a crawl id.
3. `crawl_cdp.mjs:168`: give `currentUrl` in `cleanup` a deadline (use `withDeadline`, defined in `crawl_cdp_tools.mjs:74`). Stops the watchdog deadlock in section 2. Risk: a shorter cleanup could skip the session save if the deadline is hit; log it into `out.error`.
4. `crawl_cdp.mjs:185-186`: set `process.exitCode` and let the event loop drain instead of `process.exit(1)`. Removes the Windows truncation risk (unverified). Risk: a stuck handle could keep the helper alive; the Rust side kills it at 100 s anyway.
5. `crawl_cdp_tools.mjs:483-485` (`consoleReport`): compute `count` from the final array (or return a getter). Makes `count` agree with `messages`. Cost: none. Risk: none.
6. `crawl.rs:274` + `crawl_cdp_tools.mjs:483`: add `console [where text~<s>] [limit=N]` reusing `eventMatches` (`:111`). This gives the `[terrain]` filter as a first-class verb. Cost: parser change plus one function. Risk: `text` with spaces needs quoting rules in the parser.
7. `verbs.md:635` and `:643`: document the `events Runtime.consoleAPICalled where args.0.value~[terrain]` recipe and the `args.0.description` fallback. Zero code cost, immediate win. Risk: the recipe is unverified against the `where` parser (section 4).
8. `verbs.md:593-603` vs `crawl.rs:962-979`: the doc omits `steps` and `tab` from the reply; add both. Also `press_uid` is in the grammar (`crawl.rs:274`) but not in the step table (`verbs.md:631`); `wait <ms>` (`crawl.rs:274`) and `wait=<ms>` (`verbs.md:640`) are both accepted but documented differently.
9. `crawl.rs:966-980`: add `started_ms` to the reply so an agent can window a server log.
10. `scripts/dev.mjs:18`: change `stdio: 'inherit'` to pipes and tee each line to `spoint/.gm/logs/server-<ISO ts>.log` (and keep the terminal copy). Gives a server log file per dev session. Cost: an extra write per server line. Risk: ANSI codes and buffering; flush on exit. Only the dev path (`SPOINT_DEV=1`) should tee, to keep production runs untouched.
11. `scripts/lib/cdp-browser.mjs:336-338`: add `await this._send('Log.enable', {}, sessionId).catch(() => {})` in `_newPage`. Then witnesses can use `page.on('Runtime.consoleAPICalled', ...)` and `page.on('Log.entryAdded', ...)` with no dispatcher change (`:377` already emits by method). Cost: one more CDP domain per page. Risk: low; `.catch` already used in the same block.
12. `crawl_cdp_tools.mjs:659`-style: no change; the screenshot path already supports `.jpg` (`:656-661`). Recommend `.jpg` in the default recipe to cut image tokens.
13. Stale gm bundle (0.2.128 served, 0.2.129 installed): restart the gm-mcp process. Until then, codesearch and crawl results come from the older build.

## 8. Known gaps in this research

- Nothing was run against the live game. Empty-console causes in section 3 are code-read; the `count`/`messages` mismatch and the `steps: []` mechanism need one instrumented run each.
- The `args.0.value~[terrain]` `where` recipe is unverified against the `where` parser for bracket characters.
- gm codesearch phrase queries need `combine` or single terms; a phrase with spaces returned zero matches (`pattern: Browser steps for engine=cdp`), so the zeros from that query are not findings. Listings in `gm` were incomplete (`listing_incomplete: true`), so several zeros were not exhaustive. Searches that returned results were run against `path`-scoped corpora.
