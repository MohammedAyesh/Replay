---
name: Bunny Stream renditions and fallback
description: Bunny encoding prerequisites for manual quality choices and MP4 fallback playback.
---

Configure desired output resolutions and MP4 Fallback in the Bunny Stream library's Encoding settings. A player can only offer quality levels present in that video's HLS manifest. Bunny generates MP4 fallback files only for videos encoded after the setting is enabled; existing videos need retained originals to be re-encoded.

**Why:** UI code cannot add missing Bunny renditions or create an MP4 fallback file. Extra resolutions also increase encoding work and storage.

**How to apply:** Before debugging a missing quality option or fallback, verify the video's master playlist and whether its library settings were enabled before that video was encoded.