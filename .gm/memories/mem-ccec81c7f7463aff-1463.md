---
key: mem-ccec81c7f7463aff-1463
ns: default
created: 1790961049106
updated: 1790961049106
---

gm's git verbs honour explicit .gm pathspecs now and refuse instead of committing the index; the hand-commit workaround in AGENTS.md is retired. Before 2026-10-02: git_add {paths:['.gm/memories/...']} reported the path staged, then git_commit/git_finalize with the same paths returned nothing_to_commit: true (both reporting excluded: ['.gm (everything not tracked-by-design)']) and git_finalize went on to commit whatever else was staged -- which is how 1ed9d4ae came to carry one agent's message over another's 67-file apps/ -> src/stdlib-apps/ move. Fixed in AnEntrypoint/rs-plugkit (6f98e47, 30786b6), crates/plugkit-core/src/wasm_dispatch/verbs.rs: exclusion now follows what git actually tracks, each response lists the paths it really excluded (excluded, excluded_but_dirty) instead of a static label, git_add re-reads git diff --cached and reports what really staged, and git_commit/git_finalize refuse with error_code nothing_to_commit_for_paths / pathspec_matches_nothing naming requested_paths. Witnessed in a scratch repo: git_commit {paths:['.gm/state.md']} commits only that file and leaves an unrelated staged file staged; an untracked .gm/new-untracked.md commits when explicitly requested; git_commit {paths:['nonexistent-path.js']} returns ok:false and stages nothing. Takeaway: pass .gm pathspecs to the verbs directly and read committed/requested_paths off the response rather than trusting the call. AGENTS.md updated, spoint commit 811bee42.
