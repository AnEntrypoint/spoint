# Skills

AGENTS.md makes reading this file the first step of every task. Read the entry whose
description matches the task, then open the file it names — the file is the contract,
this page only indexes it.

## In this repo

| Skill | File | Read it when |
| --- | --- | --- |
| spoint | [`SKILL.md`](./SKILL.md) | Any task touching `apps/**`, world config, `ctx.*` server API, client `render`/hooks, procedural meshes, or physics setup. This is the engine API reference and ships in the npm package. |

## Installed skills

Installed under `~/.claude/skills/<name>/SKILL.md` (mirrored to `~/.agents/skills/`).

| Skill | Read it when |
| --- | --- |
| gm | Every coding, refactoring, debugging or engineering task. The primary driver, used for the whole task — dispatch it, do not work around it. |
| gm-continue | A gm walk reached phase COMPLETE with `prd_pending_count=0`. Mandatory final handoff; never end a gm chain on prose. |
| wfgy-method | A non-trivial multi-step task, a decision with real alternatives, or drift/self-contradiction noticed mid-task. |
| polaris-protocol | Long-horizon or high-stakes work where premature completion is a risk. Tree root; dispatches the two below. |
| polaris-goal-compiler | Compiling a goal into task atoms, gates and claim ceilings before executing it. |
| fifth-dimension-engine | Executing a compiled problem specification; lifts a target into structured routes. |
| agent-memory | Cross-session team memory (MemoryCore/MemoryHub), or when gm's memorize/recall backend is being pointed at TencentDB. |

## Rules that bind while using any of them

- Commit only as `lanmower`, with an explicit path list.
- Route every capability through its gm verb; never substitute a host-native tool for
  `codesearch`, `browser`, or the git verbs.
- Rationale that code cannot carry goes to `AGENTS.md`, the recall store, or the commit
  message — never a comment beside the line.
