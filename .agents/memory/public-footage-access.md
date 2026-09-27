---
name: Public footage access
description: Shared authorization rules for public recordings, Bunny media, clips, and owner-request footage.
---

Public footage responses must apply field visibility, recording visibility, and exact schedule rules. Owner-request videos are not excluded separately; they are public when they satisfy those same rules. Admin access remains the explicit bypass, and media proxies must authorize the underlying video before forwarding it.

**Why:** The product policy makes owner-request footage public under the normal visibility and schedule rules; an owner marker or request association must not override those rules.

**How to apply:** Extend the shared public-footage context and authorization helpers when adding a new public recording, clip, Bunny, or media-proxy route. Keep hidden-field, recording visibility, and schedule checks consistent; do not reintroduce owner-specific exclusion.