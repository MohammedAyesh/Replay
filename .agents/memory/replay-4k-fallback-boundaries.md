---
name: Replay 4K fallback boundaries
description: Product and privacy boundaries for original 4K playback.
---

Original Storage playback is for recorded-match viewing, admin previews, and owner-share watch pages. Use the supported camera-original 4K source for exports and renders that require 3840×1080 geometry; do not send 8K into those consumers unless they explicitly support it. Keep live and Find Yourself behavior unchanged.

Recorded playback prefers smooth Storage 8K, then Storage 4K, H.264, and Bunny Stream only for Stream-backed sources.

**Why:** Storage-only recordings have no Stream asset, while existing export geometry assumes 4K. Owner-shared footage can remain private even though it is publicly accessible through a share link.

**How to apply:** Keep recorded-match and owner-share players on the same rendition order. Keep storage-only IDs out of Stream API calls, preserve live and Find Yourself behavior, and use token-gated proxy routes for owner-share media.
