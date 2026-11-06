---
name: Instagram-only login scope
description: How Instagram Unified Login coexists with existing Facebook Page connections.
---

Use Instagram Unified Login only when an academy has no Facebook Page connection. Do not replace an active Page-backed social record or its token fields with an Instagram-only token.

**Why:** The academy currently has one social-account record. Replacing its Page ID or Page token would silently break Facebook publishing and Page subscriptions.

**How to apply:** Before starting or completing Instagram-only login, check for an active Page connection. Keep the existing Facebook Login path unchanged; only use the Instagram token for a Page-less account.
