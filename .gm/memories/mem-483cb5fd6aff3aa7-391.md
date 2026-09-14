---
key: mem-483cb5fd6aff3aa7-391
ns: default
created: 1789393134624
updated: 1789393134624
---

project/lockstep-consensus-majority-sustained-ejection: src/netcode/DesyncDetector._resolve treats the majority checksum as truth, never a fixed host (the host may be the corrupt peer). ConsensusVoter ejects only after consecutiveDesyncsRequired consecutive offender ticks, resets all streaks on any verified tick, never flags localPeerId; each honest peer decides locally, no vote messages.
