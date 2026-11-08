export function originInfoLine({ originMain, remoteLive, aheadOfOrigin }) {
  return `origin/main (informational, not authority): tracking ${originMain ?? 'none'}, live ${remoteLive ?? 'unreachable'}; local HEAD ahead by ${aheadOfOrigin ?? 'n/a'}`;
}

export function pushedLine({ localSha, remoteLive }) {
  if (!remoteLive) return 'pushed: UNDECIDED (ls-remote unreachable; only ls-remote decides pushed)';
  return remoteLive.startsWith(localSha) ? 'pushed: YES (ls-remote)' : 'pushed: NO (ls-remote)';
}
