---
name: Public footage access
description: Shared authorization rules for public recordings, Bunny media, clips, and owner-request footage.
---

Public footage responses must apply the same field visibility, recording visibility, exact schedule, and owner-request exclusion rules. Admin access is the explicit bypass; media proxies must authorize the underlying video before forwarding it.

**Why:** Individual route filters drifted and allowed hidden, unscheduled, or owner-request footage to appear through alternate listings and direct media-proxy URLs.

**How to apply:** Extend the shared public-footage context and authorization helpers when adding a new public recording, clip, Bunny, or media-proxy route; do not reimplement a route-specific subset.