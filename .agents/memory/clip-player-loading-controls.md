---
name: ClipPlayer loading controls
description: Keep loading UI minimal without removing quality access during playback stalls.
---

While ClipPlayer is loading, hide frame-step, crop, speed, and recording controls under an opaque loading screen, but keep close and quality selection accessible. If the stream has one encoded rendition, the quality control should explain that limitation.

**Why:** Selecting a lower rendition may help a user recover from a slow or stalled stream; hiding the quality control behind the loading overlay removes that option.

**How to apply:** Preserve this split when adjusting ClipPlayer loading states: remove unrelated editing UI, but leave available quality controls reachable.