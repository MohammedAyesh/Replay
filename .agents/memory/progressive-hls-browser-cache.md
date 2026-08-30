---
name: Progressive HLS browser cache
description: Service-worker lifecycle and failure-isolation rules for progressive playback caching.
---

Allow cache reads whenever a matching persisted HLS resource exists, but authorize new cache writes only for the client and stream that has actually begun playback.

**Why:** Service workers can be terminated between page loads, so in-memory write-enable state cannot gate offline reads. A global write flag also lets one tab affect another. Cache Storage errors must not reject a request that the network could still satisfy.

**How to apply:** Keep stream namespaces independent, scope post-Play write permission by client and stream, require an active controller before enabling writes, and wrap all Cache API operations with a direct network fallback.