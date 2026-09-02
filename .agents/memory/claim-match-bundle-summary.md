---
name: Claim Match bundle summaries
description: Keep server-side claim calculations independent from repeated object-storage segment reads.
---

New tracking bundles should persist a compact summary containing segment ranges, track frame bounds, and events. This is sufficient for coverage, completion, stats, and earned-moment derivation without loading box-heavy segment files.

**Why:** Progress and answer requests can be frequent; repeatedly parsing every object-storage segment adds avoidable latency and storage load.

**How to apply:** Preserve a compatibility fallback for older manifests without summaries, and prefer the summary for all user-facing Claim Match state calculations.