---
name: Teammate identity confirmation
description: Product and ownership rules for friend-suggested roster player identities.
---

Treat a teammate suggestion as a request to review a roster player, not an identity binding. The recipient must explicitly accept the suggestion and finish their own authenticated Find flow before their account can be linked to that player.

**Why:** Identity bindings are exclusive and bundle-relative; the requester must not claim a player on another account's behalf.

**How to apply:** Keep sender selection and recipient review separate from the server-owned claim-binding logic. Never create or transfer a binding from the request endpoint.
