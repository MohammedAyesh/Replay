---
name: HLS cache generations
description: Prevent stale service-worker HLS responses from surviving media proxy fixes.
---

When the HLS proxy or its response contract changes, invalidate the browser cache generation instead of trusting existing cached manifests or segments. A response that was previously returned with HTTP success but contained an error body can remain playable-looking to the cache layer while preventing the browser from decoding any frames.

**Why:** A Claim Match screen showed valid tracking overlays and successful HLS requests but only black video while a large pre-existing segment cache was active. The exact Bunny source and fresh proxy bytes decoded correctly outside the browser.

**How to apply:** Change the service-worker cache namespace for response-contract changes and retire the previous namespace during activation, with cleanup treated as best effort so storage failures still fall back to network playback.